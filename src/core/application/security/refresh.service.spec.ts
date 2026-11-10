/* eslint-disable @typescript-eslint/unbound-method -- Jest inspects mock methods without invoking unbound methods. */
import type { AuditEntry, AuditWriter } from '../audit/audit-writer.port';
import { InMemoryAuthSessionStore } from '../sessions/in-memory-session-store';
import type {
  AccessTokenIssuer,
  IdentityAccessResolver,
  PasswordCredentialsVerifier,
  RefreshTokenSecrets,
} from './authentication.ports';
import {
  AuthenticationError,
  AuthenticationService,
} from './authentication.service';
import type { AuthenticationDependencies } from './authentication.service';

const principal = { subjectId: 'internal-1', permissions: ['read'] };
const credentials = { username: 'user', password: 'private-password' };
const ACCESS_TTL = 600;
const ABSOLUTE_TTL = 30_000;
const IDLE_TTL = 5_000;
const GRACE = 10_000;
const BIND_A = { clientBinding: 'browser-a' };
const BIND_B = { clientBinding: 'browser-b' };

function fixture(
  overrides: { graceWindowMs?: number; idleTtlMs?: number } = {},
) {
  let now = 1_000;
  const clock = { now: () => now };
  const store = new InMemoryAuthSessionStore({
    clock,
    absoluteTtlMs: ABSOLUTE_TTL,
  });
  let tokenCounter = 0;
  const secrets: RefreshTokenSecrets = {
    generate: () => {
      tokenCounter += 1;
      return `refresh-value-${tokenCounter}`;
    },
    digest: (value: string) => `digest(${value})`,
  };
  const password: jest.Mocked<PasswordCredentialsVerifier> = {
    verify: jest.fn().mockResolvedValue({ subjectId: principal.subjectId }),
  };
  const identities: jest.Mocked<IdentityAccessResolver> = {
    bySubject: jest.fn().mockResolvedValue(principal),
    byExternalIdentity: jest.fn().mockResolvedValue(principal),
  };
  const tokens: jest.Mocked<AccessTokenIssuer> = {
    issue: jest
      .fn()
      .mockImplementation(
        ({ session }: { session: { id: string; expiresAt: number } }) =>
          Promise.resolve({
            value: `access-${session.id}-${now}`,
            expiresAt: Math.min(now + ACCESS_TTL, session.expiresAt),
          }),
      ),
  };
  const writes: AuditEntry[] = [];
  const writer: jest.Mocked<AuditWriter> = {
    append: jest.fn().mockImplementation((entry: AuditEntry) => {
      writes.push(entry);
      return Promise.resolve();
    }),
  };
  const ports: AuthenticationDependencies = {
    password,
    identities,
    sessions: store,
    tokens,
    clock,
    refresh: {
      store,
      secrets,
      idleTtlMs: overrides.idleTtlMs ?? IDLE_TTL,
      graceWindowMs: overrides.graceWindowMs ?? GRACE,
    },
    audit: { writer, newEntryId: () => `entry-${writes.length + 1}` },
  };
  return {
    store,
    tokens,
    identities,
    password,
    writer,
    writes,
    ports,
    service: new AuthenticationService(ports),
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

async function loginRefresh(f: ReturnType<typeof fixture>) {
  const login = await f.service.loginWithPassword(credentials, BIND_A);
  return {
    login,
    refreshToken: login.refreshToken as string,
    sessionId: login.sessionId,
  };
}

describe('AuthenticationService refresh (D2)', () => {
  it('keeps the previous login result when no refresh store is composed', async () => {
    const f = fixture();
    const service = new AuthenticationService({
      ...f.ports,
      refresh: undefined,
      audit: undefined,
    });
    const result = await service.loginWithPassword(credentials);
    expect(Object.keys(result).sort()).toEqual([
      'accessToken',
      'expiresAt',
      'sessionId',
      'subjectId',
      'tokenType',
    ]);
    await expect(
      service.refresh({ refreshToken: 'anything', clientBinding: 'browser-a' }),
    ).rejects.toEqual(new AuthenticationError('authentication_unavailable'));
  });

  it('returns refreshToken and refreshExpiresAt on login when the store is composed', async () => {
    const f = fixture();
    const { login } = await loginRefresh(f);
    expect(login.refreshToken).toMatch(/^refresh-value-/);
    expect(login.refreshExpiresAt).toBe(1_000 + IDLE_TTL);
  });

  it('requires a client binding for login when refresh is composed', async () => {
    const f = fixture();
    await expect(f.service.loginWithPassword(credentials)).rejects.toEqual(
      new AuthenticationError('invalid_credentials'),
    );
    expect(f.tokens.issue).not.toHaveBeenCalled();
  });

  it('rotation creates exactly one active successor and consumes the presented token', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(100);
    const rotated = await f.service.refresh({
      refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    expect(rotated.refreshToken).not.toBe(refreshToken);
    expect(rotated.sessionId).toBe(sessionId);
    expect(f.store.activeRefreshCount(sessionId)).toBe(1);
    const session = await f.store.find(sessionId);
    expect(session?.state).toBe('active');
  });

  it('retry inside the grace window with the same binding returns refresh_conflict without a new successor', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(100);
    await f.service.refresh({
      refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    f.advance(1_000);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('refresh_conflict'));
    expect(f.store.activeRefreshCount(sessionId)).toBe(1);
    expect((await f.store.find(sessionId))?.state).toBe('active');
    expect(f.writes.map((w) => w.action)).toContain('session.refresh_conflict');
  });

  it('the same refresh with another binding is reuse and revokes the session', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(100);
    await f.service.refresh({
      refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    f.advance(100);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_B.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect((await f.store.find(sessionId))?.state).toBe('revoked');
    expect(f.store.activeRefreshCount(sessionId)).toBe(0);
    expect(f.writes.map((w) => w.action)).toContain(
      'session.refresh_reuse_revoked',
    );
  });

  it('reuse after the successor was used revokes the whole session', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(100);
    const second = await f.service.refresh({
      refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    f.advance(100);
    await f.service.refresh({
      refreshToken: second.refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    f.advance(100);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect((await f.store.find(sessionId))?.state).toBe('revoked');
  });

  it('after the grace window a consumed refresh is reuse even with the same binding', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(100);
    await f.service.refresh({
      refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    f.advance(GRACE + 1);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect((await f.store.find(sessionId))?.state).toBe('revoked');
  });

  it('a zero grace window turns an immediate retry into reuse', async () => {
    const f = fixture({ graceWindowMs: 0 });
    const { refreshToken, sessionId } = await loginRefresh(f);
    await f.service.refresh({
      refreshToken,
      clientBinding: BIND_A.clientBinding,
    });
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect((await f.store.find(sessionId))?.state).toBe('revoked');
  });

  it('rejects an idle refresh without revoking and extends idle but never absolute expiry', async () => {
    const f = fixture({ idleTtlMs: 1_000 });
    const { refreshToken, sessionId } = await loginRefresh(f);
    let current = refreshToken;
    let lastExpiry = 0;
    for (let step = 0; step < 40; step += 1) {
      f.advance(900);
      if (f.now() >= 1_000 + ABSOLUTE_TTL) break;
      const next = await f.service.refresh({
        refreshToken: current,
        clientBinding: BIND_A.clientBinding,
      });
      expect(next.refreshExpiresAt).toBeLessThanOrEqual(1_000 + ABSOLUTE_TTL);
      lastExpiry = next.refreshExpiresAt;
      current = next.refreshToken;
    }
    expect(lastExpiry).toBe(1_000 + ABSOLUTE_TTL);
    f.advance(ABSOLUTE_TTL);
    await expect(
      f.service.refresh({
        refreshToken: current,
        clientBinding: BIND_A.clientBinding,
      }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect(f.store.activeRefreshCount(sessionId)).toBe(1);
  });

  it('an idle refresh expires without any state change', async () => {
    const f = fixture({ idleTtlMs: 1_000 });
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(1_000);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect((await f.store.find(sessionId))?.state).toBe('active');
  });

  it('storage failure during rotation fails closed with authentication_unavailable', async () => {
    const f = fixture();
    const { refreshToken } = await loginRefresh(f);
    jest
      .spyOn(f.store, 'rotate')
      .mockRejectedValueOnce(
        new Error('connection to 10.0.0.9 refused secret'),
      );
    const error = await f.service
      .refresh({ refreshToken, clientBinding: BIND_A.clientBinding })
      .catch((e: unknown) => e);
    expect(error).toEqual(
      new AuthenticationError('authentication_unavailable'),
    );
    expect(JSON.stringify(error)).not.toContain('10.0.0.9');
    expect(f.tokens.issue).toHaveBeenCalledTimes(1);
  });

  it('storage failure while issuing the initial refresh never returns a token', async () => {
    const f = fixture();
    jest.spyOn(f.store, 'issue').mockRejectedValueOnce(new Error('down'));
    await expect(
      f.service.loginWithPassword(credentials, BIND_A),
    ).rejects.toEqual(new AuthenticationError('authentication_unavailable'));
  });

  it('revokeSession revokes the session and every refresh token of its family', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.advance(10);
    await f.service.revokeSession(sessionId, {
      subjectId: 'admin-1',
      correlationId: 'corr-revoke',
    });
    expect((await f.store.find(sessionId))?.state).toBe('revoked');
    expect(f.store.activeRefreshCount(sessionId)).toBe(0);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    const revoked = f.writes.find((w) => w.action === 'session.revoked');
    expect(revoked?.context).toEqual({
      subjectId: 'admin-1',
      correlationId: 'corr-revoke',
    });
  });

  it('audit writer failure fails closed without a token', async () => {
    const f = fixture();
    const { refreshToken } = await loginRefresh(f);
    f.writer.append.mockRejectedValueOnce(new Error('audit down'));
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('authentication_unavailable'));
  });

  it('a blocked principal during rotation revokes the session and returns invalid_credentials', async () => {
    const f = fixture();
    const { refreshToken, sessionId } = await loginRefresh(f);
    f.identities.bySubject.mockResolvedValueOnce(null);
    await expect(
      f.service.refresh({ refreshToken, clientBinding: BIND_A.clientBinding }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect((await f.store.find(sessionId))?.state).toBe('revoked');
  });

  it('rejects an invalid refresh policy at composition', () => {
    const f = fixture();
    expect(
      () =>
        new AuthenticationService({
          ...f.ports,
          refresh: { ...f.ports.refresh!, graceWindowMs: 30_001 },
        }),
    ).toThrow('Invalid refresh policy');
  });
});
