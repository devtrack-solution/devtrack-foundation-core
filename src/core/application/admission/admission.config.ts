/**
 * Limites de admissão, rate limit e drenagem. Application pura: valida faixas e
 * lança erros que citam apenas o nome do campo, nunca o valor informado.
 */

export class AdmissionConfigError extends Error {
  constructor(readonly field: string) {
    super(`Invalid admission configuration: ${field}`);
    this.name = 'AdmissionConfigError';
  }
}

export interface AdmissionLimits {
  /** Requisições processadas simultaneamente por processo. */
  readonly maxInFlight: number;
  /** Requisições aguardando permissão. Zero rejeita imediatamente acima de maxInFlight. */
  readonly maxQueue: number;
  /** Tempo máximo de espera na fila, em milissegundos. */
  readonly maxQueueWaitMs: number;
  /** Valor do header Retry-After nas rejeições por capacidade. */
  readonly retryAfterSeconds: number;
  /** Prazo de drenagem no encerramento, em milissegundos. */
  readonly drainDeadlineMs: number;
}

export interface AdmissionLimitsInput {
  readonly maxInFlight: number;
  readonly maxQueue: number;
  readonly maxQueueWaitMs: number;
  readonly retryAfterSeconds?: number;
  readonly drainDeadlineMs?: number;
}

export const ADMISSION_DEFAULTS = {
  retryAfterSeconds: 1,
  drainDeadlineMs: 10_000,
} as const;

export function requireInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new AdmissionConfigError(field);
  return value;
}

/** Valida limites de admissão. Campos ausentes recebem padrão somente quando opcionais. */
export function validateAdmissionLimits(
  input: AdmissionLimitsInput,
): AdmissionLimits {
  if (input === null || typeof input !== 'object')
    throw new AdmissionConfigError('admission');
  return {
    maxInFlight: requireInteger(input.maxInFlight, 'maxInFlight', 1, 10_000),
    maxQueue: requireInteger(input.maxQueue, 'maxQueue', 0, 10_000),
    maxQueueWaitMs: requireInteger(
      input.maxQueueWaitMs,
      'maxQueueWaitMs',
      1,
      60_000,
    ),
    retryAfterSeconds: requireInteger(
      input.retryAfterSeconds ?? ADMISSION_DEFAULTS.retryAfterSeconds,
      'retryAfterSeconds',
      1,
      3_600,
    ),
    drainDeadlineMs: requireInteger(
      input.drainDeadlineMs ?? ADMISSION_DEFAULTS.drainDeadlineMs,
      'drainDeadlineMs',
      100,
      120_000,
    ),
  };
}

export interface RateLimitPolicy {
  /** Requisições permitidas por janela (capacidade do balde). */
  readonly limit: number;
  readonly windowMs: number;
}

export function validateRateLimitPolicy(
  input: RateLimitPolicy,
): RateLimitPolicy {
  if (input === null || typeof input !== 'object')
    throw new AdmissionConfigError('rateLimit');
  return {
    limit: requireInteger(input.limit, 'rateLimit.limit', 1, 1_000_000),
    windowMs: requireInteger(
      input.windowMs,
      'rateLimit.windowMs',
      1_000,
      86_400_000,
    ),
  };
}

/**
 * Política quando o armazenamento compartilhado falha. `fallback-local` usa um
 * limitador em memória conservador; `fail-closed` responde 503. Nunca libera sem limite.
 */
export type RateLimitFailurePolicy = 'fallback-local' | 'fail-closed';

export const RATE_LIMIT_FAILURE_POLICIES: readonly RateLimitFailurePolicy[] = [
  'fallback-local',
  'fail-closed',
];

export function validateFailurePolicy(value: unknown): RateLimitFailurePolicy {
  if (
    typeof value !== 'string' ||
    !(RATE_LIMIT_FAILURE_POLICIES as readonly string[]).includes(value)
  )
    throw new AdmissionConfigError('rateLimit.failurePolicy');
  return value as RateLimitFailurePolicy;
}

/** Fração do limite aplicada pelo fallback local (0 < r <= 1). */
export function validateLocalFallbackRatio(value: number): number {
  if (typeof value !== 'number' || !(value > 0 && value <= 1))
    throw new AdmissionConfigError('rateLimit.localFallbackRatio');
  return value;
}
