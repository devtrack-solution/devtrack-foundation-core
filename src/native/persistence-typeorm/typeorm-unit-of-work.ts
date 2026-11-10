import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataSource, EntityManager } from 'typeorm';
import type { UnitOfWork } from '../../core/application/persistence/unit-of-work.port';
import { PersistenceError } from './persistence-errors';

/** Constrói os recursos transacionais a partir do EntityManager da transação. */
export type TypeOrmResourcesFactory<Resources> = (
  manager: EntityManager,
) => Resources;

/** DataSource em cujo escopo assíncrono há uma transação ativa. */
const activeTransaction = new AsyncLocalStorage<DataSource>();

/**
 * Implementação TypeORM da porta UnitOfWork. Abre uma transação, entrega recursos
 * construídos pela fábrica do módulo e confirma ou desfaz todos juntos.
 *
 * O `work` deve conter apenas operações de banco pelos recursos recebidos. Não
 * faça chamadas de rede, filas, HTTP ou leituras de outros sistemas dentro dele:
 * a transação fica aberta durante o trabalho. Aninhar `run` no mesmo DataSource
 * lança PERSISTENCE_NESTED_TRANSACTION; use os recursos recebidos.
 */
export class TypeOrmUnitOfWork<Resources> implements UnitOfWork<Resources> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly createResources: TypeOrmResourcesFactory<Resources>,
  ) {}

  async run<Result>(
    work: (resources: Resources) => Promise<Result>,
  ): Promise<Result> {
    if (activeTransaction.getStore() === this.dataSource) {
      throw new PersistenceError(
        'PERSISTENCE_NESTED_TRANSACTION',
        'Nested unit of work is not allowed; use the resources received by the active work',
      );
    }
    return this.dataSource.transaction<Result>((manager) =>
      activeTransaction.run(this.dataSource, () =>
        work(this.createResources(manager)),
      ),
    );
  }
}
