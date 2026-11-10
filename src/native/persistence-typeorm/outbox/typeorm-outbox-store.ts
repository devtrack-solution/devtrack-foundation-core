import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type {
  ClaimedOutboxMessage,
  OutboxErrorCode,
  OutboxSnapshot,
} from '../../../core/application/outbox/outbox.model';
import type {
  ClaimInput,
  MarkFailedInput,
  MarkPublishedInput,
  OutboxStore,
} from '../../../core/application/outbox/outbox.ports';
import { PERSISTENCE_DATA_SOURCE } from '../persistence-typeorm.module';

interface OutboxRow {
  id: string;
  type: string;
  payload_version: number;
  payload: unknown;
  subject_id: string;
  tenant_id: string | null;
  correlation_id: string;
  trace_context: Record<string, string> | null;
  attempts: number;
  created_at_ms: string | number;
}

function toClaimed(row: OutboxRow): ClaimedOutboxMessage {
  return {
    id: row.id,
    type: row.type,
    payloadVersion: row.payload_version,
    payload: row.payload as ClaimedOutboxMessage['payload'],
    subjectId: row.subject_id,
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    correlationId: row.correlation_id,
    ...(row.trace_context === null ? {} : { traceContext: row.trace_context }),
    attempts: row.attempts,
    createdAt: Number(row.created_at_ms),
  };
}

/**
 * OutboxStore sobre PostgreSQL. A reivindicação é um único UPDATE sobre um
 * subconjunto `FOR UPDATE SKIP LOCKED`: relays concorrentes nunca reivindicam a
 * mesma linha, e a posse expira pelo `next_attempt_at_ms` (lease). Relay que cai
 * no meio do lote libera as mensagens quando o lease vence.
 */
@Injectable()
export class TypeOrmOutboxStore implements OutboxStore {
  constructor(
    @Inject(PERSISTENCE_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  async claimDue(input: ClaimInput): Promise<readonly ClaimedOutboxMessage[]> {
    const rows: OutboxRow[] = rowsOf(
      await this.dataSource.query(
        `UPDATE "outbox_messages" AS o
            SET "attempts" = o."attempts" + 1,
                "next_attempt_at_ms" = $1 + $3,
                "updated_at_ms" = $1
           FROM (
             SELECT "id" FROM "outbox_messages"
              WHERE "state" = 'pending' AND "next_attempt_at_ms" <= $1
              ORDER BY "next_attempt_at_ms", "id"
              LIMIT $2
              FOR UPDATE SKIP LOCKED
           ) AS due
          WHERE o."id" = due."id"
      RETURNING o."id", o."type", o."payload_version", o."payload", o."subject_id",
                o."tenant_id", o."correlation_id", o."trace_context", o."attempts",
                o."created_at_ms"`,
        [input.now, input.limit, input.leaseMs],
      ),
    );
    return rows.map(toClaimed);
  }

  async markPublished(input: MarkPublishedInput): Promise<void> {
    await this.dataSource.query(
      `UPDATE "outbox_messages"
          SET "state" = 'published', "published_at_ms" = $2,
              "last_error_code" = NULL, "updated_at_ms" = $2
        WHERE "id" = $1 AND "state" = 'pending'`,
      [input.id, input.now],
    );
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    await this.dataSource.query(
      `UPDATE "outbox_messages"
          SET "state" = CASE WHEN $3::boolean THEN 'failed' ELSE 'pending' END,
              "last_error_code" = $4, "next_attempt_at_ms" = $5, "updated_at_ms" = $6
        WHERE "id" = $1 AND "state" = 'pending' AND "attempts" = $2`,
      [
        input.id,
        input.attempts,
        input.terminal,
        input.errorCode satisfies OutboxErrorCode,
        input.nextAttemptAt,
        input.now,
      ],
    );
  }

  async snapshot(now: number): Promise<OutboxSnapshot> {
    const rows: Array<{
      pending: string | number;
      failed: string | number;
      oldest: string | number | null;
      max_attempts: number | null;
    }> = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE "state" = 'pending') AS pending,
         count(*) FILTER (WHERE "state" = 'failed') AS failed,
         min("created_at_ms") FILTER (WHERE "state" = 'pending') AS oldest,
         max("attempts") FILTER (WHERE "state" = 'pending') AS max_attempts
       FROM "outbox_messages"`,
    );
    const row = rows[0];
    const oldest = row?.oldest ?? null;
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestPendingAgeMs:
        oldest === null ? null : Math.max(0, now - Number(oldest)),
      maxPendingAttempts: Number(row?.max_attempts ?? 0),
    };
  }
}

/** Normaliza o retorno do driver para UPDATE ... RETURNING e SELECT. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0]))
    return result[0] as T[];
  return result as T[];
}
