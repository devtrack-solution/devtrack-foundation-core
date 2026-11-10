import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import type { INestApplication } from '@nestjs/common';
import {
  CacheRedisModule,
  REDIS_READINESS_CHECK,
  SHARED_RATE_LIMITER,
} from '../src/native/cache-redis';
import { RATELIMIT_REJECTED_METRIC } from '../src/core/application/observability/signal-catalog';
import type { AdmissionRegistration } from '../src/core/presentation/http/admission/admission.module';
import {
  closedPort,
  createAdmissionTestApp,
  RecordingSignals,
  RECORDING_SIGNALS,
  startedRedisError,
} from './fixtures/admission-app';

jest.setTimeout(180_000);

const DIGEST_SECRET = 'test-only-digest-secret-0123456789';
const POLICY = { limit: 5, windowMs: 60_000 };

let container: StartedRedisContainer;

beforeAll(async () => {
  try {
    container = await new RedisContainer('redis:7-alpine').start();
  } catch (error) {
    throw startedRedisError(error);
  }
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

function sharedRegistration(
  port: number,
  overrides: Partial<NonNullable<AdmissionRegistration['rateLimit']>> = {},
  readiness = false,
): AdmissionRegistration {
  return {
    imports: [
      CacheRedisModule.register({
        config: { host: container.getHost(), port, commandTimeoutMs: 500 },
      }),
    ],
    admission: { maxInFlight: 50, maxQueue: 50, maxQueueWaitMs: 1_000 },
    rateLimit: {
      store: SHARED_RATE_LIMITER,
      policy: POLICY,
      keyDigestSecret: DIGEST_SECRET,
      ...overrides,
    },
    ...(readiness
      ? { readiness: { checks: [REDIS_READINESS_CHECK], timeoutMs: 500 } }
      : {}),
  };
}

async function get(
  base: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; retryAfter: string | null; error?: string }> {
  const response = await fetch(`${base}/fast`, { headers });
  const body = (await response.json()) as { error?: string };
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    error: body.error,
  };
}

describe('Rate limit compartilhado (Redis real)', () => {
  it('duas instâncias somam o consumo da mesma chave; N passam no total', async () => {
    const a = await createAdmissionTestApp({
      registration: sharedRegistration(container.getPort()),
    });
    const b = await createAdmissionTestApp({
      registration: sharedRegistration(container.getPort()),
    });
    const baseA = await a.getUrl();
    const baseB = await b.getUrl();

    // 12 requisições concorrentes, alternando instâncias: exatamente 5 passam.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => get(i % 2 === 0 ? baseA : baseB)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(POLICY.limit);
    const limited = results.filter((r) => r.status === 429);
    expect(limited).toHaveLength(12 - POLICY.limit);
    expect(limited.every((r) => Number(r.retryAfter) >= 1)).toBe(true);

    // A próxima é 429 em qualquer instância.
    expect((await get(baseA)).status).toBe(429);
    expect((await get(baseB)).status).toBe(429);

    await a.close();
    await b.close();
  });

  it('tenants e subjects diferentes não interferem entre si', async () => {
    const a = await createAdmissionTestApp({
      registration: sharedRegistration(container.getPort()),
    });
    const b = await createAdmissionTestApp({
      registration: sharedRegistration(container.getPort()),
    });
    const baseA = await a.getUrl();
    const baseB = await b.getUrl();

    const tenantA = { 'x-test-subject': 'user-1', 'x-test-tenant': 'tenant-a' };
    const tenantB = { 'x-test-subject': 'user-1', 'x-test-tenant': 'tenant-b' };
    const otherSubject = {
      'x-test-subject': 'user-2',
      'x-test-tenant': 'tenant-a',
    };

    for (let i = 0; i < POLICY.limit; i += 1) {
      expect((await get(baseA, tenantA)).status).toBe(200);
    }
    expect((await get(baseB, tenantA)).status).toBe(429);
    // Mesmo subject em outro tenant tem cota própria; outro subject também.
    for (let i = 0; i < POLICY.limit; i += 1) {
      expect((await get(baseB, tenantB)).status).toBe(200);
      expect((await get(baseA, otherSubject)).status).toBe(200);
    }
    expect((await get(baseB, tenantB)).status).toBe(429);

    await a.close();
    await b.close();
  });

  it('readiness com Redis obrigatório responde 200 enquanto o contêiner está ativo', async () => {
    const app = await createAdmissionTestApp({
      registration: sharedRegistration(container.getPort(), {}, true),
    });
    const base = await app.getUrl();
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    await ready.arrayBuffer();
    await app.close();
  });
});

describe('Redis indisponível', () => {
  let port: number;
  beforeAll(async () => {
    port = await closedPort();
  });

  it('política padrão: cai para limitador local conservador e emite sinal de degradação', async () => {
    const recorder = new RecordingSignals();
    const degraded = await startWithSignals(port, recorder, 'fallback-local');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push((await get(degraded.base)).status);
    // Limite 5 com fração 0.5 no fallback: duas permitidas, o resto limitado. Nunca sem limite.
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(recorder.count('ratelimit.degraded')).toBe(4);
    await degraded.app.close();
  });

  it('fail-closed: responde 503 e nunca libera a requisição', async () => {
    const recorder = new RecordingSignals();
    const failed = await startWithSignals(port, recorder, 'fail-closed');
    for (let i = 0; i < 3; i += 1) {
      const result = await get(failed.base);
      expect(result.status).toBe(503);
      expect(result.error).toBe('Service Unavailable');
    }
    expect(
      recorder.saturationCount(RATELIMIT_REJECTED_METRIC, 'store-unavailable'),
    ).toBe(3);
    await failed.app.close();
  });
});

async function startWithSignals(
  port: number,
  recorder: RecordingSignals,
  failurePolicy: 'fallback-local' | 'fail-closed',
): Promise<{ app: INestApplication; base: string }> {
  const app = await createAdmissionTestApp({
    registration: {
      ...sharedRegistration(port, { failurePolicy, localFallbackRatio: 0.5 }),
      signals: RECORDING_SIGNALS,
    },
    providers: [{ provide: RECORDING_SIGNALS, useValue: recorder }],
  });
  return { app, base: await app.getUrl() };
}
