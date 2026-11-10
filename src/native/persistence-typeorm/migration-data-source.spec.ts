import { Test } from '@nestjs/testing';
import { Entity, PrimaryColumn } from 'typeorm';
import type { DataSource, MigrationInterface } from 'typeorm';
import { buildPersistenceCatalog } from './persistence-catalog';
import type { PersistenceModuleContribution } from './persistence-catalog';
import { createMigrationDataSource } from './migration-data-source';
import type { PersistenceConfigInput } from './persistence-config';
import {
  PERSISTENCE_DATA_SOURCE,
  PersistenceTypeOrmModule,
} from './persistence-typeorm.module';

@Entity({ name: 'cli_probe_one' })
class CliProbeOne {
  @PrimaryColumn() id!: string;
}

@Entity({ name: 'cli_probe_two' })
class CliProbeTwo {
  @PrimaryColumn() id!: string;
}

class CreateCliProbeOne1700000000011 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

class CreateCliProbeTwo1700000000012 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

const contributions: readonly PersistenceModuleContribution[] = [
  {
    moduleId: 'cli-probe-one',
    entities: [CliProbeOne],
    migrations: [CreateCliProbeOne1700000000011],
  },
  {
    moduleId: 'cli-probe-two',
    entities: [CliProbeTwo],
    migrations: [CreateCliProbeTwo1700000000012],
  },
];

const config: PersistenceConfigInput = {
  host: 'localhost',
  port: 5432,
  database: 'foundation',
  username: 'foundation',
  password: 'not-a-real-secret',
  applicationName: 'foundation-cli',
};

const CLI_ENV = {
  FOUNDATION_DB_HOST: 'localhost',
  FOUNDATION_DB_PORT: '5432',
  FOUNDATION_DB_NAME: 'foundation',
  FOUNDATION_DB_USER: 'foundation',
  FOUNDATION_DB_PASSWORD: 'not-a-real-secret',
  FOUNDATION_DB_APPLICATION_NAME: 'foundation-cli',
};

function codeOf(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('createMigrationDataSource', () => {
  it('forces synchronize, dropSchema and migrationsRun off and applies pool and application name', () => {
    const dataSource = createMigrationDataSource(
      buildPersistenceCatalog(contributions),
      {
        ...config,
        poolMax: 4,
        statementTimeoutMs: 1_000,
      },
    );
    expect(dataSource.options).toMatchObject({
      type: 'postgres',
      synchronize: false,
      dropSchema: false,
      migrationsRun: false,
      poolSize: 4,
      extra: {
        application_name: 'foundation-cli',
        statement_timeout: 1_000,
        connectionTimeoutMillis: 5_000,
      },
    });
    expect(dataSource.options.entities).toEqual([CliProbeOne, CliProbeTwo]);
    expect(dataSource.options.migrations).toEqual([
      CreateCliProbeOne1700000000011,
      CreateCliProbeTwo1700000000012,
    ]);
  });

  it('refuses a catalog that was not produced by buildPersistenceCatalog', () => {
    const fake = {
      modules: [],
      entities: [],
      migrations: [],
      tables: [],
      migrationNames: [],
    };
    expect(codeOf(() => createMigrationDataSource(fake, config))).toBe(
      'PERSISTENCE_INVALID_CONTRIBUTION',
    );
  });
});

describe('CLI and runtime catalog', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.dontMock('./persistence-contributions');
  });

  it('data-source.cli exposes the same entities, migrations and options as the runtime module', async () => {
    process.env = { ...originalEnv, ...CLI_ENV };
    let cliDataSource: DataSource | undefined;
    jest.isolateModules(() => {
      jest.doMock('./persistence-contributions', () => ({
        PERSISTENCE_CONTRIBUTIONS: contributions,
      }));
      cliDataSource = jest.requireActual<{ default: DataSource }>(
        './data-source.cli',
      ).default;
    });

    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceTypeOrmModule.register({ contributions, config })],
    }).compile();
    const runtimeDataSource = moduleRef.get<DataSource>(
      PERSISTENCE_DATA_SOURCE,
    );

    expect(cliDataSource).toBeDefined();
    expect(cliDataSource?.options.entities).toEqual(
      runtimeDataSource.options.entities,
    );
    expect(cliDataSource?.options.migrations).toEqual(
      runtimeDataSource.options.migrations,
    );
    expect(cliDataSource?.options).toEqual(runtimeDataSource.options);
    expect(cliDataSource?.isInitialized).toBe(false);
  });

  it('data-source.cli fails at import when the FOUNDATION_DB_* config is missing', () => {
    process.env = { ...originalEnv, FOUNDATION_DB_HOST: '' };
    expect(
      codeOf(() => {
        jest.isolateModules(() => {
          jest.requireActual('./data-source.cli');
        });
      }),
    ).toBe('PERSISTENCE_INVALID_CONFIG');
  });
});
