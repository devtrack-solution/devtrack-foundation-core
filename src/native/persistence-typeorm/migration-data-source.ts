import { DataSource } from 'typeorm';
import {
  assertBuiltPersistenceCatalog,
  type PersistenceCatalog,
} from './persistence-catalog';
import {
  validatePersistenceConfig,
  type PersistenceConfigInput,
} from './persistence-config';

/** Nome da tabela de histórico de migrations (padrão do TypeORM, explícito aqui). */
export const PERSISTENCE_MIGRATIONS_TABLE = 'migrations';

/**
 * DataSource único a partir do catálogo validado. Usado pelo runtime e pelo
 * `data-source.cli.ts`, garantindo as mesmas entidades e migrations.
 * `synchronize` e `dropSchema` são sempre false; `migrationsRun` é false porque
 * a aplicação das migrations é explícita (lifecycle do módulo ou CLI).
 */
export function createMigrationDataSource(
  catalog: PersistenceCatalog,
  input: PersistenceConfigInput,
): DataSource {
  assertBuiltPersistenceCatalog(catalog);
  const config = validatePersistenceConfig(input);
  return new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: config.ssl,
    entities: [...catalog.entities],
    migrations: [...catalog.migrations],
    migrationsTableName: PERSISTENCE_MIGRATIONS_TABLE,
    migrationsRun: false,
    synchronize: false,
    dropSchema: false,
    logging: false,
    poolSize: config.poolMax,
    extra: {
      application_name: config.applicationName,
      connectionTimeoutMillis: config.connectTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
    },
  });
}
