import type { PersistenceModuleContribution } from '../../../src/native/persistence-typeorm';
import { BetaNoteOrmEntity } from './beta-note.orm-entity';
import { CreateBetaNotes1700000000002 } from './create-beta-notes.migration';

export { BetaNoteOrmEntity } from './beta-note.orm-entity';
export { CreateBetaNotes1700000000002 } from './create-beta-notes.migration';
export { BetaNoteRepository } from './beta-note.repository';

export const BETA_CONTRIBUTION: PersistenceModuleContribution = {
  moduleId: 'fixture-beta',
  entities: [BetaNoteOrmEntity],
  migrations: [CreateBetaNotes1700000000002],
};
