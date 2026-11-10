import type { DataSource, EntityManager } from 'typeorm';
import type {
  NewRefreshToken,
  RefreshRotationDecision,
  RefreshRotationRequest,
  RefreshRotationResult,
  RefreshRotationSnapshot,
  RefreshTokenStateValue,
  RefreshTokenStore,
} from '../../../core/application/security/authentication.ports';
import { AUTH_SESSIONS_TABLE } from './typeorm-authentication-sessions';
import {
  decodeMethod,
  epochMs,
  returnedRows,
} from './session-persistence.shared';

export const REFRESH_TOKENS_TABLE = 'auth_refresh_tokens';

interface SnapshotRow {
  session_id: string;
  subject_id: string;
  method: string;
  session_state: RefreshRotationSnapshot['sessionState'];
  session_expires_at: string | number;
  refresh_state: RefreshTokenStateValue;
  client_binding_digest: string;
  consumed_at: string | number | null;
  idle_expires_at: string | number;
  successor_state: RefreshTokenStateValue | null;
}

/**
 * Rotação atômica em PostgreSQL. A ordem de bloqueio é sempre sessão e depois
 * refresh, o que serializa rotações, revogações e a criação de sucessores da
 * mesma família. O CAS `active -> consumed` confere linha afetada e é a única
 * transição que cria sucessor.
 */
export class TypeOrmRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly dataSource: DataSource) {}

  async issue(input: NewRefreshToken): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ${REFRESH_TOKENS_TABLE}
         (digest, session_id, state, successor_digest, consumed_at, client_binding_digest, idle_expires_at, created_at)
       VALUES ($1, $2, 'active', NULL, NULL, $3, $4::bigint, $5::bigint)`,
      [
        input.digest,
        input.sessionId,
        input.clientBindingDigest,
        input.idleExpiresAt,
        input.now,
      ],
    );
  }

  async rotate(
    request: RefreshRotationRequest,
  ): Promise<RefreshRotationResult> {
    return this.dataSource.transaction(async (manager) => {
      const pointer: Array<{ session_id: string }> = await manager.query(
        `SELECT session_id FROM ${REFRESH_TOKENS_TABLE} WHERE digest = $1`,
        [request.presentedDigest],
      );
      if (pointer.length === 0) {
        return {
          decision: request.decide(null),
          snapshot: null,
        };
      }
      const sessionId = pointer[0].session_id;
      await manager.query(
        `SELECT id FROM ${AUTH_SESSIONS_TABLE} WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const snapshot = await readSnapshot(manager, request.presentedDigest);
      const decision = request.decide(snapshot);
      await applyDecision(manager, decision, request, snapshot);
      return { decision, snapshot };
    });
  }

  async revokeFamily(sessionId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM ${AUTH_SESSIONS_TABLE} WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      await manager.query(
        `UPDATE ${REFRESH_TOKENS_TABLE} SET state = 'revoked'
         WHERE session_id = $1 AND state = 'active'`,
        [sessionId],
      );
    });
  }
}

async function readSnapshot(
  manager: EntityManager,
  presentedDigest: string,
): Promise<RefreshRotationSnapshot | null> {
  const rows: SnapshotRow[] = await manager.query(
    `SELECT s.id AS session_id, s.subject_id, s.method, s.state AS session_state,
            s.expires_at AS session_expires_at,
            r.state AS refresh_state, r.client_binding_digest, r.consumed_at,
            r.idle_expires_at,
            (SELECT x.state FROM ${REFRESH_TOKENS_TABLE} x
              WHERE x.digest = r.successor_digest) AS successor_state
       FROM ${REFRESH_TOKENS_TABLE} r
       JOIN ${AUTH_SESSIONS_TABLE} s ON s.id = r.session_id
      WHERE r.digest = $1
      FOR UPDATE OF r`,
    [presentedDigest],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    subjectId: row.subject_id,
    method: decodeMethod(row.method),
    sessionState: row.session_state,
    sessionExpiresAt: epochMs(row.session_expires_at) ?? 0,
    refreshState: row.refresh_state,
    clientBindingDigest: row.client_binding_digest,
    consumedAt: epochMs(row.consumed_at),
    idleExpiresAt: epochMs(row.idle_expires_at) ?? 0,
    successorState: row.successor_state,
  };
}

async function applyDecision(
  manager: EntityManager,
  decision: RefreshRotationDecision,
  request: RefreshRotationRequest,
  snapshot: RefreshRotationSnapshot | null,
): Promise<void> {
  switch (decision.kind) {
    case 'rotate': {
      if (snapshot === null) throw new Error('refresh_rotation_without_state');
      const consumed = returnedRows<{ digest: string }>(
        await manager.query(
          `UPDATE ${REFRESH_TOKENS_TABLE}
             SET state = 'consumed', consumed_at = $2::bigint, successor_digest = $3
           WHERE digest = $1 AND state = 'active'
           RETURNING digest`,
          [request.presentedDigest, request.now, decision.successorDigest],
        ),
      );
      if (consumed.length !== 1) throw new Error('refresh_cas_lost');
      await manager.query(
        `INSERT INTO ${REFRESH_TOKENS_TABLE}
           (digest, session_id, state, successor_digest, consumed_at, client_binding_digest, idle_expires_at, created_at)
         VALUES ($1, $2, 'active', NULL, NULL, $3, $4::bigint, $5::bigint)`,
        [
          decision.successorDigest,
          snapshot.sessionId,
          snapshot.clientBindingDigest,
          decision.successorIdleExpiresAt,
          request.now,
        ],
      );
      return;
    }
    case 'reuse': {
      if (snapshot === null) return;
      await manager.query(
        `UPDATE ${AUTH_SESSIONS_TABLE}
           SET state = 'revoked', revoked_at = $2::bigint
         WHERE id = $1 AND state IN ('pending', 'active')`,
        [snapshot.sessionId, request.now],
      );
      await manager.query(
        `UPDATE ${REFRESH_TOKENS_TABLE} SET state = 'revoked'
         WHERE session_id = $1 AND state = 'active'`,
        [snapshot.sessionId],
      );
      return;
    }
    case 'conflict':
    case 'reject':
      return;
  }
}
