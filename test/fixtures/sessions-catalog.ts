import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';
import { SESSIONS_PERSISTENCE } from '../../src/native/persistence-typeorm/sessions';

/** Catálogo de teste que inclui a contribuição de sessões, como faria um host. */
export const SESSIONS_TEST_CONTRIBUTIONS: readonly PersistenceModuleContribution[] =
  [SESSIONS_PERSISTENCE];
