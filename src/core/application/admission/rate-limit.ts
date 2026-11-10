import { AdmissionConfigError } from './admission.config';
import type {
  RateLimitFailurePolicy,
  RateLimitPolicy,
} from './admission.config';

/** Porta de rate limit. Implementações compartilhadas devem ser atômicas por chave. */
export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Tempo até a próxima permissão, em ms; zero quando permitido. */
  readonly retryAfterMs: number;
}

export interface TokenBucketState {
  readonly tokens: number;
  readonly updatedAt: number;
}

export interface TokenBucketStep {
  readonly state: TokenBucketState;
  readonly decision: RateLimitDecision;
}

/**
 * Token bucket de referência: capacidade `limit`, reposição contínua de
 * `limit / windowMs` por ms. Implementação Redis usa a mesma regra no Lua.
 */
export function tokenBucketStep(
  previous: TokenBucketState | undefined,
  now: number,
  policy: RateLimitPolicy,
): TokenBucketStep {
  const rate = policy.limit / policy.windowMs;
  const base: TokenBucketState = previous ?? {
    tokens: policy.limit,
    updatedAt: now,
  };
  const elapsed = Math.max(0, now - base.updatedAt);
  let tokens = Math.min(policy.limit, base.tokens + elapsed * rate);
  if (tokens >= 1) {
    tokens -= 1;
    return {
      state: { tokens, updatedAt: now },
      decision: { allowed: true, retryAfterMs: 0 },
    };
  }
  return {
    state: { tokens, updatedAt: now },
    decision: {
      allowed: false,
      retryAfterMs: Math.ceil((1 - tokens) / rate),
    },
  };
}

/** Limitador em processo com número máximo de chaves (LRU). Memória sempre limitada. */
export class LocalRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();

  constructor(
    private readonly maxKeys: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1_000_000)
      throw new AdmissionConfigError('rateLimit.localMaxKeys');
  }

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const previous = this.buckets.get(key);
    const step = tokenBucketStep(previous, this.clock(), policy);
    // Reinsere para manter a ordem LRU; ao exceder, descarta a chave menos recente.
    this.buckets.delete(key);
    this.buckets.set(key, step.state);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
    return Promise.resolve(step.decision);
  }
}

export type RateLimitOutcome = 'allowed' | 'limited' | 'unavailable';

export interface RateLimitResult {
  readonly outcome: RateLimitOutcome;
  readonly retryAfterMs: number;
  readonly source: 'shared' | 'local-fallback';
}

export interface ResilientRateLimiterOptions {
  readonly shared: RateLimiter;
  readonly local: RateLimiter;
  readonly failurePolicy: RateLimitFailurePolicy;
  /** Fração do limite usada pelo fallback local. */
  readonly localFallbackRatio: number;
  /** Tempo máximo de uma consulta ao armazenamento compartilhado. */
  readonly sharedTimeoutMs: number;
  /** Chamado a cada falha do armazenamento compartilhado (sinal de degradação). */
  readonly onDegraded: () => void;
}

/**
 * Aplica o limitador compartilhado com política explícita de falha. No fallback
 * local, o limite é reduzido pela fração configurada, nunca eliminado.
 */
export class ResilientRateLimiter {
  constructor(private readonly options: ResilientRateLimiterOptions) {
    if (!(options.localFallbackRatio > 0 && options.localFallbackRatio <= 1))
      throw new AdmissionConfigError('rateLimit.localFallbackRatio');
    if (
      !Number.isSafeInteger(options.sharedTimeoutMs) ||
      options.sharedTimeoutMs < 1
    )
      throw new AdmissionConfigError('rateLimit.sharedTimeoutMs');
  }

  async consume(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    try {
      const decision = await withTimeout(
        this.options.shared.consume(key, policy),
        this.options.sharedTimeoutMs,
      );
      return {
        outcome: decision.allowed ? 'allowed' : 'limited',
        retryAfterMs: decision.retryAfterMs,
        source: 'shared',
      };
    } catch {
      this.options.onDegraded();
      if (this.options.failurePolicy === 'fail-closed')
        return { outcome: 'unavailable', retryAfterMs: 0, source: 'shared' };
      const reduced: RateLimitPolicy = {
        limit: Math.max(
          1,
          Math.floor(policy.limit * this.options.localFallbackRatio),
        ),
        windowMs: policy.windowMs,
      };
      const decision = await this.options.local.consume(key, reduced);
      return {
        outcome: decision.allowed ? 'allowed' : 'limited',
        retryAfterMs: decision.retryAfterMs,
        source: 'local-fallback',
      };
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('rate_limit_timeout')), ms);
  });
  return Promise.race([work, expired]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const KEY_PART = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST = /^[a-f0-9]{16,128}$/;

export interface RateLimitSubject {
  /** Tenant do principal autenticado, quando existir. */
  readonly tenantId?: string;
  /** Subject interno autenticado. */
  readonly subjectId?: string;
  /** Digest (hex) do IP calculado na apresentação; o IP bruto nunca entra aqui. */
  readonly addressDigest?: string;
}

/**
 * Chave de rate limit: tenant+subject para autenticados, digest do IP para anônimos.
 * Não aceita IP bruto nem identificadores fora de formato seguro.
 */
export function rateLimitKeyFor(subject: RateLimitSubject): string {
  if (subject.subjectId !== undefined) {
    if (!KEY_PART.test(subject.subjectId))
      throw new AdmissionConfigError('rateLimit.subjectId');
    const tenant = subject.tenantId ?? '-';
    if (tenant !== '-' && !KEY_PART.test(tenant))
      throw new AdmissionConfigError('rateLimit.tenantId');
    return `sub:${tenant}:${subject.subjectId}`;
  }
  if (subject.addressDigest !== undefined) {
    if (!DIGEST.test(subject.addressDigest))
      throw new AdmissionConfigError('rateLimit.addressDigest');
    return `ip:${subject.addressDigest}`;
  }
  throw new AdmissionConfigError('rateLimit.subject');
}
