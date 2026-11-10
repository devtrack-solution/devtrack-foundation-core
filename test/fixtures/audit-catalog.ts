import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';
import { AUDIT_PERSISTENCE } from '../../src/native/persistence-typeorm/audit';
import { AUDIT_FIXTURE_PERSISTENCE } from './audit-business';

/** Catálogo de teste: a contribuição de auditoria somada a um módulo de negócio fictício. */
export const AUDIT_TEST_CONTRIBUTIONS: readonly PersistenceModuleContribution[] =
  [AUDIT_PERSISTENCE, AUDIT_FIXTURE_PERSISTENCE];
