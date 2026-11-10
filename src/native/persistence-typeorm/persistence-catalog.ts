import { DefaultNamingStrategy, getMetadataArgsStorage } from 'typeorm';
import type { MigrationInterface } from 'typeorm';
import { PersistenceError } from './persistence-errors';

/** Classe de entidade TypeORM (decorada com `@Entity`). */
export type PersistenceEntityClass = new (...args: never[]) => object;

/** Classe de migration TypeORM; o nome termina em timestamp de 13 dígitos. */
export type PersistenceMigrationClass = new () => MigrationInterface;

/** Declaração estática de um módulo: entidades e migrations próprias. */
export interface PersistenceModuleContribution {
  readonly moduleId: string;
  readonly entities: readonly PersistenceEntityClass[];
  readonly migrations: readonly PersistenceMigrationClass[];
}

/** Catálogo validado. Só é produzido por `buildPersistenceCatalog`. */
export interface PersistenceCatalog {
  readonly modules: readonly string[];
  readonly entities: readonly PersistenceEntityClass[];
  readonly migrations: readonly PersistenceMigrationClass[];
  readonly tables: readonly string[];
  readonly migrationNames: readonly string[];
}

const builtCatalogs = new WeakSet<object>();
const namingStrategy = new DefaultNamingStrategy();
const MIGRATION_TIMESTAMP_SUFFIX = /\d{13}$/;

/**
 * Valida as contribuições e produz o catálogo único usado por runtime e CLI.
 * Duplicidades e declarações inválidas lançam `PersistenceError` com código estável.
 */
export function buildPersistenceCatalog(
  contributions: readonly PersistenceModuleContribution[],
): PersistenceCatalog {
  const contributionList = asList<PersistenceModuleContribution>(
    contributions,
    'Persistence contributions must be an array',
  );

  const moduleIds = new Set<string>();
  const entityOwners = new Map<PersistenceEntityClass, string>();
  const tableOwners = new Map<string, string>();
  const migrationOwners = new Map<PersistenceMigrationClass, string>();
  const migrationNameOwners = new Map<string, string>();

  const modules: string[] = [];
  const entities: PersistenceEntityClass[] = [];
  const migrations: PersistenceMigrationClass[] = [];
  const tables: string[] = [];
  const migrationNames: string[] = [];

  for (const contribution of contributionList) {
    const moduleId: unknown = contribution?.moduleId;
    if (typeof moduleId !== 'string' || moduleId.trim() === '') {
      throw new PersistenceError(
        'PERSISTENCE_INVALID_CONTRIBUTION',
        'Persistence contribution requires a non-empty moduleId',
      );
    }
    if (moduleIds.has(moduleId)) {
      throw new PersistenceError(
        'PERSISTENCE_DUPLICATE_MODULE_ID',
        `Duplicate persistence moduleId: ${moduleId}`,
      );
    }
    moduleIds.add(moduleId);
    modules.push(moduleId);

    const entityList = asList<PersistenceEntityClass>(
      contribution.entities,
      `Module ${moduleId} must declare entities as an array`,
    );
    for (const entity of entityList) {
      if (typeof entity !== 'function') {
        throw new PersistenceError(
          'PERSISTENCE_INVALID_ENTITY',
          `Module ${moduleId} declares an entity that is not a class`,
        );
      }
      const owner = entityOwners.get(entity);
      if (owner !== undefined) {
        throw new PersistenceError(
          'PERSISTENCE_DUPLICATE_ENTITY',
          `Entity ${entity.name} is registered twice (${owner}, ${moduleId})`,
        );
      }
      const table = tableNameOf(entity, moduleId);
      const tableOwner = tableOwners.get(table);
      if (tableOwner !== undefined) {
        throw new PersistenceError(
          'PERSISTENCE_DUPLICATE_TABLE',
          `Table ${table} is declared twice (${tableOwner}, ${moduleId})`,
        );
      }
      entityOwners.set(entity, moduleId);
      tableOwners.set(table, moduleId);
      entities.push(entity);
      tables.push(table);
    }

    const migrationList = asList<PersistenceMigrationClass>(
      contribution.migrations,
      `Module ${moduleId} must declare migrations as an array`,
    );
    for (const migration of migrationList) {
      if (typeof migration !== 'function') {
        throw new PersistenceError(
          'PERSISTENCE_INVALID_MIGRATION',
          `Module ${moduleId} declares a migration that is not a class`,
        );
      }
      const owner = migrationOwners.get(migration);
      if (owner !== undefined) {
        throw new PersistenceError(
          'PERSISTENCE_DUPLICATE_MIGRATION',
          `Migration ${migration.name} is registered twice (${owner}, ${moduleId})`,
        );
      }
      const name = migrationNameOf(migration, moduleId);
      const nameOwner = migrationNameOwners.get(name);
      if (nameOwner !== undefined) {
        throw new PersistenceError(
          'PERSISTENCE_DUPLICATE_MIGRATION_NAME',
          `Migration name ${name} is declared twice (${nameOwner}, ${moduleId})`,
        );
      }
      migrationOwners.set(migration, moduleId);
      migrationNameOwners.set(name, moduleId);
      migrations.push(migration);
      migrationNames.push(name);
    }
  }

  const catalog: PersistenceCatalog = Object.freeze({
    modules: Object.freeze(modules),
    entities: Object.freeze(entities),
    migrations: Object.freeze(migrations),
    tables: Object.freeze(tables),
    migrationNames: Object.freeze(migrationNames),
  });
  builtCatalogs.add(catalog);
  return catalog;
}

function asList<T>(value: unknown, message: string): readonly T[] {
  if (!Array.isArray(value)) {
    throw new PersistenceError('PERSISTENCE_INVALID_CONTRIBUTION', message);
  }
  return value as readonly T[];
}

/** Garante que o catálogo passou por `buildPersistenceCatalog`. */
export function assertBuiltPersistenceCatalog(
  catalog: PersistenceCatalog,
): void {
  if (!builtCatalogs.has(catalog)) {
    throw new PersistenceError(
      'PERSISTENCE_INVALID_CONTRIBUTION',
      'Persistence catalog must be produced by buildPersistenceCatalog',
    );
  }
}

function tableNameOf(entity: PersistenceEntityClass, moduleId: string): string {
  const args = getMetadataArgsStorage().tables.find(
    (table) => table.target === entity,
  );
  if (args === undefined) {
    throw new PersistenceError(
      'PERSISTENCE_INVALID_ENTITY',
      `Entity ${entity.name} in module ${moduleId} is not decorated with @Entity`,
    );
  }
  const name = namingStrategy.tableName(entity.name, args.name);
  return args.schema ? `${args.schema}.${name}` : name;
}

function migrationNameOf(
  migration: PersistenceMigrationClass,
  moduleId: string,
): string {
  const instance = new migration() as Partial<MigrationInterface>;
  if (
    typeof instance.up !== 'function' ||
    typeof instance.down !== 'function'
  ) {
    throw new PersistenceError(
      'PERSISTENCE_INVALID_MIGRATION',
      `Migration ${migration.name} in module ${moduleId} must implement up and down`,
    );
  }
  // Mesma regra do TypeORM: `name` da instância ou nome da classe.
  const name = instance.name ?? migration.name;
  if (!MIGRATION_TIMESTAMP_SUFFIX.test(name)) {
    throw new PersistenceError(
      'PERSISTENCE_INVALID_MIGRATION',
      `Migration ${name} in module ${moduleId} must end with a 13-digit timestamp`,
    );
  }
  return name;
}
