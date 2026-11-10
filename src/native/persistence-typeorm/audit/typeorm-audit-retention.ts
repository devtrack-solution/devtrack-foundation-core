import type { DataSource } from 'typeorm';
import {
  validatePurgeBatchSize,
  type AuditRetentionPolicy,
} from '../../../core/application/audit/audit-validation';
import { AUDIT_ENTRIES_TABLE } from './typeorm-audit-writer';

/**
 * Retenção própria da auditoria. Remove somente entradas com `occurred_at` anterior
 * ao corte da política, em lotes limitados. É a única via de DELETE: ativa o GUC
 * `foundation.audit.purge` apenas dentro da transação do lote. Independente de
 * retenção de logs e traces.
 */
export class TypeOrmAuditRetention {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: AuditRetentionPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  /** Remove até `batchSize` entradas vencidas e devolve a quantidade removida. */
  async purgeExpired(batchSize: number): Promise<number> {
    const limit = validatePurgeBatchSize(batchSize);
    const cutoffMs = this.now() - this.policy.retentionMs;
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('foundation.audit.purge', 'on', true)`,
      );
      const result: unknown = await manager.query(
        `WITH victims AS (
           SELECT id FROM ${AUDIT_ENTRIES_TABLE}
            WHERE occurred_at < $1::bigint
            ORDER BY occurred_at, id
            LIMIT $2::integer
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM ${AUDIT_ENTRIES_TABLE} a
          USING victims v
          WHERE a.id = v.id
         RETURNING a.id`,
        [cutoffMs, limit],
      );
      return returnedRows(result).length;
    });
  }
}

/** O driver devolve `[linhas, contagem]` para DELETE; normaliza para as linhas. */
function returnedRows(result: unknown): unknown[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0];
  }
  return Array.isArray(result) ? result : [];
}
