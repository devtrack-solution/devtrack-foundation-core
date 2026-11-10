import type { EntityManager } from 'typeorm';
import type {
  AuditEntry,
  AuditWriter,
} from '../../../core/application/audit/audit-writer.port';
import { toAuditRecord } from '../../../core/application/audit/audit-validation';

export const AUDIT_ENTRIES_TABLE = 'audit_entries';

/**
 * Writer TypeORM. Serializa somente os campos de `toAuditRecord`; propriedades extras
 * do objeto recebido nunca chegam ao SQL. Para escrever junto com o negócio, construa
 * o writer a partir do EntityManager da transação dentro da fábrica do UnitOfWork:
 * `new TypeOrmAuditWriter(manager)`. Não expõe update nem delete.
 */
export class TypeOrmAuditWriter implements AuditWriter {
  constructor(private readonly manager: Pick<EntityManager, 'query'>) {}

  async append(entry: AuditEntry): Promise<void> {
    const record = toAuditRecord(entry);
    await this.manager.query(
      `INSERT INTO ${AUDIT_ENTRIES_TABLE}
         (id, occurred_at, subject_id, tenant_id, correlation_id, action, target, outcome)
       VALUES ($1, $2::bigint, $3, $4::varchar, $5, $6, $7, $8)`,
      [
        record.id,
        record.occurredAt,
        record.subjectId,
        record.tenantId ?? null,
        record.correlationId,
        record.action,
        record.target,
        record.outcome,
      ],
    );
  }
}
