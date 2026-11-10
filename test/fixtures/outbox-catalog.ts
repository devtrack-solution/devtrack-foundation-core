import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';
import { IDEMPOTENCY_PERSISTENCE } from '../../src/native/persistence-typeorm/idempotency';
import { OUTBOX_PERSISTENCE } from '../../src/native/persistence-typeorm/outbox';
import { OUTBOX_FIXTURE_PERSISTENCE } from './outbox-business';

/** Catálogo de teste: outbox, inbox, idempotência (efeitos externos) e a tabela de negócio. */
export const OUTBOX_TEST_CONTRIBUTIONS: readonly PersistenceModuleContribution[] =
  [OUTBOX_PERSISTENCE, IDEMPOTENCY_PERSISTENCE, OUTBOX_FIXTURE_PERSISTENCE];
