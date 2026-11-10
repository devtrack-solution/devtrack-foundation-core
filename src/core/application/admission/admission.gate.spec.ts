import { AdmissionGate, AdmissionRejectedError } from './admission.gate';

const limits = {
  maxInFlight: 2,
  maxQueue: 2,
  maxQueueWaitMs: 1_000,
  retryAfterSeconds: 1,
  drainDeadlineMs: 500,
};

function reasonOf(error: unknown): string {
  return error instanceof AdmissionRejectedError ? error.reason : 'other';
}

describe('AdmissionGate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('admite até maxInFlight sem fila e recusa a fila quando cheia', async () => {
    const gate = new AdmissionGate({ ...limits, maxQueue: 0 });
    const a = await gate.acquire();
    const b = await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({
      reason: 'queue_full',
    });
    expect(gate.snapshot()).toMatchObject({ inFlight: 2, queueDepth: 0 });
    a.permit.release();
    b.permit.release();
    expect(gate.snapshot().inFlight).toBe(0);
  });

  it('nunca ultrapassa o tamanho da fila (contador interno)', async () => {
    const gate = new AdmissionGate(limits);
    await gate.acquire();
    await gate.acquire();
    const waiting = [gate.acquire(), gate.acquire()];
    const overflow = await Promise.allSettled([
      gate.acquire(),
      gate.acquire(),
      gate.acquire(),
    ]);
    expect(gate.snapshot().queueDepth).toBe(2);
    expect(overflow.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      overflow.map((r) => reasonOf((r as PromiseRejectedResult).reason)),
    ).toEqual(['queue_full', 'queue_full', 'queue_full']);
    expect(gate.snapshot().rejectedQueueFull).toBe(3);
    for (const pending of waiting) pending.catch(() => undefined);
  });

  it('entrega a vaga liberada ao próximo da fila e informa o tempo de espera', async () => {
    const gate = new AdmissionGate(limits);
    const first = await gate.acquire();
    await gate.acquire();
    const queued = gate.acquire();
    jest.advanceTimersByTime(250);
    first.permit.release();
    const grant = await queued;
    expect(grant.queued).toBe(true);
    expect(grant.waitedMs).toBe(250);
    expect(gate.snapshot()).toMatchObject({
      inFlight: 2,
      queueDepth: 0,
      admitted: 3,
    });
  });

  it('rejeita por prazo de espera e remove da fila', async () => {
    const gate = new AdmissionGate(limits);
    await gate.acquire();
    await gate.acquire();
    const waiting = gate.acquire();
    jest.advanceTimersByTime(1_000);
    await expect(waiting).rejects.toMatchObject({ reason: 'queue_timeout' });
    expect(gate.snapshot()).toMatchObject({
      queueDepth: 0,
      rejectedQueueTimeout: 1,
    });
  });

  it('libera vaga apenas uma vez mesmo com release repetido', async () => {
    const gate = new AdmissionGate(limits);
    const grant = await gate.acquire();
    grant.permit.release();
    grant.permit.release();
    expect(gate.snapshot().inFlight).toBe(0);
  });

  it('drenagem rejeita novas entradas e esperas da fila imediatamente', async () => {
    const gate = new AdmissionGate(limits);
    await gate.acquire();
    await gate.acquire();
    const waiting = gate.acquire();
    gate.beginDrain();
    await expect(waiting).rejects.toMatchObject({ reason: 'draining' });
    await expect(gate.acquire()).rejects.toMatchObject({ reason: 'draining' });
    expect(gate.snapshot()).toMatchObject({
      draining: true,
      rejectedDraining: 2,
    });
  });

  it('drain aguarda as vagas em voo e resolve true ao ficar ocioso', async () => {
    const gate = new AdmissionGate(limits);
    const grant = await gate.acquire();
    gate.beginDrain();
    const drained = gate.drain(500);
    jest.advanceTimersByTime(100);
    grant.permit.release();
    await expect(drained).resolves.toBe(true);
  });

  it('drain resolve false quando o prazo expira com trabalho em voo', async () => {
    const gate = new AdmissionGate(limits);
    await gate.acquire();
    gate.beginDrain();
    const drained = gate.drain(500);
    jest.advanceTimersByTime(500);
    await expect(drained).resolves.toBe(false);
  });

  it('drain sem trabalho em voo resolve imediatamente', async () => {
    const gate = new AdmissionGate(limits);
    gate.beginDrain();
    await expect(gate.drain(500)).resolves.toBe(true);
  });
});
