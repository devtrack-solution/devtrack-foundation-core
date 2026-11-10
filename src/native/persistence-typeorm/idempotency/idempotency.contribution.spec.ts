import { buildPersistenceCatalog } from '../persistence-catalog';
import { IDEMPOTENCY_RECORDS_TABLE } from './typeorm-idempotency.store';
import { IDEMPOTENCY_PERSISTENCE } from './idempotency.contribution';

describe('IDEMPOTENCY_PERSISTENCE contribution', () => {
  it('declares the module id, the entity and the migration', () => {
    expect(IDEMPOTENCY_PERSISTENCE.moduleId).toBe('foundation/idempotency');
    expect(IDEMPOTENCY_PERSISTENCE.entities).toHaveLength(1);
    expect(IDEMPOTENCY_PERSISTENCE.migrations).toHaveLength(2);
  });

  it('builds a valid catalog that owns the idempotency table', () => {
    const catalog = buildPersistenceCatalog([IDEMPOTENCY_PERSISTENCE]);
    expect(catalog.modules).toEqual(['foundation/idempotency']);
    expect(catalog.tables).toEqual([IDEMPOTENCY_RECORDS_TABLE]);
    expect(catalog.migrationNames).toEqual([
      'CreateIdempotencyRecords1794259200000',
      'AddIdempotencyLease1794432000000',
    ]);
  });
});
