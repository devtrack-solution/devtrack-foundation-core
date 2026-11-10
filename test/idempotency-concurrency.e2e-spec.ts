import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';
import type { OperationContext } from '../src/core/application/context/operation-context';
import {
  IdempotencyInProgressError,
  IdempotencyOutcomeUnknownError,
  IdempotencyStaleClaimError,
} from '../src/core/application/idempotency/idempotency.errors';
import { contextualKeyOf } from '../src/core/application/idempotency/idempotency.key';
import { IdempotencyService } from '../src/core/application/idempotency/idempotency.service';
import type {
  IdempotentLease,
  IdempotentOperation,
  IdempotencyUnitOfWorkResources,
  JsonValue,
} from '../src/core/application/idempotency/idempotency.types';
import type { UnitOfWork } from '../src/core/application/persistence/unit-of-work.port';
import { NODE_IDEMPOTENCY_CRYPTO } from '../src/core/presentation/http/idempotency/node-idempotency-crypto';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  TypeOrmUnitOfWork,
  type PersistenceCatalog,
} from '../src/native/persistence-typeorm';
import { TypeOrmAuditWriter } from '../src/native/persistence-typeorm/audit';
import {
  IDEMPOTENCY_RECORDS_TABLE,
  TypeOrmIdempotencyStore,
} from '../src/native/persistence-typeorm/idempotency';
import { IDEMPOTENCY_FIXTURE_CONTACTS_TABLE } from './fixtures/idempotency-business';
import { IDEMPOTENCY_TEST_CONTRIBUTIONS } from './fixtures/idempotency-catalog';

jest.setTimeout(300_000);

const ADMIN_PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_idempotency_concurrency';
const RETENTION = 600_000;
const LEASE = 5_000;
const ROUNDS = 20;
const PAYLOAD = { name: 'Ana' };

type ContactResult = { id: string };
type ExecutionOutcome = { result: ContactResult; replayed: boolean };

interface BusinessResources extends IdempotencyUnitOfWorkResources {
  readonly contacts: {
    insert(intentKey: string, name: string): Promise<void>;
  };
}

let container: StartedPostgreSqlContainer;
let catalog: PersistenceCatalog;
const sources: DataSource[] = [];

async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(DATABASE)
      .withUsername('foundation')
      .withPassword(ADMIN_PASSWORD)
      .start();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (PostgreSQL 16). Make sure the Docker daemon is running. Cause: ${cause}`,
    );
  }
}

/** Cada DataSource é uma réplica: pool próprio, sobre o mesmo banco. */
async function replica(applicationName: string): Promise<DataSource> {
  const dataSource = createMigrationDataSource(catalog, {
    host: container.getHost(),
    port: container.getPort(),
    database: DATABASE,
    username: container.getUsername(),
    password: ADMIN_PASSWORD,
    applicationName,
    poolMax: 4,
  });
  await dataSource.initialize();
  sources.push(dataSource);
  return dataSource;
}

function clockAt(start: number) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function contextOf(subjectId: string, tenantId: string): OperationContext {
  return {
    correlationId: `corr-${subjectId}`,
    principal: { subjectId, tenantId, permissions: ['contacts:write'] },
    deadlineAt: 10_000_000,
  };
}

const operation: IdempotentOperation<{ name: string }> = {
  policy: { operationId: 'contacts.create', retentionMs: RETENTION },
  authorize: () => Promise.resolve(),
};

/** UnitOfWork de uma réplica: negócio, auditoria e conclusão no mesmo EntityManager. */
function unitOfWorkOf(dataSource: DataSource): UnitOfWork<BusinessResources> {
  return new TypeOrmUnitOfWork(dataSource, (manager) => ({
    idempotency: new TypeOrmIdempotencyStore(manager),
    audit: new TypeOrmAuditWriter(manager),
    contacts: {
      insert: async (intentKey: string, name: string) => {
        await manager.query(
          `INSERT INTO "${IDEMPOTENCY_FIXTURE_CONTACTS_TABLE}" (intent_key, name, created_at_ms)
           VALUES ($1, $2, $3)`,
          [intentKey, name, Date.now()],
        );
      },
    },
  }));
}

function transactionalOn(dataSource: DataSource) {
  return {
    unitOfWork: unitOfWorkOf(dataSource),
    auditOf: (result: ContactResult) => ({
      action: 'contacts.create',
      target: `contact:${result.id}`,
    }),
  };
}

function serviceOn(
  dataSource: DataSource,
  clock: ReturnType<typeof clockAt>,
): IdempotencyService {
  return new IdempotencyService({
    store: new TypeOrmIdempotencyStore(dataSource),
    crypto: NODE_IDEMPOTENCY_CRYPTO,
    clock,
    leaseMs: LEASE,
  });
}

/** Escrita de negócio de um intento: uma linha por efeito interno. */
function insertIntent(label: string, name: string) {
  return async (
    _context: OperationContext,
    _payload: { name: string },
    resources: BusinessResources,
  ): Promise<ContactResult> => {
    await resources.contacts.insert(label, name);
    return { id: label };
  };
}

async function businessRows(
  dataSource: DataSource,
  intentKey: string,
): Promise<{ name: string }[]> {
  return dataSource.query(
    `SELECT name FROM "${IDEMPOTENCY_FIXTURE_CONTACTS_TABLE}" WHERE intent_key = $1 ORDER BY id`,
    [intentKey],
  );
}

async function auditRows(
  dataSource: DataSource,
  target: string,
): Promise<{ outcome: string }[]> {
  return dataSource.query(
    `SELECT outcome FROM audit_entries WHERE target = $1`,
    [target],
  );
}

async function recordState(
  dataSource: DataSource,
  intentKey: string,
): Promise<string | undefined> {
  const rows: { state: string }[] = await dataSource.query(
    `SELECT state FROM ${IDEMPOTENCY_RECORDS_TABLE} WHERE idempotency_key = $1`,
    [intentKey],
  );
  return rows[0]?.state;
}

/** Chave contextual gravada pelo serviço para o cliente informado. */
function intentKeyOf(context: OperationContext, clientKey: string): string {
  return contextualKeyOf(NODE_IDEMPOTENCY_CRYPTO, {
    tenantId: context.principal.tenantId,
    subjectId: context.principal.subjectId,
    operationId: 'contacts.create',
    clientKey,
  });
}

beforeAll(async () => {
  container = await startPostgres();
  catalog = buildPersistenceCatalog(IDEMPOTENCY_TEST_CONTRIBUTIONS);
  const admin = createMigrationDataSource(catalog, {
    host: container.getHost(),
    port: container.getPort(),
    database: DATABASE,
    username: container.getUsername(),
    password: ADMIN_PASSWORD,
    applicationName: 'idempotency-concurrency-admin',
    poolMax: 1,
  });
  await admin.initialize();
  await admin.runMigrations();
  await admin.destroy();
});

afterAll(async () => {
  for (const dataSource of sources) {
    if (dataSource.isInitialized) {
      await dataSource.destroy().catch(() => undefined);
    }
  }
  await container?.stop();
});

describe('Idempotency coordination across replicas (PostgreSQL 16)', () => {
  it(`runs one confirmed effect per intent over ${ROUNDS} concurrent rounds`, async () => {
    const replicaA = await replica('idem-race-a');
    const replicaB = await replica('idem-race-b');
    const clock = clockAt(1_000_000);
    const context = contextOf('subject-race', 'tenant-race');
    const services = [serviceOn(replicaA, clock), serviceOn(replicaB, clock)];
    const datasources = [replicaA, replicaB];
    const summary = { executed: 0, replayed: 0, inProgress: 0 };

    for (let round = 0; round < ROUNDS; round += 1) {
      const label = `race-${round}`;
      const settled = await Promise.allSettled(
        services.map((service, index) =>
          service.executeInUnitOfWork(
            context,
            operation,
            label,
            PAYLOAD,
            transactionalOn(datasources[index]),
            insertIntent(label, 'Ana'),
          ),
        ),
      );

      const fulfilled = settled.filter(
        (item): item is PromiseFulfilledResult<ExecutionOutcome> =>
          item.status === 'fulfilled',
      );
      const rejected = settled.filter(
        (item): item is PromiseRejectedResult => item.status === 'rejected',
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const item of rejected) {
        expect(item.reason).toBeInstanceOf(IdempotencyInProgressError);
      }
      for (const item of fulfilled) {
        const value = (
          item as PromiseFulfilledResult<{
            result: ContactResult;
            replayed: boolean;
          }>
        ).value;
        expect(value.result).toEqual({ id: label });
        if (value.replayed) summary.replayed += 1;
        else summary.executed += 1;
      }
      summary.inProgress += rejected.length;

      expect(await businessRows(replicaA, label)).toHaveLength(1);
      expect(await auditRows(replicaA, `contact:${label}`)).toHaveLength(1);
    }

    expect(summary.executed).toBe(ROUNDS);
    process.stdout.write(
      `[idempotency-concurrency] rounds=${ROUNDS} executed=${summary.executed} replayed=${summary.replayed} inProgress=${summary.inProgress}\n`,
    );
  });

  it('after a crash before commit, no business effect persists and a successor completes once', async () => {
    const replicaA = await replica('idem-crash-a');
    const replicaB = await replica('idem-crash-b');
    const ops = await replica('idem-crash-ops');
    const clock = clockAt(2_000_000);
    const context = contextOf('subject-crash', 'tenant-crash');
    const label = 'crash-before';
    const key = intentKeyOf(context, label);

    // Executor A escreve no negócio e o processo "cai" antes do commit: o
    // backend da transação é encerrado pelo operador, como numa queda real.
    const crashing = serviceOn(replicaA, clock).executeInUnitOfWork(
      context,
      operation,
      label,
      PAYLOAD,
      transactionalOn(replicaA),
      async (_context, _payload, resources) => {
        await resources.contacts.insert(label, 'Ana');
        await ops.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE application_name = $1 AND pid <> pg_backend_pid()`,
          ['idem-crash-a'],
        );
        return { id: label };
      },
    );
    await expect(crashing).rejects.toThrow();

    expect(await businessRows(ops, label)).toHaveLength(0);
    expect(await recordState(ops, key)).toBe('in_progress');

    clock.advance(LEASE + 1);
    const run = jest.fn(insertIntent(label, 'Ana'));
    const recovered = await serviceOn(replicaB, clock).executeInUnitOfWork(
      context,
      operation,
      label,
      PAYLOAD,
      transactionalOn(replicaB),
      run,
    );

    expect(recovered).toEqual({ result: { id: label }, replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await businessRows(ops, label)).toEqual([{ name: 'Ana' }]);
    expect(await auditRows(ops, `contact:${label}`)).toHaveLength(1);
    expect(await recordState(ops, key)).toBe('completed');
  });

  it('after a crash following commit, a replay returns the persisted result with no new write', async () => {
    const replicaA = await replica('idem-after-a');
    const replicaB = await replica('idem-after-b');
    const clock = clockAt(3_000_000);
    const context = contextOf('subject-after', 'tenant-after');
    const label = 'after-commit';

    await serviceOn(replicaA, clock).executeInUnitOfWork(
      context,
      operation,
      label,
      PAYLOAD,
      transactionalOn(replicaA),
      insertIntent(label, 'Ana'),
    );
    // A confirmou e cai antes de responder ao cliente.
    await replicaA.destroy();

    const run = jest.fn(insertIntent(label, 'Ana'));
    const replay = await serviceOn(replicaB, clock).executeInUnitOfWork(
      context,
      operation,
      label,
      PAYLOAD,
      transactionalOn(replicaB),
      run,
    );

    expect(replay).toEqual({ result: { id: label }, replayed: true });
    expect(run).not.toHaveBeenCalled();
    expect(await businessRows(replicaB, label)).toHaveLength(1);
    expect(await auditRows(replicaB, `contact:${label}`)).toHaveLength(1);
  });

  it('refuses the stale executor: its transaction is undone and the successor completes', async () => {
    const replicaA = await replica('idem-stale-a');
    const replicaB = await replica('idem-stale-b');
    const clock = clockAt(4_000_000);
    const context = contextOf('subject-stale', 'tenant-stale');
    const label = 'stale-run';
    const key = intentKeyOf(context, label);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stale = serviceOn(replicaA, clock).executeInUnitOfWork(
      context,
      operation,
      label,
      PAYLOAD,
      transactionalOn(replicaA),
      async (_context, _payload, resources) => {
        await resources.contacts.insert(label, 'stale-a');
        await gate;
        return { id: label };
      },
    );

    await waitUntil(
      async () => (await recordState(replicaB, key)) === 'in_progress',
    );
    clock.advance(LEASE + 1);
    const successor = await serviceOn(replicaB, clock).executeInUnitOfWork(
      context,
      operation,
      label,
      { name: 'Ana' },
      transactionalOn(replicaB),
      insertIntent(label, 'successor'),
    );
    expect(successor.replayed).toBe(false);

    release();
    await expect(stale).rejects.toThrow(IdempotencyStaleClaimError);

    expect(await businessRows(replicaB, label)).toEqual([
      { name: 'successor' },
    ]);
    expect(await auditRows(replicaB, `contact:${label}`)).toHaveLength(1);
    expect(await recordState(replicaB, key)).toBe('completed');
  });

  it('a renewed lease blocks the successor until it expires, and fences the old renewer', async () => {
    const replicaA = await replica('idem-hb-a');
    const replicaB = await replica('idem-hb-b');
    const clock = clockAt(5_000_000);
    const context = contextOf('subject-hb', 'tenant-hb');
    const label = 'heartbeat';
    const key = intentKeyOf(context, label);
    const successorRun = jest.fn((): Promise<JsonValue> =>
      Promise.resolve({ by: 'B' }),
    );
    const renewal = { error: undefined as unknown };

    const owner = await serviceOn(replicaA, clock)
      .execute(
        context,
        operation,
        label,
        PAYLOAD,
        async (_context, _payload, lease: IdempotentLease) => {
          clock.advance(4_000);
          await lease.renew(); // lease agora vale até +9 s
          clock.advance(4_000); // +8 s: o lease original (+5 s) já passou
          await expect(
            serviceOn(replicaB, clock).execute(
              context,
              operation,
              label,
              PAYLOAD,
              successorRun,
            ),
          ).rejects.toThrow(IdempotencyInProgressError);
          clock.advance(2_000); // +10 s: o lease renovado expirou
          await serviceOn(replicaB, clock).execute(
            context,
            operation,
            label,
            PAYLOAD,
            successorRun,
          );
          try {
            await lease.renew();
          } catch (error) {
            renewal.error = error;
          }
          return { by: 'A' };
        },
      )
      .catch((error: unknown) => error);

    expect(owner).toBeInstanceOf(IdempotencyStaleClaimError);
    expect(renewal.error).toBeInstanceOf(IdempotencyStaleClaimError);
    expect(successorRun).toHaveBeenCalledTimes(1);
    expect(await recordState(replicaB, key)).toBe('completed');
  });

  it('keeps an unproven external outcome unknown and never re-sends it blindly', async () => {
    const replicaA = await replica('idem-ext-a');
    const replicaB = await replica('idem-ext-b');
    const clock = clockAt(6_000_000);
    const context = contextOf('subject-ext', 'tenant-ext');
    const label = 'external-send';
    const externalSends = jest.fn((): Promise<JsonValue> =>
      Promise.reject(new Error('provider reset after send')),
    );

    await expect(
      serviceOn(replicaA, clock).execute(
        context,
        operation,
        label,
        PAYLOAD,
        externalSends,
      ),
    ).rejects.toThrow('provider reset after send');

    await expect(
      serviceOn(replicaB, clock).execute(
        context,
        operation,
        label,
        PAYLOAD,
        externalSends,
      ),
    ).rejects.toThrow(IdempotencyOutcomeUnknownError);
    expect(externalSends).toHaveBeenCalledTimes(1);

    const reconciled = await serviceOn(replicaB, clock).reconcileOutcomeUnknown(
      intentKeyOf(context, label),
      {
        reconcile: () =>
          Promise.resolve({
            outcome: 'confirmed',
            result: { providerId: 'p-9' },
          }),
      },
    );
    const replay = await serviceOn(replicaB, clock).execute(
      context,
      operation,
      label,
      PAYLOAD,
      externalSends,
    );

    expect(reconciled).toBe('completed');
    expect(replay).toEqual({ result: { providerId: 'p-9' }, replayed: true });
    expect(externalSends).toHaveBeenCalledTimes(1);
  });
});

async function waitUntil(
  condition: () => Promise<boolean>,
  attempts = 200,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
