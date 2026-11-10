/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import type { SessionReader } from '../sessions/session-reader.port';
import type {
  AccessTokenVerifier,
  Clock,
  IdentityAccessResolver,
} from './authentication.ports';
import { AuthenticationError } from './authentication.service';
import {
  AuthorizationError,
  OperationAuthorizer,
} from './operation-authorizer';

const NOW = 1_000_000;
const TIMEOUT = 5_000;

type Verified = {
  subjectId: string;
  sessionId: string;
  expiresAt: number;
} | null;

function fixture(
  overrides: {
    verify?: () => Promise<Verified>;
    find?: () => Promise<unknown>;
    bySubject?: () => Promise<unknown>;
    now?: () => number;
  } = {},
) {
  const tokens = {
    verify: jest.fn(
      overrides.verify ??
        (async () => ({
          subjectId: 'user-a',
          sessionId: 'session-a',
          expiresAt: NOW + 100,
        })),
    ),
  } satisfies AccessTokenVerifier & { verify: jest.Mock };
  const sessions = {
    find: jest.fn(
      overrides.find ??
        (async () => ({
          id: 'session-a',
          subjectId: 'user-a',
          state: 'active',
          expiresAt: NOW + 100,
        })),
    ),
  };
  const identities = {
    bySubject: jest.fn(
      overrides.bySubject ??
        (async () => ({
          subjectId: 'user-a',
          tenantId: 'tenant-a',
          permissions: ['things:read'],
        })),
    ),
    byExternalIdentity: jest.fn(),
  };
  const clock = { now: jest.fn(overrides.now ?? (() => NOW)) } satisfies Clock;
  const authorizer = new OperationAuthorizer(
    {
      tokens,
      sessions: sessions as unknown as SessionReader,
      identities: identities as unknown as IdentityAccessResolver,
      clock,
    },
    TIMEOUT,
  );
  return { authorizer, tokens, sessions, identities };
}

function request(
  overrides: { bearerToken?: string; required?: string[] } = {},
) {
  return {
    bearerToken: overrides.bearerToken ?? 'opaque',
    correlationId: 'corr-1',
    requiredPermissions: overrides.required ?? ['things:read'],
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthenticationError) return error.code;
    if (error instanceof AuthorizationError) return error.code;
    throw error;
  }
  throw new Error('expected denial');
}

describe('OperationAuthorizer', () => {
  it('autoriza caso feliz e popula o contexto com deadline e correlação', async () => {
    const { authorizer } = fixture();
    const context = await authorizer.authorize(request());
    expect(context).toEqual({
      correlationId: 'corr-1',
      principal: {
        subjectId: 'user-a',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      deadlineAt: NOW + TIMEOUT,
    });
  });

  it('copia o principal sem manter referências do adapter', async () => {
    const permissions = ['things:read'];
    const { authorizer } = fixture({
      bySubject: async () => ({ subjectId: 'user-a', permissions }),
    });
    const context = await authorizer.authorize(request());
    expect(context.principal).not.toHaveProperty('tenantId');
    expect(context.principal.permissions).not.toBe(permissions);
  });

  it('exige token bearer presente', async () => {
    const { authorizer, tokens } = fixture();
    const missing = { ...request(), bearerToken: undefined };
    expect(await codeOf(authorizer.authorize(missing))).toBe(
      'invalid_credentials',
    );
    expect(
      await codeOf(authorizer.authorize(request({ bearerToken: '' }))),
    ).toBe('invalid_credentials');
    expect(tokens.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['token inválido (verifier devolve null)', { verify: async () => null }],
    [
      'token expirado',
      {
        verify: async () => ({
          subjectId: 'user-a',
          sessionId: 's',
          expiresAt: NOW,
        }),
      },
    ],
    ['sessão ausente', { find: async () => null }],
    [
      'sessão revogada',
      {
        find: async () => ({
          id: 'session-a',
          subjectId: 'user-a',
          state: 'revoked',
          expiresAt: NOW + 100,
        }),
      },
    ],
    [
      'sessão pendente',
      {
        find: async () => ({
          id: 'session-a',
          subjectId: 'user-a',
          state: 'pending',
          expiresAt: NOW + 100,
        }),
      },
    ],
    [
      'sessão expirada por estado',
      {
        find: async () => ({
          id: 'session-a',
          subjectId: 'user-a',
          state: 'expired',
          expiresAt: NOW + 100,
        }),
      },
    ],
    [
      'sessão com prazo vencido',
      {
        find: async () => ({
          id: 'session-a',
          subjectId: 'user-a',
          state: 'active',
          expiresAt: NOW,
        }),
      },
    ],
    [
      'subject divergente entre token e sessão',
      {
        find: async () => ({
          id: 'session-a',
          subjectId: 'user-b',
          state: 'active',
          expiresAt: NOW + 100,
        }),
      },
    ],
    [
      'identidade bloqueada (resolver devolve null)',
      { bySubject: async () => null },
    ],
  ])('nega: %s', async (_name, overrides) => {
    const { authorizer } = fixture(overrides);
    expect(await codeOf(authorizer.authorize(request()))).toBe(
      'invalid_credentials',
    );
  });

  it('nega com permission_denied quando falta permissão declarada', async () => {
    const { authorizer } = fixture();
    await expect(
      authorizer.authorize(request({ required: ['things:write'] })),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it.each([
    [
      'verifier lança erro',
      {
        verify: async () => {
          throw new Error('db down');
        },
      },
    ],
    [
      'sessão lança erro',
      {
        find: async () => {
          throw new Error('redis down');
        },
      },
    ],
    [
      'resolver lança erro',
      {
        bySubject: async () => {
          throw new Error('ldap down');
        },
      },
    ],
    [
      'clock lança erro',
      {
        now: () => {
          throw new Error('clock');
        },
      },
    ],
    [
      'resposta de sessão malformada',
      {
        find: async () => ({
          id: 'session-a',
          subjectId: 'user-a',
          state: 'weird',
          expiresAt: NOW + 100,
        }),
      },
    ],
    [
      'principal de outro subject',
      { bySubject: async () => ({ subjectId: 'user-b', permissions: [] }) },
    ],
    [
      'permissões malformadas',
      {
        bySubject: async () => ({
          subjectId: 'user-a',
          permissions: 'things:read',
        }),
      },
    ],
  ])(
    'falha fechada com authentication_unavailable: %s',
    async (_name, overrides) => {
      const { authorizer } = fixture(overrides);
      expect(await codeOf(authorizer.authorize(request()))).toBe(
        'authentication_unavailable',
      );
    },
  );

  it('rejeita timeout inválido na construção', () => {
    const ports = fixture();
    expect(
      () =>
        new OperationAuthorizer(
          {
            tokens: ports.tokens,
            sessions: ports.sessions as unknown as SessionReader,
            identities: ports.identities as unknown as IdentityAccessResolver,
            clock: { now: () => NOW },
          },
          0,
        ),
    ).toThrow('Invalid operation timeout');
  });
});
