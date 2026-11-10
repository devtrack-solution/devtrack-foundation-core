/* eslint-disable @typescript-eslint/unbound-method -- Jest inspects mock methods without invoking unbound methods. */
import {
  AuthenticationError,
  AuthenticationService,
} from './authentication.service';
import type { AuthenticationDependencies } from './authentication.service';
import type {
  AccessTokenIssuer,
  AuthenticationSessions,
  FederatedIdentityProvider,
  IdentityAccessResolver,
  PasswordCredentialsVerifier,
} from './authentication.ports';

const principal = { subjectId: 'internal-1', permissions: ['read'] };
const credentials = { username: 'user', password: 'private-password' };
const callback = {
  code: 'private-code',
  state: 'state',
  clientBinding: 'browser-session',
};
function fixture() {
  const password: jest.Mocked<PasswordCredentialsVerifier> = {
    verify: jest.fn().mockResolvedValue({ subjectId: principal.subjectId }),
  };
  const identities: jest.Mocked<IdentityAccessResolver> = {
    bySubject: jest.fn().mockResolvedValue(principal),
    byExternalIdentity: jest.fn().mockResolvedValue(principal),
  };
  const sessions: jest.Mocked<AuthenticationSessions> = {
    createPending: jest
      .fn()
      .mockResolvedValue({ id: 'session-1', expiresAt: 3000 }),
    activate: jest.fn().mockResolvedValue(undefined),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const tokens: jest.Mocked<AccessTokenIssuer> = {
    issue: jest
      .fn()
      .mockResolvedValue({ value: 'opaque-no-jwt', expiresAt: 2000 }),
  };
  const provider: jest.Mocked<FederatedIdentityProvider> = {
    id: 'provider-test',
    begin: jest.fn().mockResolvedValue({
      authorizationUrl: 'https://identity.example/authorize',
      expiresAt: 2000,
    }),
    complete: jest.fn().mockResolvedValue({
      issuer: 'https://identity.example',
      subject: 'external-123',
      email: 'ignored@example.test',
      accessToken: 'provider-secret',
    }),
  };
  const ports: AuthenticationDependencies = {
    password,
    identities,
    sessions,
    tokens,
    federation: [provider],
    clock: { now: () => 1000 },
  };
  return {
    password,
    identities,
    sessions,
    tokens,
    provider,
    ports,
    service: new AuthenticationService(ports),
  };
}

describe('AuthenticationService', () => {
  it('returns a format-neutral token only after session activation', async () => {
    const f = fixture();
    const result = await f.service.loginWithPassword(credentials);
    expect(result).toEqual({
      accessToken: 'opaque-no-jwt',
      tokenType: 'Bearer',
      expiresAt: 2000,
      sessionId: 'session-1',
      subjectId: 'internal-1',
    });
    expect(f.password.verify).toHaveBeenCalledWith(credentials);
    expect(f.tokens.issue).toHaveBeenCalledWith({
      principal,
      session: { id: 'session-1', expiresAt: 3000 },
      method: { kind: 'password' },
    });
    expect(f.sessions.createPending.mock.invocationCallOrder[0]).toBeLessThan(
      f.tokens.issue.mock.invocationCallOrder[0],
    );
    expect(f.tokens.issue.mock.invocationCallOrder[0]).toBeLessThan(
      f.sessions.activate.mock.invocationCallOrder[0],
    );
  });
  it.each(['invalid-password', 'denied-identity', 'disabled-password'])(
    'denies %s without issuing a token',
    async (reason) => {
      const f = fixture();
      if (reason === 'invalid-password')
        f.password.verify.mockResolvedValue(null);
      if (reason === 'denied-identity')
        f.identities.bySubject.mockResolvedValue(null);
      const service =
        reason === 'disabled-password'
          ? new AuthenticationService({ ...f.ports, password: undefined })
          : f.service;
      await expect(service.loginWithPassword(credentials)).rejects.toEqual(
        new AuthenticationError('invalid_credentials'),
      );
      expect(f.sessions.createPending).not.toHaveBeenCalled();
      expect(f.tokens.issue).not.toHaveBeenCalled();
    },
  );
  it('fails closed if identity resolver switches subject', async () => {
    const f = fixture();
    f.identities.bySubject.mockResolvedValue({
      ...principal,
      subjectId: 'other',
    });
    await expect(
      f.service.loginWithPassword(credentials),
    ).rejects.toMatchObject({ code: 'authentication_unavailable' });
    expect(f.sessions.createPending).not.toHaveBeenCalled();
  });
  it.each(['issuance', 'activation', 'compensation'])(
    'compensates and never returns a token after %s failure',
    async (failure) => {
      const f = fixture();
      if (failure === 'activation')
        f.sessions.activate.mockRejectedValue(
          new Error('private-session-secret'),
        );
      else f.tokens.issue.mockRejectedValue(new Error('private-key-secret'));
      if (failure === 'compensation')
        f.sessions.revoke.mockRejectedValue(
          new Error('private-storage-secret'),
        );
      await expect(f.service.loginWithPassword(credentials)).rejects.toEqual(
        new AuthenticationError('authentication_unavailable'),
      );
      expect(f.sessions.revoke).toHaveBeenCalledWith('session-1');
    },
  );
  it.each([999, 1000, 3001, Infinity, NaN, 2000.5])(
    'rejects invalid token expiration %s',
    async (expiresAt) => {
      const f = fixture();
      f.tokens.issue.mockResolvedValue({ value: 'token', expiresAt });
      await expect(
        f.service.loginWithPassword(credentials),
      ).rejects.toMatchObject({ code: 'authentication_unavailable' });
      expect(f.sessions.activate).not.toHaveBeenCalled();
      expect(f.sessions.revoke).toHaveBeenCalled();
    },
  );
  it.each(['password', 'federated'] as const)(
    'rejects an empty session ID during %s login without compensation',
    async (method) => {
      const f = fixture();
      f.sessions.createPending.mockResolvedValue({ id: '', expiresAt: 3000 });
      const login =
        method === 'password'
          ? f.service.loginWithPassword(credentials)
          : f.service.completeFederatedLogin(f.provider.id, callback);
      await expect(login).rejects.toEqual(
        new AuthenticationError('authentication_unavailable'),
      );
      expect(f.sessions.createPending).toHaveBeenCalledTimes(1);
      expect(f.tokens.issue).not.toHaveBeenCalled();
      expect(f.sessions.activate).not.toHaveBeenCalled();
      expect(f.sessions.revoke).not.toHaveBeenCalled();
    },
  );
  it('rejects expired pending session before issuance', async () => {
    const f = fixture();
    f.sessions.createPending.mockResolvedValue({
      id: 'session-1',
      expiresAt: 1000,
    });
    await expect(
      f.service.loginWithPassword(credentials),
    ).rejects.toMatchObject({ code: 'authentication_unavailable' });
    expect(f.tokens.issue).not.toHaveBeenCalled();
    expect(f.sessions.revoke).toHaveBeenCalledWith('session-1');
  });
  it('revokes if the token expires while activation is in progress', async () => {
    const f = fixture();
    let now = 1000;
    f.sessions.activate.mockImplementation(() => {
      now = 2000;
      return Promise.resolve();
    });
    const service = new AuthenticationService({
      ...f.ports,
      clock: { now: () => now },
    });
    await expect(service.loginWithPassword(credentials)).rejects.toMatchObject({
      code: 'authentication_unavailable',
    });
    expect(f.sessions.revoke).toHaveBeenCalledWith('session-1');
  });
  it('redacts backend exceptions before session creation', async () => {
    const f = fixture();
    f.password.verify.mockRejectedValue(new Error(credentials.password));
    await expect(f.service.loginWithPassword(credentials)).rejects.toEqual(
      new AuthenticationError('authentication_unavailable'),
    );
    expect(f.sessions.createPending).not.toHaveBeenCalled();
  });
  it('resolves external identity by exact tuple, then uses the same session/token path', async () => {
    const f = fixture();
    const result = await f.service.completeFederatedLogin(
      f.provider.id,
      callback,
    );
    expect(f.provider.complete).toHaveBeenCalledWith(callback);
    expect(f.identities.byExternalIdentity).toHaveBeenCalledWith({
      providerId: f.provider.id,
      issuer: 'https://identity.example',
      subject: 'external-123',
    });
    expect(result.accessToken).toBe('opaque-no-jwt');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(JSON.stringify(result)).not.toContain('email');
    expect(f.password.verify).not.toHaveBeenCalled();
  });
  it('starts federation with a configured redirect and trusted client binding', async () => {
    const f = fixture();
    const input = { redirectId: 'web', clientBinding: 'browser-session' };
    await expect(
      f.service.beginFederatedLogin(f.provider.id, input),
    ).resolves.toEqual({
      authorizationUrl: 'https://identity.example/authorize',
      expiresAt: 2000,
    });
    expect(f.provider.begin).toHaveBeenCalledWith(input);
    expect(f.sessions.createPending).not.toHaveBeenCalled();
  });
  it.each([
    'unknown-provider',
    'rejected-callback',
    'unlinked-identity',
    'empty-binding',
  ])('denies federated %s without creating a session', async (reason) => {
    const f = fixture();
    if (reason === 'rejected-callback')
      f.provider.complete.mockResolvedValue(null);
    if (reason === 'unlinked-identity')
      f.identities.byExternalIdentity.mockResolvedValue(null);
    await expect(
      f.service.completeFederatedLogin(
        reason === 'unknown-provider' ? 'missing' : f.provider.id,
        reason === 'empty-binding'
          ? { ...callback, clientBinding: '' }
          : callback,
      ),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect(f.sessions.createPending).not.toHaveBeenCalled();
  });
  it('rejects duplicate providers at composition', () => {
    const f = fixture();
    expect(
      () =>
        new AuthenticationService({
          ...f.ports,
          federation: [f.provider, f.provider],
        }),
    ).toThrow('duplicate');
  });
});
