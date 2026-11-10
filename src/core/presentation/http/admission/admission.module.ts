import {
  Inject,
  Injectable,
  Module,
  RequestMethod,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type MiddlewareConsumer,
  type ModuleMetadata,
  type NestModule,
  type InjectionToken,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  AdmissionConfigError,
  requireInteger,
  validateAdmissionLimits,
  validateFailurePolicy,
  validateLocalFallbackRatio,
  validateRateLimitPolicy,
  type AdmissionLimitsInput,
  type RateLimitFailurePolicy,
  type RateLimitPolicy,
} from '../../../application/admission/admission.config';
import { AdmissionGate } from '../../../application/admission/admission.gate';
import {
  LocalRateLimiter,
  ResilientRateLimiter,
  type RateLimiter,
} from '../../../application/admission/rate-limit';
import type { ReadinessCheck } from '../../../application/admission/readiness';
import { createNoopOperationSignals } from '../../../application/observability/operation-signals';
import type { OperationSignals } from '../../../application/observability/signal-contracts';
import { AdmissionService } from './admission.service';
import { AdmissionMiddleware } from './admission.middleware';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import { HealthController } from '../../health/health.controller';
import { ADMISSION_SIGNAL, recordSignal } from './admission.signals';
import {
  ADMISSION_CHECKS,
  ADMISSION_RATE_STORE,
  ADMISSION_SERVICE,
  ADMISSION_SIGNALS_PORT,
} from './admission.tokens';

export const DEFAULT_EXEMPT_PATHS: readonly string[] = [
  '/health/live',
  '/health/ready',
];

export interface AdmissionRateLimitRegistration {
  /** Token do `RateLimiter` compartilhado (ex.: `SHARED_RATE_LIMITER` de `native/cache-redis`). */
  readonly store: InjectionToken;
  readonly policy: RateLimitPolicy;
  /** Padrão: `fallback-local`. */
  readonly failurePolicy?: RateLimitFailurePolicy;
  /** Fração do limite no fallback local, em (0, 1]. Padrão: 0.5. */
  readonly localFallbackRatio?: number;
  /** Chaves mantidas pelo fallback local (LRU). Padrão: 10000. */
  readonly localMaxKeys?: number;
  /** Tempo máximo de uma consulta ao armazenamento compartilhado. Padrão: 200. */
  readonly sharedTimeoutMs?: number;
  /** Segredo do digest do IP (mínimo 16 caracteres). O IP bruto nunca é guardado. */
  readonly keyDigestSecret: string;
}

export interface AdmissionRegistration {
  readonly imports?: ModuleMetadata['imports'];
  readonly admission: AdmissionLimitsInput;
  readonly exemptPaths?: readonly string[];
  readonly readiness?: {
    /** Dependências obrigatórias: tokens de `ReadinessCheck`. */
    readonly checks?: readonly InjectionToken[];
    /** Padrão: 1000 ms. */
    readonly timeoutMs?: number;
  };
  readonly rateLimit?: AdmissionRateLimitRegistration;
  /** Token de `OperationSignals`. Sem ele, os sinais são no-op. */
  readonly signals?: InjectionToken;
}

const DEFAULT_READINESS_TIMEOUT_MS = 1_000;
const DEFAULT_LOCAL_FALLBACK_RATIO = 0.5;
const DEFAULT_LOCAL_MAX_KEYS = 10_000;
const DEFAULT_SHARED_TIMEOUT_MS = 200;
const MIN_DIGEST_SECRET_LENGTH = 16;

function validateExemptPaths(paths: readonly string[]): string[] {
  if (paths === null || typeof paths !== 'object' || paths.length > 16)
    throw new AdmissionConfigError('exemptPaths');
  const accepted: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > 128 ||
      accepted.includes(path)
    )
      throw new AdmissionConfigError(`exemptPaths[${index}]`);
    accepted.push(path);
  }
  return accepted;
}

function requireReadinessCheck(value: unknown, index: number): ReadinessCheck {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as ReadinessCheck).check !== 'function'
  )
    throw new AdmissionConfigError(`readiness.checks[${index}]`);
  return value as ReadinessCheck;
}

function requireRateLimiter(value: unknown): RateLimiter {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as RateLimiter).consume !== 'function'
  )
    throw new AdmissionConfigError('rateLimit.store');
  return value as RateLimiter;
}

/**
 * Admissão por processo, rate limit compartilhado, prontidão e drenagem. Opt-in:
 * `AdmissionModule.register` (ou `FoundationCoreModule.withAdmission`) é a única forma
 * de ativar qualquer parte deste módulo.
 */
@Injectable()
export class AdmissionDrainHook implements BeforeApplicationShutdown {
  constructor(
    @Inject(ADMISSION_SERVICE) private readonly admission: AdmissionService,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    await this.admission.drainOnShutdown();
  }
}

@Module({})
export class AdmissionModule implements NestModule {
  static register(options: AdmissionRegistration): DynamicModule {
    if (options === null || typeof options !== 'object')
      throw new AdmissionConfigError('admission');
    const limits = validateAdmissionLimits(options.admission);
    const exemptPaths = validateExemptPaths(
      options.exemptPaths === undefined
        ? [...DEFAULT_EXEMPT_PATHS]
        : [...options.exemptPaths],
    );
    const readinessTimeoutMs = requireInteger(
      options.readiness?.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      'readiness.timeoutMs',
      10,
      30_000,
    );
    const readinessTokens = options.readiness?.checks ?? [];
    const rate = options.rateLimit
      ? resolveRateLimit(options.rateLimit)
      : undefined;

    const providers: Provider[] = [
      {
        provide: ADMISSION_CHECKS,
        inject: [...readinessTokens],
        useFactory: (...checks: unknown[]) =>
          checks.map((check, index) => requireReadinessCheck(check, index)),
      },
      {
        provide: ADMISSION_RATE_STORE,
        inject: rate === undefined ? [] : [rate.store],
        useFactory: (store?: unknown) =>
          store === undefined ? undefined : requireRateLimiter(store),
      },
      {
        provide: ADMISSION_SIGNALS_PORT,
        inject: options.signals === undefined ? [] : [options.signals],
        useFactory: (port?: unknown): OperationSignals =>
          port === undefined
            ? createNoopOperationSignals()
            : (port as OperationSignals),
      },
      {
        provide: ADMISSION_SERVICE,
        inject: [
          ADMISSION_CHECKS,
          ADMISSION_RATE_STORE,
          ADMISSION_SIGNALS_PORT,
        ],
        useFactory: (
          checks: ReadinessCheck[],
          store: RateLimiter | undefined,
          signals: OperationSignals,
        ) => {
          const gate = new AdmissionGate(limits);
          const rateLimit =
            rate === undefined || store === undefined
              ? undefined
              : {
                  limiter: new ResilientRateLimiter({
                    shared: store,
                    local: new LocalRateLimiter(rate.localMaxKeys),
                    failurePolicy: rate.failurePolicy,
                    localFallbackRatio: rate.localFallbackRatio,
                    sharedTimeoutMs: rate.sharedTimeoutMs,
                    onDegraded: () =>
                      recordSignal(
                        signals,
                        ADMISSION_SIGNAL.rateDegraded,
                        'failed',
                      ),
                  }),
                  policy: rate.policy,
                  digestSecret: rate.keyDigestSecret,
                };
          return new AdmissionService({
            limits,
            gate,
            exemptPaths,
            checks,
            readinessTimeoutMs,
            signals,
            ...(rateLimit === undefined ? {} : { rateLimit }),
          });
        },
      },
      AdmissionMiddleware,
      AdmissionDrainHook,
    ];
    if (rate !== undefined)
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: RateLimitInterceptor,
      });

    return {
      module: AdmissionModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers,
      exports: [ADMISSION_SERVICE],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AdmissionMiddleware)
      .forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }
}

interface ResolvedRateLimit {
  readonly store: InjectionToken;
  readonly policy: RateLimitPolicy;
  readonly failurePolicy: RateLimitFailurePolicy;
  readonly localFallbackRatio: number;
  readonly localMaxKeys: number;
  readonly sharedTimeoutMs: number;
  readonly keyDigestSecret: string;
}

function resolveRateLimit(
  input: AdmissionRateLimitRegistration,
): ResolvedRateLimit {
  if (input === null || typeof input !== 'object')
    throw new AdmissionConfigError('rateLimit');
  if (
    typeof input.keyDigestSecret !== 'string' ||
    input.keyDigestSecret.length < MIN_DIGEST_SECRET_LENGTH
  )
    throw new AdmissionConfigError('rateLimit.keyDigestSecret');
  return {
    store: input.store,
    policy: validateRateLimitPolicy(input.policy),
    failurePolicy: validateFailurePolicy(
      input.failurePolicy ?? 'fallback-local',
    ),
    localFallbackRatio: validateLocalFallbackRatio(
      input.localFallbackRatio ?? DEFAULT_LOCAL_FALLBACK_RATIO,
    ),
    localMaxKeys: requireInteger(
      input.localMaxKeys ?? DEFAULT_LOCAL_MAX_KEYS,
      'rateLimit.localMaxKeys',
      1,
      1_000_000,
    ),
    sharedTimeoutMs: requireInteger(
      input.sharedTimeoutMs ?? DEFAULT_SHARED_TIMEOUT_MS,
      'rateLimit.sharedTimeoutMs',
      1,
      10_000,
    ),
    keyDigestSecret: input.keyDigestSecret,
  };
}
