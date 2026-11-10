import type { PersistenceModuleContribution } from '../persistence-catalog';
import { CreateInboxMessages1794691200000 } from './create-inbox-messages.migration';
import { CreateOutboxMessages1794604800000 } from './create-outbox-messages.migration';
import { InboxMessageOrmEntity } from './inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from './outbox-message.orm-entity';

/**
 * Contribuição da Foundation para outbox e inbox. O integrador a inclui em
 * `PERSISTENCE_CONTRIBUTIONS` (runtime e CLI).
 */
export const OUTBOX_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'foundation/outbox',
  entities: [OutboxMessageOrmEntity, InboxMessageOrmEntity],
  migrations: [
    CreateOutboxMessages1794604800000,
    CreateInboxMessages1794691200000,
  ],
};
