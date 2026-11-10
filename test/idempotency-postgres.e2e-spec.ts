/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';
import type { OperationContext } from '../src/core/application/context/operation-context';
import {
  IdempotencyStaleClaimError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyOutcomeUnknownError,
} from '../src/core/application/idempotency/idempotency.errors';
import { IdempotencyService } from '../src/core/application/idempotency/idempotency.service';
import type {
  IdempotencyCrypto,
  IdempotentOperation,
  JsonValue,
} from '../src/core/application/idempotency/idempotency.types';
import { NODE_IDEMPOTENCY_CRYPTO } from '../src/core/presentation/http/idempotency/node-idempotency-crypto';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  type PersistenceCatalog,
} from '../src/native/persistence-typeorm';
import {
  IDEMPOTENCY_RECORDS_TABLE,
  TypeOrmIdempotencyStore,
} from '../src/native/persistence-typeorm/idempotency';
import { IDEMPOTENCY_TEST_CONTRIBUTIONS } from './fixtures/idempotency-catalog';

jest.setTimeout(300_000);

const ADMIN_PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_idempotency';
const RETENTION = 60_000;
const LEASE = 5_000;

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

/** Cada DataSource representa uma réplica com pool próprio sobre o mesmo banco. */
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

function contextOf(subjectId: string, tenantId?: string): OperationContext {
  return {
    correlationId: `corr-${subjectId}`,
    principal: {
      subjectId,
      ...(tenantId === undefined ? {} : { tenantId }),
      permissions: [],
    },
    deadlineAt: 10_000_000,
  };
}

const allowAll = (): Promise<void> => Promise.resolve();

function operation(
  authorize: (context: OperationContext) => Promise<void> = allowAll,
): IdempotentOperation<{ name: string }> {
  return {
    policy: { operationId: 'contacts.create', retentionMs: RETENTION },
    authorize,
  };
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

beforeAll(async () => {
  container = await startPostgres();
  catalog = buildPersistenceCatalog(IDEMPOTENCY_TEST_CONTRIBUTIONS);
  const admin = createMigrationDataSource(catalog, {
    host: container.getHost(),
    port: container.getPort(),
    database: DATABASE,
    username: container.getUsername(),
    password: ADMIN_PASSWORD,
    applicationName: 'idempotency-admin',
    poolMax: 1,
  });
  await admin.initialize();
  await admin.runMigrations();
  await admin.destroy();
});

afterAll(async () => {
  for (const dataSource of sources) {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
  await container?.stop();
});

describe('TypeOrmIdempotencyStore (PostgreSQL 16)', () => {
  it('creates the table only through the catalog migration', async () => {
    const dataSource = await replica('idem-schema');
    const rows: { exists: boolean }[] = await dataSource.query(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [IDEMPOTENCY_RECORDS_TABLE],
    );
    const applied: { name: string }[] = await dataSource.query(
      'SELECT name FROM migrations ORDER BY timestamp, id',
    );
    expect(rows[0].exists).toBe(true);
    expect(applied.map((row) => row.name)).toContain(
      'CreateIdempotencyRecords1794259200000',
    );
  });

  it('enforces a UNIQUE contextual key at the database', async () => {
    const dataSource = await replica('idem-unique');
    const insert = `INSERT INTO ${IDEMPOTENCY_RECORDS_TABLE}
      (idempotency_key, operation_id, subject_id, fingerprint, state, claim_token,
       lease_expires_at_ms, created_at_ms, updated_at_ms, expires_at_ms, version)
      VALUES ('dup-key', 'contacts.create', 's', 'f', 'in_progress', 't', 9999999999999, 1, 1, 9999999999999, 1)`;
    await dataSource.query(insert);
    await expect(dataSource.query(insert)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('lets only one of two concurrent begins claim the intent', async () => {
    const dataSource = await replica('idem-begin-race');
    const store = new TypeOrmIdempotencyStore(dataSource);
    const request = (claimToken: string) => ({
      key: 'race-key',
      operationId: 'contacts.create',
      subjectId: 'subject-race',
      tenantId: 'tenant-race',
      fingerprint: 'fp-race',
      claimToken,
      now: 1_000,
      expiresAt: 1_000 + RETENTION,
      leaseExpiresAt: 1_000 + LEASE,
    });

    const [first, second] = await Promise.all([
      store.begin(request('token-1')),
      store.begin(request('token-2')),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['claimed', 'existing']);
    const existing = [first, second].find(
      (item) => item.outcome === 'existing',
    );
    expect(existing?.record.state).toBe('in_progress');
  });

  it('runs the effect once across replicas and replays the persisted result', async () => {
    const replicaA = await replica('idem-replica-a');
    const replicaB = await replica('idem-replica-b');
    const clock = clockAt(5_000);
    const run = jest.fn(async (): Promise<JsonValue> => ({ id: 'c-1' }));
    const context = contextOf('subject-replica', 'tenant-r');

    const serviceA = new IdempotencyService({
      store: new TypeOrmIdempotencyStore(replicaA),
      crypto: NODE_IDEMPOTENCY_CRYPTO,
      clock,
    });
    const serviceB = new IdempotencyService({
      store: new TypeOrmIdempotencyStore(replicaB),
      crypto: NODE_IDEMPOTENCY_CRYPTO,
      clock,
    });

    const first = await serviceA.execute(
      context,
      operation(),
      'replica-key',
      { name: 'Ana' },
      run,
    );
    const replayed = await serviceB.execute(
      context,
      operation(),
      'replica-key',
      { name: 'Ana' },
      run,
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ result: { id: 'c-1' }, replayed: false });
    expect(replayed).toEqual({ result: { id: 'c-1' }, replayed: true });
  });

  it('rejects a divergent payload across replicas with a persisted conflict', async () => {
    const replicaA = await replica('idem-conflict-a');
    const replicaB = await replica('idem-conflict-b');
    const clock = clockAt(9_000);
    const run = jest.fn(async (): Promise<JsonValue> => ({ ok: true }));
    const context = contextOf('subject-conflict', 'tenant-c');
    const crypto: IdempotencyCrypto = NODE_IDEMPOTENCY_CRYPTO;

    await new IdempotencyService({
      store: new TypeOrmIdempotencyStore(replicaA),
      crypto,
      clock,
    }).execute(context, operation(), 'conflict-key', { name: 'Ana' }, run);
    await expect(
      new IdempotencyService({
        store: new TypeOrmIdempotencyStore(replicaB),
        crypto,
        clock,
      }).execute(context, operation(), 'conflict-key', { name: 'Bia' }, run),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers in-progress for concurrent calls and runs the effect once', async () => {
    const dataSource = await replica('idem-concurrent');
    const service = new IdempotencyService({
      store: new TypeOrmIdempotencyStore(dataSource),
      crypto: NODE_IDEMPOTENCY_CRYPTO,
      clock: clockAt(20_000),
    });
    const context = contextOf('subject-burst', 'tenant-b');
    const run = jest.fn(
      () =>
        new Promise<JsonValue>((resolve) =>
          setTimeout(() => resolve({ id: 'burst' }), 150),
        ),
    );

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        service.execute(
          context,
          operation(),
          'burst-key',
          { name: 'Ana' },
          run,
        ),
      ),
    );

    expect(run).toHaveBeenCalledTimes(1);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(IdempotencyInProgressError);
      }
    }
  });

  it('keeps unknown outcomes and terminal states after restart of a replica', async () => {
    const dataSource = await replica('idem-unknown');
    const clock = clockAt(30_000);
    const service = new IdempotencyService({
      store: new TypeOrmIdempotencyStore(dataSource),
      crypto: NODE_IDEMPOTENCY_CRYPTO,
      clock,
    });
    const context = contextOf('subject-unknown', 'tenant-u');
    const run = jest.fn(async (): Promise<JsonValue> => {
      throw new Error('upstream reset');
    });

    await expect(
      service.execute(
        context,
        operation(),
        'unknown-key',
        { name: 'Ana' },
        run,
      ),
    ).rejects.toThrow('upstream reset');
    const restarted = new IdempotencyService({
      store: new TypeOrmIdempotencyStore(await replica('idem-unknown-restart')),
      crypto: NODE_IDEMPOTENCY_CRYPTO,
      clock,
    });
    await expect(
      restarted.execute(
        context,
        operation(),
        'unknown-key',
        { name: 'Ana' },
        run,
      ),
    ).rejects.toThrow(IdempotencyOutcomeUnknownError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reuses the key as a new intent only after the retention window', async () => {
    const dataSource = await replica('idem-expiry');
    const clock = clockAt(40_000);
    const service = new IdempotencyService({
      store: new TypeOrmIdempotencyStore(dataSource),
      crypto: NODE_IDEMPOTENCY_CRYPTO,
      clock,
    });
    const context = contextOf('subject-expiry', 'tenant-e');
    const run = jest.fn(async (): Promise<JsonValue> => ({
      n: run.mock.calls.length,
    }));

    await service.execute(
      context,
      operation(),
      'expiry-key',
      { name: 'Ana' },
      run,
    );
    clock.advance(RETENTION - 1);
    await service.execute(
      context,
      operation(),
      'expiry-key',
      { name: 'Ana' },
      run,
    );
    expect(run).toHaveBeenCalledTimes(1);

    clock.advance(1);
    const renewed = await service.execute(
      context,
      operation(),
      'expiry-key',
      { name: 'Ana' },
      run,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(renewed).toEqual({ result: { n: 2 }, replayed: false });
  });

  it('purges expired records in bounded batches and keeps live ones', async () => {
    const dataSource = await replica('idem-purge');
    const store = new TypeOrmIdempotencyStore(dataSource);
    const base = 50_000;
    for (let index = 0; index < 4; index += 1) {
      await store.begin({
        key: `purge-${index}`,
        operationId: 'contacts.create',
        subjectId: 'subject-purge',
        fingerprint: 'fp',
        claimToken: `claim-${index}`,
        now: base,
        expiresAt: base + 10,
        leaseExpiresAt: base + LEASE,
      });
      await store.complete({
        key: `purge-${index}`,
        claimToken: `claim-${index}`,
        version: 1,
        result: null,
        now: base,
      });
    }
    // Retenção vencida, mas executor ainda vivo: nunca pode ser purgado.
    await store.begin({
      key: 'purge-inflight',
      operationId: 'contacts.create',
      subjectId: 'subject-purge',
      fingerprint: 'fp',
      claimToken: 'claim-inflight',
      now: base,
      expiresAt: base + 10,
      leaseExpiresAt: base + 1_000_000,
    });
    await store.begin({
      key: 'purge-live',
      operationId: 'contacts.create',
      subjectId: 'subject-purge',
      fingerprint: 'fp',
      claimToken: 'claim-live',
      now: base,
      expiresAt: base + 1_000_000,
      leaseExpiresAt: base + LEASE,
    });

    expect(await store.purgeExpired({ now: base + 100, limit: 3 })).toBe(3);
    expect(await store.purgeExpired({ now: base + 100, limit: 3 })).toBe(1);
    expect(await store.find('purge-live')).not.toBeNull();
    expect((await store.find('purge-inflight'))?.state).toBe('in_progress');
    await expect(store.purgeExpired({ now: base, limit: 0 })).rejects.toThrow();
  });

  it('refuses to complete with a stale claim token', async () => {
    const dataSource = await replica('idem-fence');
    const store = new TypeOrmIdempotencyStore(dataSource);
    await store.begin({
      key: 'fence-key',
      operationId: 'contacts.create',
      subjectId: 'subject-fence',
      fingerprint: 'fp',
      claimToken: 'current',
      now: 1,
      expiresAt: 1 + RETENTION,
      leaseExpiresAt: 1 + LEASE,
    });

    await expect(
      store.complete({
        key: 'fence-key',
        claimToken: 'stale',
        version: 1,
        result: { ok: true },
        now: 2,
      }),
    ).rejects.toThrow(IdempotencyStaleClaimError);
    await store.complete({
      key: 'fence-key',
      claimToken: 'current',
      version: 1,
      result: null,
      now: 3,
    });
    const record = await store.find('fence-key');
    expect(record?.state).toBe('completed');
    expect(record?.result).toBeNull();
    expect(record?.version).toBe(2);
  });
});
