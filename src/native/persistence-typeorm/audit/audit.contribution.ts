import type { PersistenceModuleContribution } from '../persistence-catalog';
import { AuditEntryOrmEntity } from './audit-entry.orm-entity';
import { CreateAuditEntries1794345600000 } from './create-audit-entries.migration';

/**
 * Contribuição da Foundation para a trilha de auditoria. O integrador a inclui em
 * `PERSISTENCE_CONTRIBUTIONS` do host (runtime e CLI). Não é incluída pelo módulo.
 */
export const AUDIT_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'foundation/audit',
  entities: [AuditEntryOrmEntity],
  migrations: [CreateAuditEntries1794345600000],
};
