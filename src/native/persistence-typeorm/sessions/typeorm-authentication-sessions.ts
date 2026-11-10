import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type {
  AuthenticationMethod,
  Principal,
} from '../../../core/domain/security/identity';
import type { SessionReference } from '../../../core/domain/sessions/session';
import type {
  AuthenticationSessions,
  Clock,
} from '../../../core/application/security/authentication.ports';
import { encodeMethod, returnedRows } from './session-persistence.shared';

export const AUTH_SESSIONS_TABLE = 'auth_sessions';

export interface TypeOrmAuthenticationSessionsOptions {
  readonly dataSource: DataSource;
  readonly clock: Clock;
  /** Expiração absoluta da sessão, fixada na criação. */
  readonly absoluteTtlMs: number;
}

/**
 * Sessões em PostgreSQL. Cada transição é uma instrução condicionada ao estado
 * anterior; a ativação exige affected row = 1. Sem cache positivo: toda leitura
 * consulta o banco compartilhado.
 */
export class TypeOrmAuthenticationSessions implements AuthenticationSessions {
  constructor(private readonly options: TypeOrmAuthenticationSessionsOptions) {
    if (
      !Number.isSafeInteger(options.absoluteTtlMs) ||
      options.absoluteTtlMs <= 0
    )
      throw new Error('Invalid absolute session TTL');
  }

  async createPending(
    principal: Principal,
    method: AuthenticationMethod,
  ): Promise<SessionReference> {
    const now = this.options.clock.now();
    const id = randomUUID();
    const expiresAt = now + this.options.absoluteTtlMs;
    await this.options.dataSource.query(
      `INSERT INTO ${AUTH_SESSIONS_TABLE}
         (id, subject_id, tenant_id, state, method, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, 'pending', $4, $5::bigint, $6::bigint, NULL)`,
      [
        id,
        principal.subjectId,
        principal.tenantId ?? null,
        encodeMethod(method),
        now,
        expiresAt,
      ],
    );
    return { id, expiresAt };
  }

  async activate(sessionId: string): Promise<void> {
    const rows = returnedRows<{ id: string }>(
      await this.options.dataSource.query(
        `UPDATE ${AUTH_SESSIONS_TABLE}
           SET state = 'active'
         WHERE id = $1 AND state = 'pending' AND expires_at > $2::bigint
         RETURNING id`,
        [sessionId, this.options.clock.now()],
      ),
    );
    if (rows.length !== 1) throw new Error('session_not_activatable');
  }

  /** Idempotente. Refresh tokens da família são revogados pelo store de refresh. */
  async revoke(sessionId: string): Promise<void> {
    await this.options.dataSource.query(
      `UPDATE ${AUTH_SESSIONS_TABLE}
         SET state = 'revoked', revoked_at = $2::bigint
       WHERE id = $1 AND state IN ('pending', 'active')`,
      [sessionId, this.options.clock.now()],
    );
  }
}
