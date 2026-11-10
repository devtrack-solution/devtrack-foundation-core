import type { INestApplication, InjectionToken } from '@nestjs/common';
import { ADMISSION_SERVICE } from '../src/core/presentation/http/admission/admission.tokens';
import type { AdmissionService } from '../src/core/presentation/http/admission/admission.service';
import { createAdmissionTestApp } from './fixtures/admission-app';

jest.setTimeout(60_000);

const DEPENDENCY = Symbol.for('foundation.test.admission-dependency');

/** Dependência obrigatória fictícia: o teste controla se ela responde. */
const dependency = { up: true };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function start(
  extra: { checks?: boolean } = {},
): Promise<INestApplication> {
  return createAdmissionTestApp({
    registration: {
      admission: { maxInFlight: 5, maxQueue: 5, maxQueueWaitMs: 500 },
      ...(extra.checks === true
        ? {
            readiness: {
              checks: [DEPENDENCY as InjectionToken],
              timeoutMs: 200,
            },
          }
        : {}),
    },
    providers: [
      {
        provide: DEPENDENCY,
        useValue: { check: () => Promise.resolve(dependency.up) },
      },
    ],
  });
}

describe('Health e drenagem', () => {
  beforeEach(() => {
    dependency.up = true;
  });

  it('live e ready respondem 200 em operação normal', async () => {
    const app = await start();
    const base = await app.getUrl();
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('ready vira 503 quando dependência obrigatória falha; live continua 200', async () => {
    const app = await start({ checks: true });
    const base = await app.getUrl();
    dependency.up = false;
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable' });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    dependency.up = true;
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    await app.close();
  });

  it('beginDrain: em voo termina dentro do prazo; novas recebem 503; ready falso; live 200', async () => {
    const app = await start();
    const base = await app.getUrl();
    const admission = app.get<AdmissionService>(ADMISSION_SERVICE);
    const inFlight = fetch(`${base}/work?ms=600`).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as unknown,
    }));
    await sleep(100);

    const drained = admission.beginDrain(3_000);

    const rejected = await fetch(`${base}/fast`);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    await rejected.arrayBuffer();
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    await ready.arrayBuffer();
    expect((await fetch(`${base}/health/live`)).status).toBe(200);

    expect(await inFlight).toEqual({ status: 200, body: { ok: true } });
    await expect(drained).resolves.toBe(true);
    expect(admission.snapshot()).toMatchObject({ draining: true, inFlight: 0 });
    await app.close();
  });

  it('beginDrain resolve false quando o prazo expira com trabalho em voo', async () => {
    const app = await start();
    const base = await app.getUrl();
    const admission = app.get<AdmissionService>(ADMISSION_SERVICE);
    const slow = fetch(`${base}/work?ms=1500`).then((r) => r.status);
    await sleep(100);
    await expect(admission.beginDrain(200)).resolves.toBe(false);
    expect(await slow).toBe(200);
    await app.close();
  });

  it('app.close() drena antes de fechar o servidor: em voo termina, novas recebem 503', async () => {
    const app = await start();
    const base = await app.getUrl();
    const inFlight = fetch(`${base}/work?ms=600`).then((r) => r.status);
    await sleep(100);

    const closing = app.close();
    await sleep(50);
    const during = await fetch(`${base}/fast`);
    expect(during.status).toBe(503);
    await during.arrayBuffer();

    expect(await inFlight).toBe(200);
    await closing;
  });
});
