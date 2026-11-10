import type { PersistenceModuleContribution } from '../persistence-catalog';
import { CreateActivities1794345600000 } from './create-activities.migration';
import { ActivityOrmEntity } from './activity.orm-entity';

/**
 * Contribuição da Foundation para o catálogo de persistência. O integrador a
 * inclui em `PERSISTENCE_CONTRIBUTIONS` (runtime e CLI).
 */
export const ACTIVITIES_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'foundation/activities',
  entities: [ActivityOrmEntity],
  migrations: [CreateActivities1794345600000],
};
