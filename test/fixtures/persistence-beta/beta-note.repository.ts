import type { EntityManager } from 'typeorm';
import { TypeOrmRepositoryBase } from '../../../src/native/persistence-typeorm';
import { BetaNoteOrmEntity } from './beta-note.orm-entity';

export class BetaNoteRepository extends TypeOrmRepositoryBase<BetaNoteOrmEntity> {
  constructor(manager: EntityManager) {
    super(manager, BetaNoteOrmEntity);
  }

  async add(id: string, body: string): Promise<void> {
    await this.repository.insert({ id, body });
  }

  async count(): Promise<number> {
    return this.repository.count();
  }
}
