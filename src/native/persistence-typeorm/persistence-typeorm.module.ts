import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  buildPersistenceCatalog,
  type PersistenceCatalog,
  type PersistenceModuleContribution,
} from './persistence-catalog';
import { createMigrationDataSource } from './migration-data-source';
import {
  validatePersistenceConfig,
  type PersistenceConfig,
  type PersistenceConfigInput,
} from './persistence-config';
import { PersistenceError } from './persistence-errors';

/** DataSource único da Foundation. Injete com este token para criar UnitOfWork. */
export const PERSISTENCE_DATA_SOURCE: InjectionToken = Symbol.for(
  'foundation.api.v1.native.persistence-typeorm.data-source',
);

/** Interno: catálogo e configuração validados, compartilhados pelo módulo. */
const PERSISTENCE_RUNTIME: InjectionToken = Symbol.for(
  'foundation.api.v1.native.persistence-typeorm.runtime',
);

export interface PersistenceTypeOrmOptions {
  readonly contributions: readonly PersistenceModuleContribution[];
  readonly config: PersistenceConfigInput;
}

export interface PersistenceTypeOrmAsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: readonly InjectionToken[];
  /** Devolve catálogo e configuração (ex.: lidos de um cofre). Falha impede o boot. */
  readonly useFactory: (
    ...args: unknown[]
  ) => PersistenceTypeOrmOptions | Promise<PersistenceTypeOrmOptions>;
}

interface PersistenceRuntime {
  readonly catalog: PersistenceCatalog;
  readonly config: PersistenceConfig;
}

function resolveRuntime(
  options: PersistenceTypeOrmOptions,
): PersistenceRuntime {
  return {
    catalog: buildPersistenceCatalog(options.contributions),
    config: validatePersistenceConfig(options.config),
  };
}

function dataSourceProvider() {
  return {
    provide: PERSISTENCE_DATA_SOURCE,
    inject: [PERSISTENCE_RUNTIME],
    useFactory: (runtime: PersistenceRuntime): DataSource =>
      createMigrationDataSource(runtime.catalog, runtime.config),
  };
}

/** Inicializa o DataSource no boot e fecha o pool no shutdown. */
@Injectable()
class PersistenceLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(PERSISTENCE_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(PERSISTENCE_RUNTIME) private readonly runtime: PersistenceRuntime,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.dataSource.initialize();
    if (!this.runtime.config.migrationsRun) return;
    try {
      await this.dataSource.runMigrations();
    } catch (error) {
      await this.dataSource.destroy();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}

/**
 * Módulo de persistência TypeORM. Não é habilitado implicitamente: o host o importa.
 * Configuração e catálogo inválidos lançam já em register/registerAsync.
 */
@Module({})
export class PersistenceTypeOrmModule {
  static register(options: PersistenceTypeOrmOptions): DynamicModule {
    const runtime = resolveRuntime(options);
    return {
      module: PersistenceTypeOrmModule,
      providers: [
        { provide: PERSISTENCE_RUNTIME, useValue: runtime },
        dataSourceProvider(),
        PersistenceLifecycle,
      ],
      exports: [PERSISTENCE_DATA_SOURCE],
    };
  }

  static registerAsync(options: PersistenceTypeOrmAsyncOptions): DynamicModule {
    if (typeof options?.useFactory !== 'function') {
      throw new PersistenceError(
        'PERSISTENCE_INVALID_CONFIG',
        'Invalid persistence registration: useFactory',
      );
    }
    return {
      module: PersistenceTypeOrmModule,
      imports: options.imports,
      providers: [
        {
          provide: PERSISTENCE_RUNTIME,
          inject: [...(options.inject ?? [])],
          useFactory: async (...args: unknown[]) =>
            resolveRuntime(await options.useFactory(...args)),
        },
        dataSourceProvider(),
        PersistenceLifecycle,
      ],
      exports: [PERSISTENCE_DATA_SOURCE],
    };
  }
}
