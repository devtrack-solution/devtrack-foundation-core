import { AdmissionConfigError } from './admission.config';
import {
  LocalRateLimiter,
  rateLimitKeyFor,
  ResilientRateLimiter,
  tokenBucketStep,
  type RateLimiter,
} from './rate-limit';

const policy = { limit: 3, windowMs: 3_000 };

describe('tokenBucketStep', () => {
  it('começa cheio, consome e informa quando o próximo token existe', () => {
    let state = tokenBucketStep(undefined, 0, policy).state;
    for (let i = 0; i < 2; i += 1) {
      const step = tokenBucketStep(state, 0, policy);
      expect(step.decision.allowed).toBe(true);
      state = step.state;
    }
    const blocked = tokenBucketStep(state, 0, policy);
    expect(blocked.decision).toEqual({ allowed: false, retryAfterMs: 1_000 });
  });

  it('repõe tokens com o tempo e nunca passa da capacidade', () => {
    const drained = tokenBucketStep(undefined, 0, {
      limit: 1,
      windowMs: 1_000,
    }).state;
    const later = tokenBucketStep(drained, 10_000, {
      limit: 1,
      windowMs: 1_000,
    });
    expect(later.decision.allowed).toBe(true);
    expect(later.state.tokens).toBe(0);
  });
});

describe('LocalRateLimiter', () => {
  it('mantém no máximo maxKeys chaves (LRU)', async () => {
    const limiter = new LocalRateLimiter(2, () => 0);
    await limiter.consume('a', policy);
    await limiter.consume('b', policy);
    await limiter.consume('c', policy);
    expect(limiter.size).toBe(2);
  });

  it('valida maxKeys', () => {
    expect(() => new LocalRateLimiter(0)).toThrow(AdmissionConfigError);
  });
});

describe('ResilientRateLimiter', () => {
  const failing: RateLimiter = {
    consume: () => Promise.reject(new Error('down')),
  };
  const healthy = (allowed: boolean): RateLimiter => ({
    consume: () =>
      Promise.resolve({ allowed, retryAfterMs: allowed ? 0 : 500 }),
  });

  function build(
    shared: RateLimiter,
    failurePolicy: 'fallback-local' | 'fail-closed',
  ) {
    const onDegraded = jest.fn();
    const limiter = new ResilientRateLimiter({
      shared,
      local: new LocalRateLimiter(100, () => 0),
      failurePolicy,
      localFallbackRatio: 0.5,
      sharedTimeoutMs: 50,
      onDegraded,
    });
    return { limiter, onDegraded };
  }

  it('usa o compartilhado quando disponível', async () => {
    const { limiter, onDegraded } = build(healthy(false), 'fallback-local');
    await expect(limiter.consume('k', policy)).resolves.toEqual({
      outcome: 'limited',
      retryAfterMs: 500,
      source: 'shared',
    });
    expect(onDegraded).not.toHaveBeenCalled();
  });

  it('fallback-local limita com a fração conservadora e emite degradação', async () => {
    const { limiter, onDegraded } = build(failing, 'fallback-local');
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1)
      outcomes.push(
        (await limiter.consume('k', { limit: 4, windowMs: 60_000 })).outcome,
      );
    // limite 4 * 0.5 = 2 no fallback: duas permitidas, a terceira limitada.
    expect(outcomes).toEqual(['allowed', 'allowed', 'limited']);
    expect(onDegraded).toHaveBeenCalledTimes(3);
  });

  it('fallback-local nunca libera sem limite', async () => {
    const { limiter } = build(failing, 'fallback-local');
    const results: string[] = [];
    for (let i = 0; i < 10; i += 1)
      results.push(
        (await limiter.consume('x', { limit: 1, windowMs: 60_000 })).outcome,
      );
    expect(results.filter((o) => o === 'allowed')).toHaveLength(1);
  });

  it('fail-closed responde indisponível sem consultar o fallback', async () => {
    const { limiter, onDegraded } = build(failing, 'fail-closed');
    await expect(limiter.consume('k', policy)).resolves.toEqual({
      outcome: 'unavailable',
      retryAfterMs: 0,
      source: 'shared',
    });
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it('trata estouro de prazo do compartilhado como falha', async () => {
    const hanging: RateLimiter = {
      consume: () => new Promise(() => undefined),
    };
    const { limiter } = build(hanging, 'fail-closed');
    await expect(limiter.consume('k', policy)).resolves.toMatchObject({
      outcome: 'unavailable',
    });
  });
});

describe('rateLimitKeyFor', () => {
  it('usa tenant+subject para autenticados e digest para anônimos', () => {
    expect(rateLimitKeyFor({ tenantId: 't-1', subjectId: 'u-1' })).toBe(
      'sub:t-1:u-1',
    );
    expect(rateLimitKeyFor({ subjectId: 'u-1' })).toBe('sub:-:u-1');
    expect(rateLimitKeyFor({ addressDigest: 'a'.repeat(32) })).toBe(
      `ip:${'a'.repeat(32)}`,
    );
  });

  it('rejeita IP bruto e identificadores fora de formato', () => {
    expect(() => rateLimitKeyFor({ addressDigest: '10.0.0.1' })).toThrow(
      AdmissionConfigError,
    );
    expect(() => rateLimitKeyFor({ subjectId: 'u 1' })).toThrow(
      AdmissionConfigError,
    );
    expect(() => rateLimitKeyFor({})).toThrow(AdmissionConfigError);
  });
});
