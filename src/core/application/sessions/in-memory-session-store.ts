import type {
  SessionReference,
  SessionState,
} from '../../domain/sessions/session';
import type {
  AuthenticationMethod,
  Principal,
} from '../../domain/security/identity';
import type {
  AuthenticationSessions,
  Clock,
  NewRefreshToken,
  RefreshRotationRequest,
  RefreshRotationResult,
  RefreshRotationSnapshot,
  RefreshTokenStateValue,
  RefreshTokenStore,
} from '../security/authentication.ports';
import type { SessionReader } from './session-reader.port';

interface SessionRow {
  readonly id: string;
  readonly subjectId: string;
  state: SessionState;
  readonly method: AuthenticationMethod;
  readonly expiresAt: number;
}
interface RefreshRow {
  readonly digest: string;
  readonly sessionId: string;
  state: RefreshTokenStateValue;
  successorDigest: string | null;
  consumedAt: number | null;
  readonly clientBindingDigest: string;
  readonly idleExpiresAt: number;
}

/**
 * Store em memória com a mesma semântica do adapter TypeORM: operações síncronas
 * dentro de cada método garantem atomicidade equivalente ao lock de linha.
 * Destinado a testes unitários e composição de desenvolvimento, nunca como
 * fonte de verdade entre réplicas.
 */
export class InMemoryAuthSessionStore
  implements AuthenticationSessions, SessionReader, RefreshTokenStore
{
  private readonly sessions = new Map<string, SessionRow>();
  private readonly refreshes = new Map<string, RefreshRow>();
  private sequence = 0;

  constructor(
    private readonly options: {
      readonly clock: Clock;
      readonly absoluteTtlMs: number;
    },
  ) {}

  createPending(
    principal: Principal,
    method: AuthenticationMethod,
  ): Promise<SessionReference> {
    this.sequence += 1;
    const id = `session-${this.sequence}`;
    const expiresAt = this.options.clock.now() + this.options.absoluteTtlMs;
    this.sessions.set(id, {
      id,
      subjectId: principal.subjectId,
      state: 'pending',
      method,
      expiresAt,
    });
    return Promise.resolve({ id, expiresAt });
  }

  activate(sessionId: string): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (
      !row ||
      row.state !== 'pending' ||
      row.expiresAt <= this.options.clock.now()
    )
      return Promise.reject(new Error('session_not_activatable'));
    row.state = 'active';
    return Promise.resolve();
  }

  revoke(sessionId: string): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (row && row.state !== 'revoked') row.state = 'revoked';
    return Promise.resolve();
  }

  find(sessionId: string): Promise<
    | (SessionReference & {
        readonly subjectId: string;
        readonly state: SessionState;
      })
    | null
  > {
    const row = this.sessions.get(sessionId);
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      expiresAt: row.expiresAt,
      subjectId: row.subjectId,
      state: row.state,
    });
  }

  issue(input: NewRefreshToken): Promise<void> {
    if (!this.sessions.has(input.sessionId))
      return Promise.reject(new Error('unknown_session'));
    if (this.refreshes.has(input.digest))
      return Promise.reject(new Error('duplicate_refresh_digest'));
    this.refreshes.set(input.digest, {
      digest: input.digest,
      sessionId: input.sessionId,
      state: 'active',
      successorDigest: null,
      consumedAt: null,
      clientBindingDigest: input.clientBindingDigest,
      idleExpiresAt: input.idleExpiresAt,
    });
    return Promise.resolve();
  }

  rotate(request: RefreshRotationRequest): Promise<RefreshRotationResult> {
    const snapshot = this.snapshotOf(request.presentedDigest);
    const decision = request.decide(snapshot);
    const refresh = this.refreshes.get(request.presentedDigest);
    switch (decision.kind) {
      case 'rotate': {
        if (!refresh || refresh.state !== 'active' || !snapshot)
          throw new Error('refresh_cas_lost');
        refresh.state = 'consumed';
        refresh.consumedAt = request.now;
        refresh.successorDigest = decision.successorDigest;
        this.refreshes.set(decision.successorDigest, {
          digest: decision.successorDigest,
          sessionId: snapshot.sessionId,
          state: 'active',
          successorDigest: null,
          consumedAt: null,
          clientBindingDigest: snapshot.clientBindingDigest,
          idleExpiresAt: decision.successorIdleExpiresAt,
        });
        break;
      }
      case 'reuse':
        if (snapshot) this.revokeSessionNow(snapshot.sessionId);
        break;
      case 'conflict':
      case 'reject':
        break;
    }
    return Promise.resolve({ decision, snapshot });
  }

  revokeFamily(sessionId: string): Promise<void> {
    for (const refresh of this.refreshes.values())
      if (refresh.sessionId === sessionId && refresh.state === 'active')
        refresh.state = 'revoked';
    return Promise.resolve();
  }

  /** Test helper: reads the number of rows in state active for a session. */
  activeRefreshCount(sessionId: string): number {
    let count = 0;
    for (const refresh of this.refreshes.values())
      if (refresh.sessionId === sessionId && refresh.state === 'active')
        count += 1;
    return count;
  }

  private revokeSessionNow(sessionId: string): void {
    const row = this.sessions.get(sessionId);
    if (row) row.state = 'revoked';
    void this.revokeFamily(sessionId);
  }

  private snapshotOf(digest: string): RefreshRotationSnapshot | null {
    const refresh = this.refreshes.get(digest);
    if (!refresh) return null;
    const session = this.sessions.get(refresh.sessionId);
    if (!session) return null;
    const successor =
      refresh.successorDigest === null
        ? undefined
        : this.refreshes.get(refresh.successorDigest);
    return {
      sessionId: session.id,
      subjectId: session.subjectId,
      method: session.method,
      sessionState: session.state,
      sessionExpiresAt: session.expiresAt,
      refreshState: refresh.state,
      clientBindingDigest: refresh.clientBindingDigest,
      consumedAt: refresh.consumedAt,
      idleExpiresAt: refresh.idleExpiresAt,
      successorState: successor?.state ?? null,
    };
  }
}
