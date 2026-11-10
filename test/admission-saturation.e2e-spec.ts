import type { INestApplication } from '@nestjs/common';
import { ADMISSION_SERVICE } from '../src/core/presentation/http/admission/admission.tokens';
import type { AdmissionService } from '../src/core/presentation/http/admission/admission.service';
import { createAdmissionTestApp } from './fixtures/admission-app';

jest.setTimeout(120_000);

const LIMITS = {
  maxInFlight: 5,
  maxQueue: 10,
  maxQueueWaitMs: 200,
  retryAfterSeconds: 2,
};

/** Coleta GC explícito sem processo filho (flag do V8 em tempo de execução). */
function forceGc(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const v8 = require('node:v8') as typeof import('node:v8');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vm = require('node:vm') as typeof import('node:vm');
  v8.setFlagsFromString('--expose_gc');
  (vm.runInNewContext('gc') as () => void)();
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Outcome {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly elapsedMs: number;
}

describe('Admissão sob saturação sustentada', () => {
  let app: INestApplication;
  let base: string;
  let admission: AdmissionService;

  beforeAll(async () => {
    app = await createAdmissionTestApp({
      registration: { admission: LIMITS },
    });
    base = await app.getUrl();
    admission = app.get<AdmissionService>(ADMISSION_SERVICE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejeita o excedente rapidamente, sem passar do limite de fila nem de concorrência', async () => {
    const outcomes: Outcome[] = [];
    let maxQueueDepth = 0;
    let maxInFlight = 0;
    const sampler = setInterval(() => {
      const snapshot = admission.snapshot();
      maxQueueDepth = Math.max(maxQueueDepth, snapshot.queueDepth);
      maxInFlight = Math.max(maxInFlight, snapshot.inFlight);
    }, 5);

    const pending: Promise<void>[] = [];
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      for (let i = 0; i < 40; i += 1) {
        const begin = Date.now();
        pending.push(
          fetch(`${base}/work?ms=100`).then(async (response) => {
            await response.arrayBuffer();
            outcomes.push({
              status: response.status,
              retryAfter: response.headers.get('retry-after'),
              elapsedMs: Date.now() - begin,
            });
          }),
        );
      }
      await sleep(100);
    }
    await Promise.all(pending);
    clearInterval(sampler);

    const accepted = outcomes.filter((o) => o.status === 200);
    const rejected = outcomes.filter((o) => o.status === 503);
    const other = outcomes.filter((o) => o.status !== 200 && o.status !== 503);
    const rejectedMedianMs = median(rejected.map((o) => o.elapsedMs));
    const snapshot = admission.snapshot();

    console.log(
      JSON.stringify({
        offered: outcomes.length,
        accepted: accepted.length,
        rejected: rejected.length,
        other: other.length,
        rejectedMedianMs,
        maxQueueDepthObserved: maxQueueDepth,
        maxInFlightObserved: maxInFlight,
        counters: {
          admitted: snapshot.admitted,
          queued: snapshot.queued,
          rejectedQueueFull: snapshot.rejectedQueueFull,
          rejectedQueueTimeout: snapshot.rejectedQueueTimeout,
        },
      }),
    );

    expect(other).toHaveLength(0);
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((o) => o.retryAfter === '2')).toBe(true);
    expect(maxQueueDepth).toBeLessThanOrEqual(LIMITS.maxQueue);
    expect(maxInFlight).toBeLessThanOrEqual(LIMITS.maxInFlight);
    // Rejeição é imediata (fila cheia) ou no máximo no prazo de espera (fila expirada).
    expect(rejectedMedianMs).toBeLessThan(LIMITS.maxQueueWaitMs + 100);
    // Toda rejeição 503 veio da admissão e foi contada uma única vez.
    expect(snapshot.rejectedQueueFull + snapshot.rejectedQueueTimeout).toBe(
      rejected.length,
    );
  });

  it('memória volta ao patamar após a carga, sem acumulação de fila', async () => {
    forceGc();
    const before = process.memoryUsage().heapUsed;
    const pending: Promise<unknown>[] = [];
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 60; i += 1)
        pending.push(fetch(`${base}/work?ms=50`).then((r) => r.arrayBuffer()));
      await sleep(60);
    }
    await Promise.all(pending);
    await sleep(100);
    forceGc();
    const after = process.memoryUsage().heapUsed;
    const growthMb = (after - before) / (1024 * 1024);
    console.log(
      JSON.stringify({
        heapBeforeMb: round1(before),
        heapAfterMb: round1(after),
        growthMb: round1(growthMb),
      }),
    );
    expect(growthMb).toBeLessThan(20);
    expect(admission.snapshot()).toMatchObject({ inFlight: 0, queueDepth: 0 });
  });

  it('recupera: após a carga, requisições voltam a 200 sem reinício', async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await fetch(`${base}/fast`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
  });
});

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round1(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}
