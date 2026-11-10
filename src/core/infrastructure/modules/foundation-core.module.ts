import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
} from '@nestjs/common';
import { AuthenticationService } from '../../application/security/authentication.service';
import type { AuthenticationDependencies } from '../../application/security/authentication.service';
import type {
  AccessTokenIssuer,
  AccessTokenVerifier,
  AuthenticationSessions,
  Clock,
  FederatedIdentityProvider,
  IdentityAccessResolver,
  PasswordCredentialsVerifier,
  RefreshTokenSecrets,
  RefreshTokenStore,
} from '../../application/security/authentication.ports';
import type { AuditWriter } from '../../application/audit/audit-writer.port';
import {
  AUTHENTICATION_DEPENDENCIES,
  AUTHENTICATION_SERVICE,
} from '../../application/security/authentication.tokens';
import { OPERATION_CONTEXT_ACCESSOR } from '../../application/context/operation-context.accessor';
import {
  OPERATION_AUTHORIZER,
  OperationAuthorizer,
} from '../../application/security/operation-authorizer';
import type { OperationAuthorizationDependencies } from '../../application/security/operation-authorizer';
import type { SessionReader } from '../../application/sessions/session-reader.port';
import { AsyncOperationContextStore } from '../context/async-operation-context.store';
import { CorrelationIdInterceptor } from '../../presentation/http/interceptors/correlation-id.interceptor';
import { OperationContextInterceptor } from '../../presentation/http/interceptors/operation-context.interceptor';
import { HttpErrorFilter } from '../../presentation/http/filters/http-error.filter';
import { requireFunction, requirePort, requireToken } from './port-bindings';
import {
  AdmissionModule,
  type AdmissionRegistration,
} from '../../presentation/http/admission/admission.module';

export * from '../context/async-operation-context.store';
export * from '../../presentation/http/guards/authentication.guard';
export * from '../../presentation/http/interceptors/correlation-id.interceptor';
export * from '../../presentation/http/interceptors/operation-context.interceptor';
export * from '../../presentation/http/filters/http-error.filter';
export * from '../../presentation/http/pipes/request-body-limit.pipe';
export * from '../../presentation/http/decorators/require-permissions.decorator';

/** Renovação opcional (D2). Janela de graça entre 0 e 30 s; padrão do serviço quando omitida. */
export interface RefreshPortBindings {
  /** Token de `RefreshTokenStore`. */
  readonly store: InjectionToken;
  /** Token de `RefreshTokenSecrets`. */
  readonly secrets: InjectionToken;
  readonly idleTtlMs?: number;
  readonly graceWindowMs?: number;
}

/** Auditoria opcional de login, renovação e revogação. */
export interface AuditPortBindings {
  /** Token de `AuditWriter`. */
  readonly writer: InjectionToken;
  /** Token de uma função `() => string` que gera o id de cada entrada. */
  readonly newEntryId: InjectionToken;
}

/** Names describe ports; a Nest token alone does not prove the provider's type. */
export interface AuthenticationPortBindings {
  readonly identities: InjectionToken;
  readonly sessions: InjectionToken;
  readonly tokens: InjectionToken;
  readonly clock: InjectionToken;
  readonly password?: InjectionToken;
  readonly federation?: readonly InjectionToken[];
  readonly refresh?: RefreshPortBindings;
  readonly audit?: AuditPortBindings;
}

/** Faixa da janela de graça do D2, em milissegundos. */
const REFRESH_GRACE_WINDOW_MAX_MS = 30_000;

/** Checks the optional refresh binding before Nest starts. Shape and ranges only. */
function validateRefreshBindings(refresh: RefreshPortBindings): void {
  if (refresh === null || typeof refresh !== 'object')
    throw new Error('Invalid authentication binding: refresh');
  requireToken(refresh.store, 'refresh.store');
  requireToken(refresh.secrets, 'refresh.secrets');
  if (
    refresh.idleTtlMs !== undefined &&
    (!Number.isSafeInteger(refresh.idleTtlMs) || refresh.idleTtlMs <= 0)
  )
    throw new Error('Invalid refresh policy: idleTtlMs');
  if (
    refresh.graceWindowMs !== undefined &&
    (!Number.isSafeInteger(refresh.graceWindowMs) ||
      refresh.graceWindowMs < 0 ||
      refresh.graceWindowMs > REFRESH_GRACE_WINDOW_MAX_MS)
  )
    throw new Error('Invalid refresh policy: graceWindowMs');
}
export interface AuthenticationRegistration {
  readonly imports?: ModuleMetadata['imports'];
  readonly ports: AuthenticationPortBindings;
}

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/** Portas obrigatórias do registro HTTP. Nomes descrevem portas, não tipos de provider. */
export interface HttpSecurityPortBindings {
  /** AccessTokenVerifier: token bearer -> identidade, sessão e expiração. */
  readonly tokens: InjectionToken;
  /** SessionReader: estado autoritativo da sessão. */
  readonly sessions: InjectionToken;
  /** IdentityAccessResolver: autorização atual do subject. */
  readonly identities: InjectionToken;
  readonly clock: InjectionToken;
}
export interface HttpSecurityRegistration {
  readonly imports?: ModuleMetadata['imports'];
  readonly ports: HttpSecurityPortBindings;
  /** Prazo da operação após autorização, em milissegundos. Padrão: 30000. */
  readonly operationTimeoutMs?: number;
}

/** Interno: portas validadas no momento da composição. */
export const HTTP_SECURITY_DEPENDENCIES = Symbol.for(
  'foundation.api.v1.http-security.dependencies',
);

/** Nest remains the DI container. No adapter is implicitly enabled. */
@Module({})
export class FoundationCoreModule {
  static withAuthentication(
    options: AuthenticationRegistration,
  ): DynamicModule {
    if (!options?.ports || typeof options.ports !== 'object')
      throw new Error('Authentication registration requires named ports');
    if ('inject' in options || 'useFactory' in options)
      throw new Error(
        'Authentication registration no longer accepts inject/useFactory',
      );

    const { identities, sessions, tokens, clock, password } = options.ports;
    const required = { identities, sessions, tokens, clock };
    for (const [name, token] of Object.entries(required))
      requireToken(token, name);
    if (password !== undefined) requireToken(password, 'password');
    const rawFederation: unknown =
      options.ports.federation === undefined ? [] : options.ports.federation;
    if (!Array.isArray(rawFederation))
      throw new Error('Invalid authentication binding: federation');
    const federation = rawFederation.map((token: unknown, index: number) => {
      requireToken(token, `federation[${index}]`);
      return token;
    });

    // The positional list is private and built from the same named bindings as
    // this factory. Consumers never maintain a separate parameter order.
    const refresh = options.ports.refresh;
    const audit = options.ports.audit;
    if (refresh !== undefined) validateRefreshBindings(refresh);
    if (audit !== undefined) {
      if (audit === null || typeof audit !== 'object')
        throw new Error('Invalid authentication binding: audit');
      requireToken(audit.writer, 'audit.writer');
      requireToken(audit.newEntryId, 'audit.newEntryId');
    }

    const inject = [
      identities,
      sessions,
      tokens,
      clock,
      ...(password === undefined ? [] : [password]),
      ...federation,
      ...(refresh === undefined ? [] : [refresh.store, refresh.secrets]),
      ...(audit === undefined ? [] : [audit.writer, audit.newEntryId]),
    ];
    const hasPassword = password !== undefined;
    const federationCount = federation.length;

    return {
      module: FoundationCoreModule,
      imports: options.imports,
      providers: [
        {
          provide: AUTHENTICATION_DEPENDENCIES,
          inject,
          useFactory: (...values: unknown[]): AuthenticationDependencies => {
            const federationStart = hasPassword ? 5 : 4;
            const providers = values
              .slice(federationStart, federationStart + federationCount)
              .map((value, index) => {
                const provider = requirePort<FederatedIdentityProvider>(
                  value,
                  `federation[${index}]`,
                  ['begin', 'complete'],
                );
                if (typeof provider.id !== 'string' || provider.id.length === 0)
                  throw new Error(
                    `Invalid authentication provider: federation[${index}].id`,
                  );
                return provider;
              });
            if (providers.length !== federationCount)
              throw new Error('Invalid authentication provider count');
            // Opcionais: valores posicionais após a federação, na mesma ordem de `inject`.
            let next = federationStart + federationCount;
            const refreshDeps =
              refresh === undefined
                ? undefined
                : {
                    store: requirePort<RefreshTokenStore>(
                      values[next],
                      'refresh.store',
                      ['issue', 'rotate', 'revokeFamily'],
                    ),
                    secrets: requirePort<RefreshTokenSecrets>(
                      values[next + 1],
                      'refresh.secrets',
                      ['generate', 'digest'],
                    ),
                    idleTtlMs: refresh.idleTtlMs,
                    graceWindowMs: refresh.graceWindowMs,
                  };
            if (refresh !== undefined) next += 2;
            let auditDeps:
              { writer: AuditWriter; newEntryId: () => string } | undefined;
            if (audit !== undefined) {
              const newEntryId = values[next + 1];
              requireFunction(newEntryId, 'audit.newEntryId');
              auditDeps = {
                writer: requirePort<AuditWriter>(values[next], 'audit.writer', [
                  'append',
                ]),
                newEntryId: newEntryId as () => string,
              };
            }
            return {
              identities: requirePort<IdentityAccessResolver>(
                values[0],
                'identities',
                ['bySubject', 'byExternalIdentity'],
              ),
              sessions: requirePort<AuthenticationSessions>(
                values[1],
                'sessions',
                ['createPending', 'activate', 'revoke'],
              ),
              tokens: requirePort<AccessTokenIssuer>(values[2], 'tokens', [
                'issue',
              ]),
              clock: requirePort<Clock>(values[3], 'clock', ['now']),
              ...(hasPassword
                ? {
                    password: requirePort<PasswordCredentialsVerifier>(
                      values[4],
                      'password',
                      ['verify'],
                    ),
                  }
                : {}),
              federation: providers,
              ...(refreshDeps === undefined ? {} : { refresh: refreshDeps }),
              ...(auditDeps === undefined ? {} : { audit: auditDeps }),
            };
          },
        },
        {
          provide: AUTHENTICATION_SERVICE,
          useFactory: (ports: AuthenticationDependencies) =>
            new AuthenticationService(ports),
          inject: [AUTHENTICATION_DEPENDENCIES],
        },
      ],
      exports: [AUTHENTICATION_SERVICE],
    };
  }

  /**
   * Opt-in: admissão por processo com fila limitada, rate limit opcional, health
   * (`/health/live`, `/health/ready`) e drenagem no encerramento. Nada é ativo sem esta chamada.
   */
  static withAdmission(options: AdmissionRegistration): DynamicModule {
    return AdmissionModule.register(options);
  }

  /**
   * Habilita contexto, correlação e tradução de erros HTTP. Nada é ativo sem
   * esta chamada; rotas só ficam protegidas quando usam AuthenticationGuard.
   */
  static withHttpSecurity(options: HttpSecurityRegistration): DynamicModule {
    if (!options?.ports || typeof options.ports !== 'object')
      throw new Error('HTTP security registration requires named ports');
    const { tokens, sessions, identities, clock } = options.ports;
    requireToken(tokens, 'tokens');
    requireToken(sessions, 'sessions');
    requireToken(identities, 'identities');
    requireToken(clock, 'clock');
    const timeoutMs =
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error('Invalid operation timeout');

    return {
      module: FoundationCoreModule,
      imports: options.imports,
      providers: [
        {
          provide: HTTP_SECURITY_DEPENDENCIES,
          inject: [tokens, sessions, identities, clock],
          useFactory: (
            verifier: unknown,
            reader: unknown,
            resolver: unknown,
            time: unknown,
          ): OperationAuthorizationDependencies => ({
            tokens: requirePort<AccessTokenVerifier>(verifier, 'tokens', [
              'verify',
            ]),
            sessions: requirePort<SessionReader>(reader, 'sessions', ['find']),
            identities: requirePort<IdentityAccessResolver>(
              resolver,
              'identities',
              ['bySubject'],
            ),
            clock: requirePort<Clock>(time, 'clock', ['now']),
          }),
        },
        {
          provide: OPERATION_AUTHORIZER,
          inject: [HTTP_SECURITY_DEPENDENCIES],
          useFactory: (dependencies: OperationAuthorizationDependencies) =>
            new OperationAuthorizer(dependencies, timeoutMs),
        },
        AsyncOperationContextStore,
        {
          provide: OPERATION_CONTEXT_ACCESSOR,
          useExisting: AsyncOperationContextStore,
        },
        { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
        { provide: APP_INTERCEPTOR, useClass: OperationContextInterceptor },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
      exports: [OPERATION_AUTHORIZER, OPERATION_CONTEXT_ACCESSOR],
    };
  }
}
