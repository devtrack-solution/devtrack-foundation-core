import type { EntityManager } from 'typeorm';
import { TypeOrmRepositoryBase } from '../../../src/native/persistence-typeorm';
import { AlphaItemOrmEntity } from './alpha-item.orm-entity';

export class AlphaItemRepository extends TypeOrmRepositoryBase<AlphaItemOrmEntity> {
  constructor(manager: EntityManager) {
    super(manager, AlphaItemOrmEntity);
  }

  async add(id: string, label: string): Promise<void> {
    await this.repository.insert({ id, label });
  }

  async count(): Promise<number> {
    return this.repository.count();
  }
}
