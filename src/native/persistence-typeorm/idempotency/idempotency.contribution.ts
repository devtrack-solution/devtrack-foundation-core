import type { PersistenceModuleContribution } from '../persistence-catalog';
import { AddIdempotencyLease1794432000000 } from './add-idempotency-lease.migration';
import { CreateIdempotencyRecords1794259200000 } from './create-idempotency-records.migration';
import { IdempotencyRecordOrmEntity } from './idempotency-record.orm-entity';

/**
 * Contribuição da Foundation para o catálogo de persistência. O integrador a
 * inclui na lista `PERSISTENCE_CONTRIBUTIONS` do host (runtime e CLI).
 */
export const IDEMPOTENCY_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'foundation/idempotency',
  entities: [IdempotencyRecordOrmEntity],
  migrations: [
    CreateIdempotencyRecords1794259200000,
    AddIdempotencyLease1794432000000,
  ],
};
