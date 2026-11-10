/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  JobQueue,
  EnqueueOutcome,
} from '../src/core/application/activities/job-queue.port';
import type { JobEnvelope } from '../src/core/application/execution/job-envelope';
import type { OperationContext } from '../src/core/application/context/operation-context';
import type { OutboxIntent } from '../src/core/application/outbox/outbox.model';
import type { OutboxStore } from '../src/core/application/outbox/outbox.ports';
import {
  InboxGuard,
  type InboxResources,
} from '../src/core/application/outbox/inbox-guard';
import {
  OutboxRelay,
  type OutboxRelayOptions,
} from '../src/core/application/outbox/outbox-relay';
import { ExternalEffectRunner } from '../src/core/application/outbox/external-effect';
import { IdempotencyService } from '../src/core/application/idempotency/idempotency.service';
import { IdempotencyOutcomeUnknownError } from '../src/core/application/idempotency/idempotency.errors';
import type {
  ExternalOutcomeReconciler,
  IdempotentOperation,
} from '../src/core/application/idempotency/idempotency.types';
import { NODE_IDEMPOTENCY_CRYPTO } from '../src/core/presentation/http/idempotency/node-idempotency-crypto';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  TypeOrmUnitOfWork,
  type PersistenceCatalog,
} from '../src/native/persistence-typeorm';
import { TypeOrmIdempotencyStore } from '../src/native/persistence-typeorm/idempotency';
import {
  TypeOrmInboxStore,
  TypeOrmOutboxStore,
  TypeOrmOutboxWriter,
} from '../src/native/persistence-typeorm/outbox';
import { OUTBOX_FIXTURE_ORDERS_TABLE } from './fixtures/outbox-business';
import { OUTBOX_TEST_CONTRIBUTIONS } from './fixtures/outbox-catalog';

jest.setTimeout(300_000);

const PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_outbox';
const BASE_OPTIONS: OutboxRelayOptions = {
  batchSize: 5,
  maxPublishPerSecond: 10_000,
  leaseMs: 1_000,
  maxAttempts: 3,
  backoff: { baseMs: 1, maxMs: 5 },
  envelope: { deadlineMs: 60_000, maxAttempts: 3 },
};

let container: StartedPostgreSqlContainer;
let catalog: PersistenceCatalog;
let admin: DataSource;
const sources: DataSource[] = [];

async function replica(applicationName: string): Promise<DataSource> {
  const dataSource = createMigrationDataSource(catalog, {
    host: container.getHost(),
    port: container.getPort(),
    database: DATABASE,
    username: container.getUsername(),
    password: PASSWORD,
    applicationName,
    poolMax: 4,
  });
  await dataSource.initialize();
  sources.push(dataSource);
  return dataSource;
}

function realClock(): { now: () => number } {
  return { now: () => Date.now() };
}

function intent(id: string, name = `order-${id}`): OutboxIntent {
  return {
    id,
    type: 'orders.created',
    payloadVersion: 1,
    payload: { name },
    subjectId: 'subject-1',
    tenantId: 'tenant-1',
    correlationId: `corr-${id}`,
    traceContext: {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    },
  };
}

/** Fila em memória que registra cada publicação; `failNext` simula broker indisponível. */
class RecordingQueue implements JobQueue {
  readonly enqueued: string[] = [];
  failNext = 0;
  async enqueue(envelope: JobEnvelope<unknown>): Promise<EnqueueOutcome> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('broker_down');
    }
    this.enqueued.push(envelope.id);
    return 'accepted';
  }
}

/** Store que simula crash logo após o publish: `markPublished` falha na primeira chamada. */
function crashingOnFirstMark(store: OutboxStore): OutboxStore {
  let crashed = false;
  return {
    claimDue: (input) => store.claimDue(input),
    markFailed: (input) => store.markFailed(input),
    snapshot: (now) => store.snapshot(now),
    markPublished: async (input) => {
      if (!crashed) {
        crashed = true;
        throw new Error('process_crashed_before_mark');
      }
      await store.markPublished(input);
    },
  };
}

function unitOfWorkFor(ds: DataSource, clock: { now: () => number }) {
  return new TypeOrmUnitOfWork(ds, (manager: EntityManager) => ({
    outbox: new TypeOrmOutboxWriter(manager, clock),
    inbox: new TypeOrmInboxStore(manager),
    manager,
  }));
}

async function countRows(ds: DataSource, table: string): Promise<number> {
  const [row] = await ds.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${table}"`,
  );
  return row?.n ?? 0;
}

async function outboxRow(ds: DataSource, id: string) {
  const [row] = await ds.query<
    {
      state: string;
      attempts: number;
      last_error_code: string | null;
    }[]
  >(
    `SELECT "state", "attempts", "last_error_code" FROM "outbox_messages" WHERE "id" = $1`,
    [id],
  );
  return row;
}

beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(DATABASE)
      .withUsername('foundation')
      .withPassword(PASSWORD)
      .start();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (PostgreSQL 16). Cause: ${cause}`,
    );
  }
  catalog = buildPersistenceCatalog(OUTBOX_TEST_CONTRIBUTIONS);
  admin = await replica('outbox-admin');
  await admin.runMigrations();
});

beforeEach(async () => {
  // Cada teste começa sem linhas de outros testes: o lote e a ordem de entrega dependem disso.
  await admin.query(
    `TRUNCATE "outbox_messages", "inbox_messages", "${OUTBOX_FIXTURE_ORDERS_TABLE}"`,
  );
});

afterAll(async () => {
  for (const source of sources) {
    if (source.isInitialized) await source.destroy();
  }
  await container?.stop();
});

describe('Outbox com PostgreSQL real', () => {
  it('atomicidade: commit grava negócio e outbox; exceção desfaz ambos', async () => {
    const ds = await replica('atomic');
    const clock = realClock();
    const uow = unitOfWorkFor(ds, clock);

    await uow.run(async ({ manager, outbox }) => {
      await manager.query(
        `INSERT INTO "${OUTBOX_FIXTURE_ORDERS_TABLE}" ("name", "created_at_ms") VALUES ('ok', $1)`,
        [clock.now()],
      );
      await outbox.append(intent('atomic-commit'));
    });
    expect(await outboxRow(ds, 'atomic-commit')).toMatchObject({
      state: 'pending',
      attempts: 0,
    });

    const before = await countRows(ds, OUTBOX_FIXTURE_ORDERS_TABLE);
    await expect(
      uow.run(async ({ manager, outbox }) => {
        await manager.query(
          `INSERT INTO "${OUTBOX_FIXTURE_ORDERS_TABLE}" ("name", "created_at_ms") VALUES ('rolled', $1)`,
          [clock.now()],
        );
        await outbox.append(intent('atomic-rollback'));
        throw new Error('business_failure');
      }),
    ).rejects.toThrow('business_failure');
    expect(await countRows(ds, OUTBOX_FIXTURE_ORDERS_TABLE)).toBe(before);
    expect(await outboxRow(ds, 'atomic-rollback')).toBeUndefined();
  });

  it('intenção inválida dentro do UoW desfaz a escrita de negócio', async () => {
    const ds = await replica('atomic-invalid');
    const clock = realClock();
    const uow = unitOfWorkFor(ds, clock);
    const before = await countRows(ds, OUTBOX_FIXTURE_ORDERS_TABLE);
    await expect(
      uow.run(async ({ manager, outbox }) => {
        await manager.query(
          `INSERT INTO "${OUTBOX_FIXTURE_ORDERS_TABLE}" ("name", "created_at_ms") VALUES ('x', $1)`,
          [clock.now()],
        );
        await outbox.append({ ...intent('bad-type'), type: 'Orders Created' });
      }),
    ).rejects.toThrow('outbox_invalid:type');
    expect(await countRows(ds, OUTBOX_FIXTURE_ORDERS_TABLE)).toBe(before);
  });

  it('relays concorrentes sobre o mesmo banco publicam cada mensagem exatamente uma vez', async () => {
    const writer = await replica('writer');
    const clock = realClock();
    const uow = unitOfWorkFor(writer, clock);
    const total = 60;
    await uow.run(async ({ outbox }) => {
      for (let i = 0; i < total; i += 1)
        await outbox.append(intent(`conc-${i}`));
    });

    const queue = new RecordingQueue();
    const relayA = new OutboxRelay(
      { store: new TypeOrmOutboxStore(await replica('relay-a')), queue, clock },
      BASE_OPTIONS,
    );
    const relayB = new OutboxRelay(
      { store: new TypeOrmOutboxStore(await replica('relay-b')), queue, clock },
      BASE_OPTIONS,
    );

    const drain = async (relay: OutboxRelay): Promise<void> => {
      for (;;) {
        const report = await relay.drainOnce();
        if (report.claimed === 0) return;
      }
    };
    await Promise.all([drain(relayA), drain(relayB)]);

    const concurrent = queue.enqueued.filter((id) => id.startsWith('conc-'));
    expect(new Set(concurrent).size).toBe(total);
    expect(concurrent.length).toBe(total);
    const snapshot = await relayA.snapshot();
    expect(snapshot).toMatchObject({
      pending: 0,
      failed: 0,
      oldestPendingAgeMs: null,
    });
  });

  it('recuperação: relay morto no meio do lote deixa mensagens que outro relay retoma', async () => {
    const ds = await replica('recovery');
    const clock = realClock();
    const uow = unitOfWorkFor(ds, clock);
    await uow.run(async ({ outbox }) => {
      for (let i = 0; i < 10; i += 1)
        await outbox.append(intent(`recover-${i}`));
    });

    // Relay A reivindica o lote e cai antes de publicar.
    const crashed = new TypeOrmOutboxStore(await replica('crashed-relay'));
    const claimed = await crashed.claimDue({
      now: clock.now(),
      limit: 10,
      leaseMs: 1_000,
    });
    expect(claimed.length).toBe(10);

    const queue = new RecordingQueue();
    const survivor = new OutboxRelay(
      {
        store: new TypeOrmOutboxStore(await replica('survivor')),
        queue,
        clock,
      },
      { ...BASE_OPTIONS, batchSize: 10 },
    );
    const during = await survivor.drainOnce();
    expect(during.claimed).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const after = await survivor.drainOnce();
    expect(after).toMatchObject({ claimed: 10, published: 10 });
    expect(await outboxRow(ds, 'recover-0')).toMatchObject({
      state: 'published',
      attempts: 2,
    });
  });

  it('publicação repetida: crash entre publicar e marcar; consumidor com inbox aplica o efeito uma vez', async () => {
    const ds = await replica('repeat');
    const clock = realClock();
    const uow = unitOfWorkFor(ds, clock);
    await uow.run(async ({ outbox }) => {
      await outbox.append(intent('repeat-1'));
    });

    const queue = new RecordingQueue();
    const crashing = new OutboxRelay(
      {
        store: crashingOnFirstMark(
          new TypeOrmOutboxStore(await replica('repeat-crash')),
        ),
        queue,
        clock,
      },
      BASE_OPTIONS,
    );
    await expect(crashing.drainOnce()).rejects.toThrow(
      'process_crashed_before_mark',
    );
    expect(await outboxRow(ds, 'repeat-1')).toMatchObject({ state: 'pending' });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const retry = new OutboxRelay(
      {
        store: new TypeOrmOutboxStore(await replica('repeat-retry')),
        queue,
        clock,
      },
      BASE_OPTIONS,
    );
    await retry.drainOnce();
    expect(queue.enqueued.filter((id) => id === 'repeat-1')).toHaveLength(2);
    expect(await outboxRow(ds, 'repeat-1')).toMatchObject({
      state: 'published',
    });

    // Consumidor recebe a mesma mensagem duas vezes.
    const inbox = new InboxGuard(
      new TypeOrmUnitOfWork(
        ds,
        (
          manager: EntityManager,
        ): InboxResources & { manager: EntityManager } => ({
          inbox: new TypeOrmInboxStore(manager),
          manager,
        }),
      ),
      clock,
    );
    const effect = async ({
      manager,
    }: {
      manager: EntityManager;
    }): Promise<void> => {
      await manager.query(
        `INSERT INTO "${OUTBOX_FIXTURE_ORDERS_TABLE}" ("name", "created_at_ms") VALUES ('repeat', $1)`,
        [clock.now()],
      );
    };
    const first = await inbox.applyOnce(
      { consumerId: 'billing', messageId: 'repeat-1' },
      effect,
    );
    const second = await inbox.applyOnce(
      { consumerId: 'billing', messageId: 'repeat-1' },
      effect,
    );
    expect(first).toEqual({ applied: true, result: undefined });
    expect(second).toEqual({ applied: false });
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${OUTBOX_FIXTURE_ORDERS_TABLE}" WHERE "name" = 'repeat'`,
    );
    expect(n).toBe(1);

    // Outro consumidor processa a mesma mensagem: deduplicação é por consumidor.
    const other = await inbox.applyOnce(
      { consumerId: 'shipping', messageId: 'repeat-1' },
      effect,
    );
    expect(other.applied).toBe(true);
  });

  it('falha de broker mantém a intenção pending com tentativas crescentes e depois vai a failed', async () => {
    const ds = await replica('broker-fail');
    const clock = realClock();
    await unitOfWorkFor(ds, clock).run(async ({ outbox }) => {
      await outbox.append(intent('fail-1'));
    });
    const queue = new RecordingQueue();
    queue.failNext = 10;
    const relay = new OutboxRelay(
      {
        store: new TypeOrmOutboxStore(await replica('broker-relay')),
        queue,
        clock,
      },
      BASE_OPTIONS,
    );

    const first = await relay.drainOnce();
    expect(first).toMatchObject({
      claimed: 1,
      published: 0,
      retryScheduled: 1,
    });
    expect(await outboxRow(ds, 'fail-1')).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error_code: 'BROKER_UNAVAILABLE',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await relay.drainOnce();
    expect(await outboxRow(ds, 'fail-1')).toMatchObject({
      state: 'pending',
      attempts: 2,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const last = await relay.drainOnce();
    expect(last).toMatchObject({ failed: 1 });
    expect(await outboxRow(ds, 'fail-1')).toMatchObject({
      state: 'failed',
      attempts: 3,
      last_error_code: 'MAX_ATTEMPTS_EXCEEDED',
    });
    expect(await relay.snapshot()).toMatchObject({ failed: 1 });
  });

  it('envelope inválido grava falha terminal ENVELOPE_INVALID sem publicar', async () => {
    const ds = await replica('invalid-row');
    await ds.query(
      `INSERT INTO "outbox_messages" ("id","type","payload_version","payload","subject_id","correlation_id","state","attempts","next_attempt_at_ms","created_at_ms","updated_at_ms")
       VALUES ('invalid-envelope', 'Bad Type', 1, '{}'::jsonb, 'subject-1', 'corr-1', 'pending', 0, 0, 0, 0)`,
    );
    const queue = new RecordingQueue();
    const relay = new OutboxRelay(
      {
        store: new TypeOrmOutboxStore(await replica('invalid-relay')),
        queue,
        clock: realClock(),
      },
      BASE_OPTIONS,
    );
    const report = await relay.drainOnce();
    expect(report).toMatchObject({ failed: 1, published: 0 });
    expect(queue.enqueued).not.toContain('invalid-envelope');
    expect(await outboxRow(ds, 'invalid-envelope')).toMatchObject({
      state: 'failed',
      last_error_code: 'ENVELOPE_INVALID',
    });
  });

  it('limite de taxa por segundo impede reivindicações excedentes na mesma janela', async () => {
    const ds = await replica('rate');
    let now = 1_000_000;
    const clock = { now: () => now };
    await unitOfWorkFor(ds, clock).run(async ({ outbox }) => {
      for (let i = 0; i < 10; i += 1) await outbox.append(intent(`rate-${i}`));
    });
    const queue = new RecordingQueue();
    const relay = new OutboxRelay(
      {
        store: new TypeOrmOutboxStore(await replica('rate-relay')),
        queue,
        clock,
      },
      { ...BASE_OPTIONS, batchSize: 10, maxPublishPerSecond: 3 },
    );
    expect(await relay.drainOnce()).toMatchObject({ claimed: 3, published: 3 });
    expect(await relay.drainOnce()).toMatchObject({
      claimed: 0,
      rateLimited: true,
    });
    now += 1_000;
    expect(await relay.drainOnce()).toMatchObject({ claimed: 3, published: 3 });
  });

  describe('efeito externo incerto', () => {
    const context: OperationContext = {
      correlationId: 'corr-ext',
      principal: { subjectId: 'subject-ext', permissions: [] },
      deadlineAt: 10_000_000,
    };
    const operation: IdempotentOperation<{ amount: number }> = {
      policy: { operationId: 'payments.charge', retentionMs: 60_000 },
      authorize: async () => undefined,
    };

    async function runnerFor(name: string) {
      const ds = await replica(name);
      const service = new IdempotencyService({
        store: new TypeOrmIdempotencyStore(ds),
        crypto: NODE_IDEMPOTENCY_CRYPTO,
        clock: realClock(),
        leaseMs: 5_000,
      });
      return new ExternalEffectRunner(service, NODE_IDEMPOTENCY_CRYPTO);
    }

    it('falha ambígua grava outcome_unknown e não reexecuta sozinha', async () => {
      const runner = await runnerFor('ext-unknown');
      let calls = 0;
      const provider = async (): Promise<{ charged: boolean }> => {
        calls += 1;
        throw new Error('socket_timeout_after_send');
      };
      await expect(
        runner.run(
          context,
          operation,
          'charge-ambiguous',
          { amount: 10 },
          provider,
        ),
      ).rejects.toThrow('socket_timeout_after_send');
      expect(calls).toBe(1);

      await expect(
        runner.run(
          context,
          operation,
          'charge-ambiguous',
          { amount: 10 },
          provider,
        ),
      ).rejects.toBeInstanceOf(IdempotencyOutcomeUnknownError);
      expect(calls).toBe(1);
    });

    it('reconciliação confirmada grava o resultado e replays não chamam o provedor', async () => {
      const runner = await runnerFor('ext-confirm');
      let calls = 0;
      const provider = async (): Promise<{ charged: boolean }> => {
        calls += 1;
        throw new Error('connection_reset');
      };
      await expect(
        runner.run(
          context,
          operation,
          'charge-confirm',
          { amount: 5 },
          provider,
        ),
      ).rejects.toThrow();
      const reconciler: ExternalOutcomeReconciler = {
        reconcile: async () => ({
          outcome: 'confirmed',
          result: { charged: true },
        }),
      };
      expect(
        await runner.reconcile(
          context,
          operation,
          'charge-confirm',
          reconciler,
        ),
      ).toBe('completed');
      const replay = await runner.run(
        context,
        operation,
        'charge-confirm',
        { amount: 5 },
        provider,
      );
      expect(replay).toEqual({ result: { charged: true }, replayed: true });
      expect(calls).toBe(1);
    });

    it('reconciliação "não realizado" libera nova tentativa; "não resolvido" mantém bloqueio', async () => {
      const runner = await runnerFor('ext-release');
      let calls = 0;
      let fail = true;
      const provider = async (): Promise<{ charged: boolean }> => {
        calls += 1;
        if (fail) throw new Error('timeout');
        return { charged: true };
      };
      await expect(
        runner.run(
          context,
          operation,
          'charge-release',
          { amount: 7 },
          provider,
        ),
      ).rejects.toThrow();

      expect(
        await runner.reconcile(context, operation, 'charge-release', {
          reconcile: async () => ({ outcome: 'unresolved' }),
        }),
      ).toBe('unresolved');
      await expect(
        runner.run(
          context,
          operation,
          'charge-release',
          { amount: 7 },
          provider,
        ),
      ).rejects.toBeInstanceOf(IdempotencyOutcomeUnknownError);
      expect(calls).toBe(1);

      expect(
        await runner.reconcile(context, operation, 'charge-release', {
          reconcile: async () => ({ outcome: 'not_performed' }),
        }),
      ).toBe('failed_retryable');
      fail = false;
      const retried = await runner.run(
        context,
        operation,
        'charge-release',
        { amount: 7 },
        provider,
      );
      expect(retried).toEqual({ result: { charged: true }, replayed: false });
      expect(calls).toBe(2);
    });
  });
});
