import type { DataSource } from 'typeorm';
import type { AuditEntry } from '../../../core/application/audit/audit-writer.port';
import type {
  AuditReader,
  AuditTrailPage,
} from '../../../core/application/audit/audit-reader.port';
import {
  validateAuditTrailQuery,
  type AuditTrailQuery,
} from '../../../core/application/audit/audit-validation';
import { AUDIT_ENTRIES_TABLE } from './typeorm-audit-writer';

interface AuditRow {
  id: string;
  occurred_at: string | number;
  subject_id: string;
  tenant_id: string | null;
  correlation_id: string;
  action: string;
  target: string;
  outcome: AuditEntry['outcome'];
}

/**
 * Leitura de auditoria por tenant obrigatório, intervalo de tempo e ação opcional,
 * com paginação limitada. Ordena do mais recente para o mais antigo. Não verifica
 * permissão: a checagem `audit:read` fica em `readAuditTrail`.
 */
export class TypeOrmAuditReader implements AuditReader {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: AuditTrailQuery): Promise<AuditTrailPage> {
    const valid = validateAuditTrailQuery(query);
    const params: unknown[] = [valid.tenantId, valid.fromMs, valid.toMs];
    let filter = '';
    if (valid.action !== undefined) {
      params.push(valid.action);
      filter = ` AND action = $${params.length}`;
    }
    params.push(valid.limit, valid.offset);
    const rows: AuditRow[] = await this.dataSource.query(
      `SELECT id, occurred_at, subject_id, tenant_id, correlation_id, action, target, outcome
         FROM ${AUDIT_ENTRIES_TABLE}
        WHERE tenant_id = $1
          AND occurred_at >= $2::bigint
          AND occurred_at < $3::bigint${filter}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length - 1}::integer OFFSET $${params.length}::integer`,
      params,
    );
    return {
      items: rows.map(toEntry),
      limit: valid.limit,
      offset: valid.offset,
    };
  }
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    occurredAt: Number(row.occurred_at),
    context: {
      subjectId: row.subject_id,
      correlationId: row.correlation_id,
      ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    },
    action: row.action,
    target: row.target,
    outcome: row.outcome,
  };
}
