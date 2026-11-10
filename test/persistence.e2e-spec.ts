import { Test } from '@nestjs/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  PERSISTENCE_DATA_SOURCE,
  PersistenceError,
  PersistenceTypeOrmModule,
  TypeOrmUnitOfWork,
} from '../src/native/persistence-typeorm';
import type { PersistenceConfigInput } from '../src/native/persistence-typeorm';
import {
  ALPHA_CONTRIBUTION,
  AlphaItemRepository,
} from './fixtures/persistence-alpha';
import {
  BETA_CONTRIBUTION,
  BetaNoteRepository,
} from './fixtures/persistence-beta';

jest.setTimeout(300_000);

const ADMIN_PASSWORD = 'foundation-test-only';
const ADMIN_DATABASE = 'foundation_test';
const FRESH_DATABASE = 'foundation_fresh';

let container: StartedPostgreSqlContainer;

async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(ADMIN_DATABASE)
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

function configFor(
  database: string,
  applicationName: string,
  extra: Partial<PersistenceConfigInput> = {},
): PersistenceConfigInput {
  return {
    host: container.getHost(),
    port: container.getPort(),
    database,
    username: container.getUsername(),
    password: ADMIN_PASSWORD,
    applicationName,
    poolMax: 5,
    ...extra,
  };
}

async function adminClient(database = ADMIN_DATABASE): Promise<Client> {
  const client = new Client({
    host: container.getHost(),
    port: container.getPort(),
    database,
    user: container.getUsername(),
    password: ADMIN_PASSWORD,
  });
  await client.connect();
  return client;
}

async function tableExists(
  dataSource: DataSource,
  table: string,
): Promise<boolean> {
  const rows: { exists: boolean }[] = await dataSource.query(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [table],
  );
  return rows[0].exists;
}

async function migrationNames(dataSource: DataSource): Promise<string[]> {
  const rows: { name: string }[] = await dataSource.query(
    'SELECT name FROM migrations ORDER BY timestamp, id',
  );
  return rows.map((row) => row.name);
}

async function sessionsFor(applicationName: string): Promise<number> {
  const admin = await adminClient();
  try {
    const rows = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
      [applicationName],
    );
    return rows.rows[0].n;
  } finally {
    await admin.end();
  }
}

async function waitForSessions(
  applicationName: string,
  expected: number,
): Promise<number> {
  let current = await sessionsFor(applicationName);
  for (let attempt = 0; attempt < 50 && current !== expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await sessionsFor(applicationName);
  }
  return current;
}

beforeAll(async () => {
  container = await startPostgres();
  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${FRESH_DATABASE}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  await container?.stop();
});

describe('PersistenceTypeOrm integration (PostgreSQL 16)', () => {
  const catalog = buildPersistenceCatalog([
    ALPHA_CONTRIBUTION,
    BETA_CONTRIBUTION,
  ]);
  const resourcesFactory = (manager: import('typeorm').EntityManager) => ({
    alpha: new AlphaItemRepository(manager),
    beta: new BetaNoteRepository(manager),
  });
  let dataSource: DataSource;
  let uow: TypeOrmUnitOfWork<ReturnType<typeof resourcesFactory>>;

  beforeAll(async () => {
    dataSource = createMigrationDataSource(
      catalog,
      configFor(ADMIN_DATABASE, 'fixture-main'),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    uow = new TypeOrmUnitOfWork(dataSource, resourcesFactory);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('does not create tables without migrations (synchronize is forced off)', async () => {
    const fresh = createMigrationDataSource(
      catalog,
      configFor(FRESH_DATABASE, 'fixture-fresh'),
    );
    expect(fresh.options.synchronize).toBe(false);
    await fresh.initialize();
    try {
      expect(await tableExists(fresh, 'alpha_items')).toBe(false);
      expect(await tableExists(fresh, 'beta_notes')).toBe(false);
      await fresh.runMigrations();
      expect(await tableExists(fresh, 'alpha_items')).toBe(true);
      expect(await tableExists(fresh, 'beta_notes')).toBe(true);
      expect(await migrationNames(fresh)).toEqual([
        'CreateAlphaItems1700000000001',
        'CreateBetaNotes1700000000002',
      ]);
    } finally {
      await fresh.destroy();
    }
  });

  it('commits writes of two repositories together', async () => {
    await uow.run(async ({ alpha, beta }) => {
      await alpha.add('00000000-0000-4000-8000-000000000001', 'alpha-1');
      await beta.add('00000000-0000-4000-8000-000000000001', 'beta-1');
    });
    await uow.run(async ({ alpha, beta }) => {
      expect(await alpha.count()).toBe(1);
      expect(await beta.count()).toBe(1);
    });
  });

  it('rolls back both repositories when the work throws', async () => {
    await expect(
      uow.run(async ({ alpha, beta }) => {
        await alpha.add('00000000-0000-4000-8000-000000000002', 'alpha-2');
        await beta.add('00000000-0000-4000-8000-000000000002', 'beta-2');
        throw new Error('work failed on purpose');
      }),
    ).rejects.toThrow('work failed on purpose');

    await uow.run(async ({ alpha, beta }) => {
      expect(await alpha.count()).toBe(1);
      expect(await beta.count()).toBe(1);
    });
  });

  it('rejects an accidental nested unit of work and persists nothing from it', async () => {
    const error = await uow
      .run(async () =>
        uow.run(async ({ alpha }) =>
          alpha.add('00000000-0000-4000-8000-000000000003', 'nested'),
        ),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).code).toBe(
      'PERSISTENCE_NESTED_TRANSACTION',
    );
    await uow.run(async ({ alpha }) => {
      expect(await alpha.count()).toBe(1);
    });
  });

  it('keeps tables and migration history when a module leaves the catalog', async () => {
    const withoutBeta = createMigrationDataSource(
      buildPersistenceCatalog([ALPHA_CONTRIBUTION]),
      configFor(ADMIN_DATABASE, 'fixture-without-beta'),
    );
    await withoutBeta.initialize();
    try {
      expect(await withoutBeta.runMigrations()).toEqual([]);
      expect(await tableExists(withoutBeta, 'beta_notes')).toBe(true);
      expect(await migrationNames(withoutBeta)).toContain(
        'CreateBetaNotes1700000000002',
      );
      const admin = await adminClient();
      try {
        const rows = await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM beta_notes',
        );
        expect(rows.rows[0].n).toBe(1);
      } finally {
        await admin.end();
      }
    } finally {
      await withoutBeta.destroy();
    }
  });

  it('applies migrations at boot and closes the pool at shutdown through the Nest module', async () => {
    const applicationName = 'fixture-shutdown';
    const moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceTypeOrmModule.register({
          contributions: [ALPHA_CONTRIBUTION, BETA_CONTRIBUTION],
          config: configFor(ADMIN_DATABASE, applicationName, {
            migrationsRun: true,
          }),
        }),
      ],
    }).compile();

    await moduleRef.init();
    const moduleDataSource = moduleRef.get<DataSource>(PERSISTENCE_DATA_SOURCE);
    expect(moduleDataSource.isInitialized).toBe(true);
    expect(await sessionsFor(applicationName)).toBeGreaterThan(0);

    await moduleRef.close();
    expect(moduleDataSource.isInitialized).toBe(false);
    expect(await waitForSessions(applicationName, 0)).toBe(0);
  });
});
