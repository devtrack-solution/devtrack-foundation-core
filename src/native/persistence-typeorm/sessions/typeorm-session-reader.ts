import type { DataSource } from 'typeorm';
import type { SessionState } from '../../../core/domain/sessions/session';
import type { SessionReader } from '../../../core/application/sessions/session-reader.port';
import { AUTH_SESSIONS_TABLE } from './typeorm-authentication-sessions';
import { epochMs } from './session-persistence.shared';

interface SessionRow {
  id: string;
  subject_id: string;
  state: SessionState;
  expires_at: string | number;
}

/** Leitura autoritativa a cada chamada. Erro de banco propaga e o guard falha fechado. */
export class TypeOrmSessionReader implements SessionReader {
  constructor(private readonly dataSource: DataSource) {}

  async find(sessionId: string): Promise<{
    readonly id: string;
    readonly expiresAt: number;
    readonly subjectId: string;
    readonly state: SessionState;
  } | null> {
    const rows: SessionRow[] = await this.dataSource.query(
      `SELECT id, subject_id, state, expires_at FROM ${AUTH_SESSIONS_TABLE} WHERE id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      expiresAt: epochMs(row.expires_at) ?? 0,
      subjectId: row.subject_id,
      state: row.state,
    };
  }
}
