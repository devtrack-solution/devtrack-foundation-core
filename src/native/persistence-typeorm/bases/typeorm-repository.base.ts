import type {
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';

/**
 * Base técnica de repositório TypeORM. Recebe o EntityManager transacional
 * entregue pelo UnitOfWork; nunca cria conexão própria.
 */
export abstract class TypeOrmRepositoryBase<Entity extends ObjectLiteral> {
  constructor(
    protected readonly manager: EntityManager,
    private readonly target: EntityTarget<Entity>,
  ) {}

  protected get repository(): Repository<Entity> {
    return this.manager.getRepository(this.target);
  }
}
