import {
  createJobRetryPolicy,
  JobRetryPolicyError,
  type JobRetryPolicyConfig,
} from './job-retry-policy';

const config: JobRetryPolicyConfig = {
  globalMaxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  timeoutMs: 5000,
};

describe('JobRetryPolicy', () => {
  it('limita maxAttempts do envelope pelo teto global', () => {
    const policy = createJobRetryPolicy(config);

    expect(policy.resolveMaxAttempts(50)).toBe(5);
    expect(policy.resolveMaxAttempts(2)).toBe(2);
    expect(policy.resolveMaxAttempts(0)).toBe(1);
  });

  it('cresce exponencialmente com jitter dentro do teto', () => {
    const policy = createJobRetryPolicy(config);

    // Equal jitter: intervalo [teto/2, teto] para cada tentativa falha.
    expect(policy.backoffDelayMs(1, () => 0)).toBe(50);
    expect(policy.backoffDelayMs(1, () => 0.999)).toBeLessThanOrEqual(100);
    expect(policy.backoffDelayMs(2, () => 0)).toBe(100);
    expect(policy.backoffDelayMs(2, () => 0.999)).toBeLessThanOrEqual(200);
    expect(policy.backoffDelayMs(3, () => 0.999)).toBeLessThanOrEqual(400);
  });

  it('nunca ultrapassa maxDelayMs, mesmo com muitas falhas', () => {
    const policy = createJobRetryPolicy(config);

    for (const failures of [4, 10, 40, 1000]) {
      expect(policy.backoffDelayMs(failures, () => 0.999)).toBeLessThanOrEqual(
        1000,
      );
      expect(policy.backoffDelayMs(failures, () => 0)).toBeLessThanOrEqual(
        1000,
      );
    }
  });

  it('trata amostra inválida do sorteio como metade do teto', () => {
    const policy = createJobRetryPolicy(config);

    expect(policy.backoffDelayMs(2, () => Number.NaN)).toBe(100);
  });

  it('rejeita configuração inválida nomeando apenas o campo', () => {
    expect(() =>
      createJobRetryPolicy({ ...config, globalMaxAttempts: 0 }),
    ).toThrow(JobRetryPolicyError);
    expect(() =>
      createJobRetryPolicy({ ...config, baseDelayMs: 5000 }),
    ).toThrow('job_retry_policy_invalid:baseDelayMs');
  });
});
