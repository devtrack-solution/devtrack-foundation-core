export interface JobRetryPolicyConfig {
  /** Teto global: o `maxAttempts` do envelope é limitado por ele. */
  readonly globalMaxAttempts: number;
  readonly baseDelayMs: number;
  /** Teto do atraso, aplicado após o jitter. */
  readonly maxDelayMs: number;
  /** Tempo máximo de execução de um handler, antes do prazo do envelope. */
  readonly timeoutMs: number;
}

export interface JobRetryPolicy {
  readonly timeoutMs: number;
  resolveMaxAttempts(envelopeMaxAttempts: number): number;
  /**
   * Atraso antes da próxima tentativa, `failedAttempts` >= 1. Exponencial com
   * "equal jitter": valor sorteado em [teto/2, teto], onde teto = min(maxDelay, base * 2^(n-1)).
   * `random` deve devolver [0, 1); injetado para teste determinístico.
   */
  backoffDelayMs(failedAttempts: number, random: () => number): number;
}

export class JobRetryPolicyError extends Error {
  constructor(readonly field: string) {
    super(`job_retry_policy_invalid:${field}`);
    this.name = 'JobRetryPolicyError';
  }
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new JobRetryPolicyError(field);
  }
  return value;
}

export function createJobRetryPolicy(
  config: JobRetryPolicyConfig,
): JobRetryPolicy {
  const globalMaxAttempts = positiveInteger(
    config.globalMaxAttempts,
    'globalMaxAttempts',
    100,
  );
  const baseDelayMs = positiveInteger(
    config.baseDelayMs,
    'baseDelayMs',
    3_600_000,
  );
  const maxDelayMs = positiveInteger(
    config.maxDelayMs,
    'maxDelayMs',
    86_400_000,
  );
  const timeoutMs = positiveInteger(config.timeoutMs, 'timeoutMs', 86_400_000);
  if (baseDelayMs > maxDelayMs) throw new JobRetryPolicyError('baseDelayMs');

  return {
    timeoutMs,
    resolveMaxAttempts(envelopeMaxAttempts: number): number {
      return Math.max(1, Math.min(envelopeMaxAttempts, globalMaxAttempts));
    },
    backoffDelayMs(failedAttempts: number, random: () => number): number {
      const exponent = Math.min(Math.max(failedAttempts, 1) - 1, 30);
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
      const sample = random();
      const fraction = Number.isFinite(sample)
        ? Math.min(Math.max(sample, 0), 1)
        : 0;
      const delay = Math.floor(ceiling / 2 + fraction * (ceiling / 2));
      return Math.min(maxDelayMs, Math.max(0, delay));
    },
  };
}
