import type { PersistenceModuleContribution } from '../../../src/native/persistence-typeorm';
import { AlphaItemOrmEntity } from './alpha-item.orm-entity';
import { CreateAlphaItems1700000000001 } from './create-alpha-items.migration';

export { AlphaItemOrmEntity } from './alpha-item.orm-entity';
export { CreateAlphaItems1700000000001 } from './create-alpha-items.migration';
export { AlphaItemRepository } from './alpha-item.repository';

export const ALPHA_CONTRIBUTION: PersistenceModuleContribution = {
  moduleId: 'fixture-alpha',
  entities: [AlphaItemOrmEntity],
  migrations: [CreateAlphaItems1700000000001],
};
