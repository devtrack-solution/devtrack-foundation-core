import type { DataSource } from 'typeorm';
import {
  IdempotencyPolicyError,
  IdempotencyStaleClaimError,
} from '../../../core/application/idempotency/idempotency.errors';
import {
  IDEMPOTENCY_LIMITS,
  type IdempotencyBeginRequest,
  type IdempotencyBeginResult,
  type IdempotencyClaimRef,
  type IdempotencyCompleteRequest,
  type IdempotencyFailRequest,
  type IdempotencyFailureClass,
  type IdempotencyHeartbeatRequest,
  type IdempotencyRecord,
  type IdempotencyResolveRequest,
  type IdempotencyStore,
  type IdempotencyState,
  type JsonValue,
} from '../../../core/application/idempotency/idempotency.types';

export const IDEMPOTENCY_RECORDS_TABLE = 'idempotency_records';

const FAILURE_STATE: Record<IdempotencyFailureClass, IdempotencyState> = {
  retryable: 'failed_retryable',
  terminal: 'failed_terminal',
  unknown: 'outcome_unknown',
};

/** Tentativas da reivindicação quando a linha some entre o UPSERT e a leitura (purge concorrente). */
const BEGIN_ATTEMPTS = 3;

/** Subconjunto de DataSource e EntityManager usado pelo store. */
export interface IdempotencyQueryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

interface IdempotencyRow {
  idempotency_key: string;
  operation_id: string;
  subject_id: string;
  tenant_id: string | null;
  fingerprint: string;
  state: IdempotencyState;
  claim_token: string;
  result: JsonValue | null;
  failure_class: IdempotencyFailureClass | null;
  lease_expires_at_ms: string | number | null;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  expires_at_ms: string | number;
  version: number;
}

const SELECT_COLUMNS = `
  idempotency_key, operation_id, subject_id, tenant_id, fingerprint, state,
  claim_token, result, failure_class, lease_expires_at_ms, created_at_ms,
  updated_at_ms, expires_at_ms, version`;

/**
 * Store TypeORM (PostgreSQL). Cada operação é uma instrução SQL atômica. A
 * reivindicação é um INSERT ... ON CONFLICT DO UPDATE com a cláusula WHERE de
 * `isClaimable`. Heartbeat, conclusão, falha e resolução exigem token, versão e
 * estado `in_progress` no próprio UPDATE; conclusão e falha exigem também lease
 * vigente no instante informado.
 *
 * Construído sobre um DataSource para uso comum, ou sobre o EntityManager da
 * transação para concluir dentro do UnitOfWork (`new TypeOrmIdempotencyStore(manager)`).
 * `purgeExpired` nunca remove `in_progress`: apagar um executor vivo permitiria
 * uma segunda execução.
 */
export class TypeOrmIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: IdempotencyQueryable | DataSource) {}

  async begin(
    request: IdempotencyBeginRequest,
  ): Promise<IdempotencyBeginResult> {
    for (let attempt = 0; attempt < BEGIN_ATTEMPTS; attempt += 1) {
      const rows = returnedRows<IdempotencyRow>(
        await this.db.query(
          `INSERT INTO ${IDEMPOTENCY_RECORDS_TABLE}
           (idempotency_key, operation_id, subject_id, tenant_id, fingerprint, state,
            claim_token, result, failure_class, lease_expires_at_ms,
            created_at_ms, updated_at_ms, expires_at_ms, version)
         VALUES ($1, $2, $3, $4::varchar, $5, 'in_progress', $6, NULL, NULL, $9::bigint,
            $7::bigint, $7::bigint, $8::bigint, 1)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           operation_id = EXCLUDED.operation_id,
           subject_id = EXCLUDED.subject_id,
           tenant_id = EXCLUDED.tenant_id,
           fingerprint = EXCLUDED.fingerprint,
           state = 'in_progress',
           claim_token = EXCLUDED.claim_token,
           result = NULL,
           failure_class = NULL,
           lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
           created_at_ms = EXCLUDED.created_at_ms,
           updated_at_ms = EXCLUDED.updated_at_ms,
           expires_at_ms = EXCLUDED.expires_at_ms,
           version = ${IDEMPOTENCY_RECORDS_TABLE}.version + 1
         WHERE ${IDEMPOTENCY_RECORDS_TABLE}.state = 'failed_retryable'
            OR (${IDEMPOTENCY_RECORDS_TABLE}.state = 'in_progress'
                AND ${IDEMPOTENCY_RECORDS_TABLE}.lease_expires_at_ms <= $7::bigint
                AND (${IDEMPOTENCY_RECORDS_TABLE}.fingerprint = EXCLUDED.fingerprint
                     OR ${IDEMPOTENCY_RECORDS_TABLE}.expires_at_ms <= $7::bigint))
            OR (${IDEMPOTENCY_RECORDS_TABLE}.state NOT IN ('in_progress', 'failed_retryable')
                AND ${IDEMPOTENCY_RECORDS_TABLE}.expires_at_ms <= $7::bigint)
         RETURNING ${SELECT_COLUMNS}`,
          [
            request.key,
            request.operationId,
            request.subjectId,
            request.tenantId ?? null,
            request.fingerprint,
            request.claimToken,
            request.now,
            request.expiresAt,
            request.leaseExpiresAt,
          ],
        ),
      );
      if (rows.length === 1)
        return { outcome: 'claimed', record: toRecord(rows[0]) };

      const existing = await this.find(request.key);
      if (existing !== null) return { outcome: 'existing', record: existing };
    }
    throw new IdempotencyStaleClaimError();
  }

  async heartbeat(request: IdempotencyHeartbeatRequest): Promise<void> {
    const rows = returnedRows<{ idempotency_key: string }>(
      await this.db.query(
        `UPDATE ${IDEMPOTENCY_RECORDS_TABLE} SET
         lease_expires_at_ms = $4::bigint,
         updated_at_ms = $5::bigint
       WHERE idempotency_key = $1
         AND claim_token = $2
         AND version = $3
         AND state = 'in_progress'
       RETURNING idempotency_key`,
        [
          request.key,
          request.claimToken,
          request.version,
          request.leaseExpiresAt,
          request.now,
        ],
      ),
    );
    if (rows.length !== 1) throw new IdempotencyStaleClaimError();
  }

  async complete(request: IdempotencyCompleteRequest): Promise<void> {
    await this.transition(request, {
      state: 'completed',
      resultJson: JSON.stringify(request.result),
      failureClass: null,
    });
  }

  async fail(request: IdempotencyFailRequest): Promise<void> {
    await this.transition(request, {
      state: FAILURE_STATE[request.failureClass],
      resultJson: null,
      failureClass: request.failureClass,
    });
  }

  async resolveOutcomeUnknown(
    request: IdempotencyResolveRequest,
  ): Promise<void> {
    const failureClass =
      request.state === 'failed_retryable'
        ? 'retryable'
        : request.state === 'failed_terminal'
          ? 'terminal'
          : null;
    const rows = returnedRows<{ idempotency_key: string }>(
      await this.db.query(
        `UPDATE ${IDEMPOTENCY_RECORDS_TABLE} SET
         state = $3,
         result = $4::jsonb,
         failure_class = $5,
         lease_expires_at_ms = NULL,
         updated_at_ms = $6::bigint,
         version = version + 1
       WHERE idempotency_key = $1
         AND version = $2
         AND state = 'outcome_unknown'
       RETURNING idempotency_key`,
        [
          request.key,
          request.expectedVersion,
          request.state,
          request.result === undefined ? null : JSON.stringify(request.result),
          failureClass,
          request.now,
        ],
      ),
    );
    if (rows.length !== 1) throw new IdempotencyStaleClaimError();
  }

  async find(key: string): Promise<IdempotencyRecord | null> {
    const rows = returnedRows<IdempotencyRow>(
      await this.db.query(
        `SELECT ${SELECT_COLUMNS} FROM ${IDEMPOTENCY_RECORDS_TABLE} WHERE idempotency_key = $1`,
        [key],
      ),
    );
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async purgeExpired(request: {
    readonly now: number;
    readonly limit: number;
  }): Promise<number> {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > IDEMPOTENCY_LIMITS.maxPurgeBatch
    )
      throw new IdempotencyPolicyError();
    const rows = returnedRows<{ id: number }>(
      await this.db.query(
        `WITH victims AS (
         SELECT id FROM ${IDEMPOTENCY_RECORDS_TABLE}
         WHERE expires_at_ms <= $1::bigint
           AND state <> 'in_progress'
         ORDER BY expires_at_ms, id
         LIMIT $2::integer
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM ${IDEMPOTENCY_RECORDS_TABLE} r
       USING victims v
       WHERE r.id = v.id
       RETURNING r.id`,
        [request.now, request.limit],
      ),
    );
    return rows.length;
  }

  /**
   * UPDATE condicional: token, versão, `in_progress` e lease vigente em `now`.
   * Uma linha afetada é a única forma de sucesso; zero linhas é executor obsoleto.
   */
  private async transition(
    request: IdempotencyClaimRef & { readonly now: number },
    change: {
      readonly state: IdempotencyState;
      readonly resultJson: string | null;
      readonly failureClass: IdempotencyFailureClass | null;
    },
  ): Promise<void> {
    const rows = returnedRows<{ idempotency_key: string }>(
      await this.db.query(
        `UPDATE ${IDEMPOTENCY_RECORDS_TABLE} SET
         state = $5,
         result = $6::jsonb,
         failure_class = $7,
         lease_expires_at_ms = NULL,
         updated_at_ms = $4::bigint,
         version = version + 1
       WHERE idempotency_key = $1
         AND claim_token = $2
         AND version = $3
         AND state = 'in_progress'
         AND lease_expires_at_ms > $4::bigint
       RETURNING idempotency_key`,
        [
          request.key,
          request.claimToken,
          request.version,
          request.now,
          change.state,
          change.resultJson,
          change.failureClass,
        ],
      ),
    );
    if (rows.length !== 1) throw new IdempotencyStaleClaimError();
  }
}

/**
 * O driver pg do TypeORM devolve `[linhas, contagem]` para UPDATE e DELETE e apenas
 * as linhas para SELECT e INSERT. Normaliza para a lista de linhas em todos os casos.
 */
function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  )
    return result[0] as T[];
  return result as T[];
}

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    key: row.idempotency_key,
    operationId: row.operation_id,
    subjectId: row.subject_id,
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    fingerprint: row.fingerprint,
    state: row.state,
    claimToken: row.claim_token,
    // jsonb 'null' is a valid completed result; only non-completed rows lack one.
    ...(row.state === 'completed' ? { result: row.result ?? null } : {}),
    ...(row.failure_class === null ? {} : { failureClass: row.failure_class }),
    leaseExpiresAt:
      row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms),
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    expiresAt: Number(row.expires_at_ms),
    version: Number(row.version),
  };
}
