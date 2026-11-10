import { buildPersistenceCatalog } from './persistence-catalog';
import { PERSISTENCE_CONTRIBUTIONS } from './persistence-contributions';
import { createMigrationDataSource } from './migration-data-source';
import { persistenceConfigFromEnv } from './persistence-config';

/**
 * DataSource para a CLI do TypeORM, por exemplo:
 *   typeorm migration:run -d dist/native/persistence-typeorm/data-source.cli.js
 * Usa o mesmo catálogo (`PERSISTENCE_CONTRIBUTIONS`) e a mesma fábrica do runtime.
 * Configuração vem de variáveis `FOUNDATION_DB_*`; sem elas, a importação falha.
 */
const catalog = buildPersistenceCatalog(PERSISTENCE_CONTRIBUTIONS);

export default createMigrationDataSource(
  catalog,
  persistenceConfigFromEnv(process.env),
);
