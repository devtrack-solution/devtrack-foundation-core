import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';
import { AUDIT_PERSISTENCE } from '../../src/native/persistence-typeorm/audit';
import { IDEMPOTENCY_PERSISTENCE } from '../../src/native/persistence-typeorm/idempotency';
import { IDEMPOTENCY_FIXTURE_PERSISTENCE } from './idempotency-business';

/** Catálogo de teste que inclui idempotência, auditoria e a tabela de negócio, como faria um host. */
export const IDEMPOTENCY_TEST_CONTRIBUTIONS: readonly PersistenceModuleContribution[] =
  [IDEMPOTENCY_PERSISTENCE, AUDIT_PERSISTENCE, IDEMPOTENCY_FIXTURE_PERSISTENCE];
