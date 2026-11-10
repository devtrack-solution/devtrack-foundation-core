import type { JobQueue } from '../activities/job-queue.port';
import type { JobEnvelope } from '../execution/job-envelope';
import type { ClaimedOutboxMessage, OutboxSnapshot } from './outbox.model';
import type { ClaimInput, MarkFailedInput, OutboxStore } from './outbox.ports';
import {
  OutboxRelay,
  OutboxRelayConfigError,
  type OutboxRelayOptions,
} from './outbox-relay';

type MemoryRow = Omit<ClaimedOutboxMessage, 'attempts'> & {
  attempts: number;
  state: string;
  nextAt: number;
  lastError: string | null;
};

class MemoryStore implements OutboxStore {
  readonly rows: MemoryRow[] = [];
  claimDue(input: ClaimInput): Promise<readonly ClaimedOutboxMessage[]> {
    const due = this.rows
      .filter((r) => r.state === 'pending' && r.nextAt <= input.now)
      .slice(0, input.limit);
    for (const row of due) {
      row.attempts += 1;
      row.nextAt = input.now + input.leaseMs;
    }
    return Promise.resolve(due.map((row) => ({ ...row })));
  }
  markPublished(input: { id: string }): Promise<void> {
    const row = this.rows.find((r) => r.id === input.id);
    if (row !== undefined && row.state === 'pending') row.state = 'published';
    return Promise.resolve();
  }
  markFailed(input: MarkFailedInput): Promise<void> {
    const row = this.rows.find((r) => r.id === input.id);
    if (
      row !== undefined &&
      row.state === 'pending' &&
      row.attempts === input.attempts
    ) {
      row.state = input.terminal ? 'failed' : 'pending';
      row.lastError = input.errorCode;
      row.nextAt = input.nextAttemptAt;
    }
    return Promise.resolve();
  }
  snapshot(): Promise<OutboxSnapshot> {
    return Promise.resolve({
      pending: 0,
      failed: 0,
      oldestPendingAgeMs: null,
      maxPendingAttempts: 0,
    });
  }
}

function message(id: string, overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id,
    type: 'orders.created',
    payloadVersion: 1,
    payload: { id },
    subjectId: 'subject-1',
    correlationId: `corr-${id}`,
    attempts: 0,
    createdAt: 0,
    state: 'pending',
    nextAt: 0,
    lastError: null,
    ...overrides,
  };
}

const options: OutboxRelayOptions = {
  batchSize: 10,
  maxPublishPerSecond: 100,
  leaseMs: 1_000,
  maxAttempts: 3,
  backoff: { baseMs: 100, maxMs: 300 },
  envelope: { deadlineMs: 60_000, maxAttempts: 3 },
};

function clockAt(start: number) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('OutboxRelay', () => {
  it('publica com o id da mensagem como id do envelope e marca published', async () => {
    const store = new MemoryStore();
    store.rows.push(message('m1'));
    const sent: JobEnvelope<unknown>[] = [];
    const queue: JobQueue = {
      enqueue: (e) => {
        sent.push(e);
        return Promise.resolve('accepted');
      },
    };
    const relay = new OutboxRelay(
      { store, queue, clock: clockAt(1_000) },
      options,
    );

    const report = await relay.drainOnce();

    expect(report).toEqual({
      claimed: 1,
      published: 1,
      retryScheduled: 0,
      failed: 0,
      rateLimited: false,
    });
    expect(sent[0]).toMatchObject({
      id: 'm1',
      type: 'orders.created',
      deadlineAt: 61_000,
      maxAttempts: 3,
    });
    expect(store.rows[0]?.state).toBe('published');
  });

  it('falha do broker mantém pending com backoff limitado e vai a failed ao esgotar tentativas', async () => {
    const store = new MemoryStore();
    store.rows.push(message('m2'));
    const queue: JobQueue = {
      enqueue: () => Promise.reject(new Error('down')),
    };
    const clock = clockAt(1_000);
    const relay = new OutboxRelay({ store, queue, clock }, options);

    expect(await relay.drainOnce()).toMatchObject({ retryScheduled: 1 });
    expect(store.rows[0]).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastError: 'BROKER_UNAVAILABLE',
      nextAt: 1_100,
    });

    clock.advance(10_000);
    await relay.drainOnce();
    clock.advance(10_000);
    await relay.drainOnce();
    expect(store.rows[0]).toMatchObject({
      state: 'failed',
      attempts: 3,
      lastError: 'MAX_ATTEMPTS_EXCEEDED',
    });
  });

  it('respeita o limite de lote e de taxa dentro da mesma janela', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i += 1) store.rows.push(message(`b${i}`));
    const queue: JobQueue = { enqueue: () => Promise.resolve('accepted') };
    const clock = clockAt(5_000);
    const relay = new OutboxRelay(
      { store, queue, clock },
      { ...options, batchSize: 4, maxPublishPerSecond: 4 },
    );

    expect(await relay.drainOnce()).toMatchObject({ claimed: 4, published: 4 });
    expect(await relay.drainOnce()).toMatchObject({
      claimed: 0,
      rateLimited: true,
    });
    clock.advance(1_000);
    expect(await relay.drainOnce()).toMatchObject({ claimed: 1, published: 1 });
  });

  it('erro ao marcar published propaga (crash simulado) e a mensagem segue reivindicável após o lease', async () => {
    const store = new MemoryStore();
    store.rows.push(message('m3'));
    const original = store.markPublished.bind(store) as (input: {
      id: string;
    }) => Promise<void>;
    let crash = true;
    store.markPublished = (input) =>
      crash ? Promise.reject(new Error('crash')) : original(input);
    const queue: JobQueue = { enqueue: () => Promise.resolve('accepted') };
    const clock = clockAt(0);
    const relay = new OutboxRelay({ store, queue, clock }, options);

    await expect(relay.drainOnce()).rejects.toThrow('crash');
    expect(store.rows[0]?.state).toBe('pending');
    crash = false;
    clock.advance(1_000);
    expect(await relay.drainOnce()).toMatchObject({ published: 1 });
  });

  it('rejeita configuração fora dos limites', () => {
    const store = new MemoryStore();
    const queue: JobQueue = { enqueue: () => Promise.resolve('accepted') };
    expect(
      () =>
        new OutboxRelay(
          { store, queue, clock: clockAt(0) },
          { ...options, batchSize: 0 },
        ),
    ).toThrow(OutboxRelayConfigError);
    expect(
      () =>
        new OutboxRelay(
          { store, queue, clock: clockAt(0) },
          { ...options, backoff: { baseMs: 500, maxMs: 100 } },
        ),
    ).toThrow(OutboxRelayConfigError);
  });
});
