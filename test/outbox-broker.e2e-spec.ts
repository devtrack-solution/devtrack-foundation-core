import net from 'node:net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { Worker, type Job } from 'bullmq';
import type { DataSource, EntityManager } from 'typeorm';
import type { OutboxIntent } from '../src/core/application/outbox/outbox.model';
import { InboxGuard } from '../src/core/application/outbox/inbox-guard';
import {
  OutboxRelay,
  type OutboxRelayOptions,
} from '../src/core/application/outbox/outbox-relay';
import { createJobRetryPolicy } from '../src/core/application/activities/job-retry-policy';
import type { JobEnvelope } from '../src/core/application/execution/job-envelope';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  TypeOrmUnitOfWork,
  type PersistenceCatalog,
} from '../src/native/persistence-typeorm';
import {
  TypeOrmInboxStore,
  TypeOrmOutboxStore,
  TypeOrmOutboxWriter,
} from '../src/native/persistence-typeorm/outbox';
import { BullmqJobQueue } from '../src/native/queue-bullmq/bullmq-job-queue.adapter';
import type { ValidatedQueueBullmqOptions } from '../src/native/queue-bullmq/queue-bullmq.options';
import { OUTBOX_FIXTURE_ORDERS_TABLE } from './fixtures/outbox-business';
import { OUTBOX_TEST_CONTRIBUTIONS } from './fixtures/outbox-catalog';

jest.setTimeout(300_000);

const PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_outbox_broker';
const QUEUE = `outbox-test-${process.pid}-${Date.now()}`;
const OPTIONS: OutboxRelayOptions = {
  batchSize: 10,
  maxPublishPerSecond: 10_000,
  leaseMs: 1_000,
  maxAttempts: 50,
  backoff: { baseMs: 1, maxMs: 5 },
  envelope: { deadlineMs: 600_000, maxAttempts: 5 },
};

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let catalog: PersistenceCatalog;
let admin: DataSource;
let ds: DataSource;
let proxy: TcpProxy;
let proxyPort: number;
let queue: BullmqJobQueue;
let worker: Worker<JobEnvelope<unknown>, void, string>;
const processed: string[] = [];

/** Proxy TCP para o Redis real: fechar a porta simula broker indisponível sem parar o contêiner. */
class TcpProxy {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async start(port = 0): Promise<number> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.sockets.add(client).add(upstream);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      this.server
        ?.once('error', reject)
        .listen(port, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('proxy_address_unavailable');
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function intent(id: string): OutboxIntent {
  return {
    id,
    type: 'orders.created',
    payloadVersion: 1,
    payload: { id },
    subjectId: 'subject-1',
    correlationId: `corr-${id}`,
  };
}

const clock = { now: (): number => Date.now() };

function unitOfWork() {
  return new TypeOrmUnitOfWork(ds, (manager: EntityManager) => ({
    outbox: new TypeOrmOutboxWriter(manager, clock),
    inbox: new TypeOrmInboxStore(manager),
    manager,
  }));
}

async function businessRows(name: string): Promise<number> {
  const [row] = await ds.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${OUTBOX_FIXTURE_ORDERS_TABLE}" WHERE "name" = $1`,
    [name],
  );
  return row?.n ?? 0;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('wait_for_timeout');
}

beforeAll(async () => {
  try {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase(DATABASE)
        .withUsername('foundation')
        .withPassword(PASSWORD)
        .start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (PostgreSQL 16 / Redis 7). Cause: ${cause}`,
    );
  }
  catalog = buildPersistenceCatalog(OUTBOX_TEST_CONTRIBUTIONS);
  const connect = (name: string, poolMax: number): DataSource =>
    createMigrationDataSource(catalog, {
      host: postgres.getHost(),
      port: postgres.getPort(),
      database: DATABASE,
      username: postgres.getUsername(),
      password: PASSWORD,
      applicationName: name,
      poolMax,
    });
  admin = connect('broker-admin', 1);
  await admin.initialize();
  await admin.runMigrations();
  ds = connect('broker-app', 4);
  await ds.initialize();

  proxy = new TcpProxy(redis.getHost(), redis.getMappedPort(6379));
  proxyPort = await proxy.start();

  const validated: ValidatedQueueBullmqOptions = {
    connection: { host: '127.0.0.1', port: proxyPort },
    queueName: QUEUE,
    maxPayloadBytes: 65_536,
    retry: {
      globalMaxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      timeoutMs: 5_000,
    },
    consumer: {
      concurrency: 4,
      lockDurationMs: 30_000,
      stalledIntervalMs: 30_000,
      maxStalledCount: 3,
      drainDeadlineMs: 5_000,
    },
  };
  queue = new BullmqJobQueue(validated, createJobRetryPolicy(validated.retry));

  const inbox = new InboxGuard(unitOfWork(), clock);
  worker = new Worker<JobEnvelope<unknown>, void, string>(
    QUEUE,
    async (job: Job<JobEnvelope<unknown>>) => {
      const id = job.data.id;
      processed.push(id);
      await inbox.applyOnce(
        { consumerId: 'billing', messageId: id },
        async ({ manager }) => {
          await manager.query(
            `INSERT INTO "${OUTBOX_FIXTURE_ORDERS_TABLE}" ("name", "created_at_ms") VALUES ($1, $2)`,
            [id, clock.now()],
          );
        },
      );
    },
    {
      connection: {
        host: '127.0.0.1',
        port: proxyPort,
        maxRetriesPerRequest: null,
      },
      concurrency: 4,
    },
  );
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker?.close(true);
  await queue?.onModuleDestroy();
  await proxy?.stop();
  if (ds?.isInitialized) await ds.destroy();
  if (admin?.isInitialized) await admin.destroy();
  await postgres?.stop();
  await redis?.stop();
});

describe('Outbox com broker BullMQ real (Redis)', () => {
  it('broker indisponível após commit: pendência persiste, cresce em tentativas e é publicada ao voltar', async () => {
    await unitOfWork().run(async ({ outbox }) => {
      await outbox.append(intent('broker-1'));
      await outbox.append(intent('broker-2'));
    });
    const relay = new OutboxRelay(
      { store: new TypeOrmOutboxStore(ds), queue, clock },
      OPTIONS,
    );

    // Broker fora do ar: a porta fecha antes do envio.
    await proxy.stop();
    const down = await relay.drainOnce();
    expect(down.published).toBe(0);
    expect(down.retryScheduled + down.failed).toBeGreaterThanOrEqual(1);
    const [pendingRow] = await ds.query<
      { state: string; attempts: number; last_error_code: string }[]
    >(
      `SELECT "state", "attempts", "last_error_code" FROM "outbox_messages" WHERE "id" = 'broker-1'`,
    );
    expect(pendingRow).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error_code: 'BROKER_UNAVAILABLE',
    });
    expect(await relay.snapshot()).toMatchObject({ pending: 2, failed: 0 });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const again = await relay.drainOnce();
    expect(again.published).toBe(0);
    const [grown] = await ds.query<{ attempts: number }[]>(
      `SELECT "attempts" FROM "outbox_messages" WHERE "id" = 'broker-1'`,
    );
    expect(grown?.attempts).toBeGreaterThanOrEqual(2);
    expect(await relay.snapshot()).toMatchObject({ pending: 2 });

    // Broker volta: o relay publica e o consumidor processa.
    proxyPort = await proxy.start(proxyPort);
    await waitFor(async () => {
      await relay.drainOnce();
      return (await relay.snapshot()).pending === 0;
    });
    await waitFor(
      async () =>
        (await businessRows('broker-1')) === 1 &&
        (await businessRows('broker-2')) === 1,
    );
    expect(await relay.snapshot()).toMatchObject({ pending: 0, failed: 0 });
  });

  it('publicação repetida no broker real: broker deduplica pelo id e o consumidor aplica o efeito uma vez', async () => {
    await unitOfWork().run(async ({ outbox }) => {
      await outbox.append(intent('repeat-broker'));
    });
    const relay = new OutboxRelay(
      { store: new TypeOrmOutboxStore(ds), queue, clock },
      OPTIONS,
    );
    await waitFor(async () => {
      await relay.drainOnce();
      return (await businessRows('repeat-broker')) === 1;
    });

    // Crash simulado entre publicar e marcar: a linha volta a pendente e é publicada de novo.
    await ds.query(
      `UPDATE "outbox_messages" SET "state" = 'pending', "next_attempt_at_ms" = 0 WHERE "id" = 'repeat-broker'`,
    );
    const report = await relay.drainOnce();
    expect(report).toMatchObject({ claimed: 1, published: 1 });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await businessRows('repeat-broker')).toBe(1);
    expect(
      processed.filter((id) => id === 'repeat-broker').length,
    ).toBeLessThanOrEqual(1);
  });
});
