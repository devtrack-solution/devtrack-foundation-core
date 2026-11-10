import {
  AdmissionConfigError,
  validateAdmissionLimits,
  validateFailurePolicy,
  validateLocalFallbackRatio,
  validateRateLimitPolicy,
} from './admission.config';

const valid = { maxInFlight: 10, maxQueue: 5, maxQueueWaitMs: 500 };

describe('validateAdmissionLimits', () => {
  it('aplica padrões de retry e drenagem quando opcionais', () => {
    expect(validateAdmissionLimits(valid)).toEqual({
      ...valid,
      retryAfterSeconds: 1,
      drainDeadlineMs: 10_000,
    });
  });

  it('aceita fila zero (rejeição imediata acima da concorrência)', () => {
    expect(validateAdmissionLimits({ ...valid, maxQueue: 0 }).maxQueue).toBe(0);
  });

  it.each([
    ['maxInFlight', { maxInFlight: 0 }],
    ['maxInFlight', { maxInFlight: 10_001 }],
    ['maxQueue', { maxQueue: -1 }],
    ['maxQueue', { maxQueue: 1.5 }],
    ['maxQueueWaitMs', { maxQueueWaitMs: 0 }],
    ['maxQueueWaitMs', { maxQueueWaitMs: 60_001 }],
    ['retryAfterSeconds', { retryAfterSeconds: 0 }],
    ['drainDeadlineMs', { drainDeadlineMs: 99 }],
    ['maxInFlight', { maxInFlight: Number.NaN }],
  ])('rejeita %s fora da faixa citando só o nome do campo', (field, patch) => {
    let caught: unknown;
    try {
      validateAdmissionLimits({ ...valid, ...patch });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdmissionConfigError);
    expect((caught as AdmissionConfigError).field).toBe(field);
    expect((caught as Error).message).toBe(
      `Invalid admission configuration: ${field}`,
    );
  });
});

describe('validateRateLimitPolicy e políticas', () => {
  it('valida limite e janela', () => {
    expect(validateRateLimitPolicy({ limit: 5, windowMs: 60_000 })).toEqual({
      limit: 5,
      windowMs: 60_000,
    });
    expect(() =>
      validateRateLimitPolicy({ limit: 0, windowMs: 60_000 }),
    ).toThrow(AdmissionConfigError);
    expect(() => validateRateLimitPolicy({ limit: 5, windowMs: 999 })).toThrow(
      AdmissionConfigError,
    );
  });

  it('aceita apenas fallback-local e fail-closed', () => {
    expect(validateFailurePolicy('fail-closed')).toBe('fail-closed');
    expect(() => validateFailurePolicy('open')).toThrow(AdmissionConfigError);
    expect(() => validateFailurePolicy(undefined)).toThrow(
      AdmissionConfigError,
    );
  });

  it('exige fração do fallback em (0, 1]', () => {
    expect(validateLocalFallbackRatio(1)).toBe(1);
    expect(() => validateLocalFallbackRatio(0)).toThrow(AdmissionConfigError);
    expect(() => validateLocalFallbackRatio(1.01)).toThrow(
      AdmissionConfigError,
    );
  });
});
