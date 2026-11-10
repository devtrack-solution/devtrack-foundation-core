import type { PersistenceModuleContribution } from './persistence-catalog';
import { ACTIVITIES_PERSISTENCE } from './activities/activities.contribution';
import { AUDIT_PERSISTENCE } from './audit/audit.contribution';
import { IDEMPOTENCY_PERSISTENCE } from './idempotency/idempotency.contribution';
import { OUTBOX_PERSISTENCE } from './outbox/outbox.contribution';
import { SESSIONS_PERSISTENCE } from './sessions/sessions.contribution';

export const PERSISTENCE_CONTRIBUTIONS: readonly PersistenceModuleContribution[] =
  [
    ACTIVITIES_PERSISTENCE,
    AUDIT_PERSISTENCE,
    IDEMPOTENCY_PERSISTENCE,
    OUTBOX_PERSISTENCE,
    SESSIONS_PERSISTENCE,
  ];
