import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FoundationCoreModule } from './foundation-core.module';
import type { AuthenticationPortBindings } from './foundation-core.module';
import { AuthenticationService } from '../../application/security/authentication.service';
import { AUTHENTICATION_SERVICE } from '../../application/security/authentication.tokens';
import { OPERATION_AUTHORIZER } from '../../application/security/operation-authorizer';
import { OPERATION_CONTEXT_ACCESSOR } from '../../application/context/operation-context.accessor';

@Module({})
class TestAdaptersModule {}

const ports: AuthenticationPortBindings = {
  identities: 'IDENTITIES',
  sessions: 'SESSIONS',
  tokens: 'TOKENS',
  clock: 'CLOCK',
  password: 'PASSWORD',
  federation: ['FEDERATION'],
};
function fixture() {
  const principal = { subjectId: 'user', permissions: [] };
  const identities = {
    bySubject: jest.fn().mockResolvedValue(principal),
    byExternalIdentity: jest.fn().mockResolvedValue(principal),
  };
  const sessions = {
    createPending: jest
      .fn()
      .mockResolvedValue({ id: 'session', expiresAt: 3000 }),
    activate: jest.fn().mockResolvedValue(undefined),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = {
    issue: jest.fn().mockResolvedValue({ value: 'opaque', expiresAt: 2000 }),
  };
  const clock = { now: jest.fn().mockReturnValue(1000) };
  const password = {
    verify: jest.fn().mockResolvedValue({ subjectId: 'user' }),
  };
  const federation = {
    id: 'test-idp',
    begin: jest.fn().mockResolvedValue({
      authorizationUrl: 'https://idp.example',
      expiresAt: 2000,
    }),
    complete: jest.fn().mockResolvedValue({
      issuer: 'https://idp.example',
      subject: 'external',
    }),
  };
  const values: Record<string, unknown> = {
    IDENTITIES: identities,
    SESSIONS: sessions,
    TOKENS: tokens,
    CLOCK: clock,
    PASSWORD: password,
    FEDERATION: federation,
  };
  return { identities, sessions, tokens, clock, password, federation, values };
}
function compile(
  values: Record<string, unknown>,
  bindings = ports,
  asynchronous = false,
) {
  const providers = Object.entries(values).map(([provide, value]) =>
    asynchronous
      ? { provide, useFactory: () => Promise.resolve(value) }
      : { provide, useValue: value },
  );
  return Test.createTestingModule({
    imports: [
      FoundationCoreModule.withAuthentication({
        imports: [
          {
            module: TestAdaptersModule,
            providers,
            exports: Object.keys(values),
          },
        ],
        ports: bindings,
      }),
    ],
  }).compile();
}

describe('FoundationCoreModule', () => {
  it('does not enable authentication implicitly', async () => {
    const module = await Test.createTestingModule({
      imports: [FoundationCoreModule],
    }).compile();
    try {
      expect(() =>
        module.get<AuthenticationService>(AUTHENTICATION_SERVICE),
      ).toThrow();
    } finally {
      await module.close();
    }
  });
  it.each([false, true])(
    'resolves named ports through Nest (async factories: %s)',
    async (asynchronous) => {
      const f = fixture();
      const module = await compile(
        f.values,
        {
          clock: ports.clock,
          federation: ports.federation,
          tokens: ports.tokens,
          password: ports.password,
          sessions: ports.sessions,
          identities: ports.identities,
        },
        asynchronous,
      );
      try {
        const service = module.get<AuthenticationService>(
          AUTHENTICATION_SERVICE,
        );
        expect(service).toBeInstanceOf(AuthenticationService);
        expect(f.clock.now).not.toHaveBeenCalled();
        expect(f.password.verify).not.toHaveBeenCalled();
        expect(f.sessions.createPending).not.toHaveBeenCalled();
        expect(f.tokens.issue).not.toHaveBeenCalled();
        expect(f.federation.begin).not.toHaveBeenCalled();
        await expect(
          service.loginWithPassword({ username: 'user', password: 'secret' }),
        ).resolves.toMatchObject({ accessToken: 'opaque', subjectId: 'user' });
        await expect(
          service.completeFederatedLogin('test-idp', {
            code: 'code',
            state: 'state',
            clientBinding: 'trusted',
          }),
        ).resolves.toMatchObject({ accessToken: 'opaque' });
      } finally {
        await module.close();
      }
    },
  );
  it.each(['identities', 'sessions', 'tokens', 'clock'] as const)(
    'rejects a missing mandatory %s binding',
    (name) => {
      expect(() =>
        FoundationCoreModule.withAuthentication({
          ports: {
            ...ports,
            [name]: undefined,
          },
        }),
      ).toThrow(`Invalid authentication binding: ${name}`);
    },
  );
  it('fails when a configured token cannot be resolved', async () => {
    const f = fixture();
    delete f.values.TOKENS;
    await expect(compile(f.values)).rejects.toThrow();
    expect(f.password.verify).not.toHaveBeenCalled();
  });
  it.each([
    ['IDENTITIES', { bySubject: () => null }],
    ['SESSIONS', { createPending: () => null, activate: () => null }],
    ['TOKENS', { issue: 'not a function' }],
    ['CLOCK', null],
    ['PASSWORD', {}],
    ['FEDERATION', { id: 'id', begin: () => null }],
    ['FEDERATION', { id: '', begin: () => null, complete: () => null }],
  ])(
    'rejects an incompatible %s provider at initialization',
    async (name, invalid) => {
      const f = fixture();
      await expect(compile({ ...f.values, [name]: invalid })).rejects.toThrow(
        'Invalid authentication provider',
      );
      expect(f.password.verify).not.toHaveBeenCalled();
      expect(f.sessions.createPending).not.toHaveBeenCalled();
    },
  );
  it('keeps omitted password and federation flows disabled', async () => {
    const f = fixture();
    const module = await compile(f.values, {
      identities: ports.identities,
      sessions: ports.sessions,
      tokens: ports.tokens,
      clock: ports.clock,
    });
    try {
      const service = module.get<AuthenticationService>(AUTHENTICATION_SERVICE);
      await expect(
        service.loginWithPassword({ username: 'user', password: 'secret' }),
      ).rejects.toMatchObject({ code: 'invalid_credentials' });
      await expect(
        service.completeFederatedLogin('test-idp', {
          code: 'code',
          state: 'state',
          clientBinding: 'trusted',
        }),
      ).rejects.toMatchObject({ code: 'invalid_credentials' });
      expect(f.sessions.createPending).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
  it('supports federation without a password provider', async () => {
    const f = fixture();
    const module = await compile(f.values, { ...ports, password: undefined });
    try {
      await expect(
        module
          .get<AuthenticationService>(AUTHENTICATION_SERVICE)
          .completeFederatedLogin('test-idp', {
            code: 'code',
            state: 'state',
            clientBinding: 'trusted',
          }),
      ).resolves.toMatchObject({ subjectId: 'user' });
    } finally {
      await module.close();
    }
  });
  it('rejects duplicate federated provider identities', async () => {
    const f = fixture();
    await expect(
      compile(
        { ...f.values, SECOND: { ...f.federation } },
        { ...ports, federation: ['FEDERATION', 'SECOND'] },
      ),
    ).rejects.toThrow('duplicate federation provider');
  });
  it('rejects legacy positional registration', () => {
    expect(() =>
      FoundationCoreModule.withAuthentication({
        ports,
        useFactory: () => fixture(),
      } as unknown as Parameters<
        typeof FoundationCoreModule.withAuthentication
      >[0]),
    ).toThrow('no longer accepts');
  });
});

describe('FoundationCoreModule HTTP security registration', () => {
  const httpPorts = {
    tokens: 'HTTP_TOKENS',
    sessions: 'HTTP_SESSIONS',
    identities: 'HTTP_IDENTITIES',
    clock: 'HTTP_CLOCK',
  };
  const adapters = (values: Record<string, unknown>) => ({
    module: TestAdaptersModule,
    providers: Object.entries(values).map(([provide, value]) => ({
      provide,
      useValue: value,
    })),
    exports: Object.keys(values),
  });
  const validValues = () => ({
    HTTP_TOKENS: { verify: jest.fn() },
    HTTP_SESSIONS: { find: jest.fn() },
    HTTP_IDENTITIES: { bySubject: jest.fn(), byExternalIdentity: jest.fn() },
    HTTP_CLOCK: { now: jest.fn().mockReturnValue(1000) },
  });

  it('exige registro com portas nomeadas', () => {
    expect(() =>
      FoundationCoreModule.withHttpSecurity(undefined as never),
    ).toThrow('requires named ports');
  });

  it.each(['tokens', 'sessions', 'identities', 'clock'] as const)(
    'rejeita binding obrigatório ausente: %s',
    (missing) => {
      const ports = { ...httpPorts, [missing]: undefined };
      expect(() => FoundationCoreModule.withHttpSecurity({ ports })).toThrow(
        `Invalid authentication binding: ${missing}`,
      );
    },
  );

  it('rejeita timeout de operação inválido', () => {
    expect(() =>
      FoundationCoreModule.withHttpSecurity({
        ports: httpPorts,
        operationTimeoutMs: 0,
      }),
    ).toThrow('Invalid operation timeout');
  });

  it('não habilita proteção HTTP sem o registro', async () => {
    const module = await Test.createTestingModule({
      imports: [FoundationCoreModule],
    }).compile();
    try {
      expect(() => module.get<unknown>(OPERATION_AUTHORIZER)).toThrow();
      expect(() => module.get<unknown>(OPERATION_CONTEXT_ACCESSOR)).toThrow();
    } finally {
      await module.close();
    }
  });

  it('falha na inicialização quando o provider de identidade não tem a operação esperada', async () => {
    const values = validValues();
    const broken = {
      ...values,
      HTTP_IDENTITIES: { byExternalIdentity: jest.fn() },
    };
    await expect(
      Test.createTestingModule({
        imports: [
          FoundationCoreModule.withHttpSecurity({
            imports: [adapters(broken)],
            ports: httpPorts,
          }),
        ],
      }).compile(),
    ).rejects.toThrow('Invalid authentication provider: identities');
  });

  it('falha na inicialização quando um token não é resolvido', async () => {
    const values = validValues();
    const withoutClock: Record<string, unknown> = { ...values };
    delete withoutClock.HTTP_CLOCK;
    await expect(
      Test.createTestingModule({
        imports: [
          FoundationCoreModule.withHttpSecurity({
            imports: [adapters(withoutClock)],
            ports: httpPorts,
          }),
        ],
      }).compile(),
    ).rejects.toThrow();
  });

  it('registra autorizador e contexto quando as portas são válidas', async () => {
    const module = await Test.createTestingModule({
      imports: [
        FoundationCoreModule.withHttpSecurity({
          imports: [adapters(validValues())],
          ports: httpPorts,
        }),
      ],
    }).compile();
    try {
      expect(module.get(OPERATION_AUTHORIZER)).toBeDefined();
      expect(module.get(OPERATION_CONTEXT_ACCESSOR)).toBeDefined();
    } finally {
      await module.close();
    }
  });
});

describe('FoundationCoreModule optional refresh and audit', () => {
  function refreshValues(overrides: Record<string, unknown> = {}) {
    const store = {
      issue: jest.fn().mockResolvedValue(undefined),
      rotate: jest.fn(),
      revokeFamily: jest.fn().mockResolvedValue(undefined),
    };
    const secrets = {
      generate: jest.fn().mockReturnValue('opaque-refresh'),
      digest: jest.fn((value: string) => `digest:${value}`),
    };
    const writer = { append: jest.fn().mockResolvedValue(undefined) };
    const newEntryId = jest.fn().mockReturnValue('entry-1');
    return {
      store,
      secrets,
      writer,
      newEntryId,
      values: {
        REFRESH_STORE: store,
        REFRESH_SECRETS: secrets,
        AUDIT_WRITER: writer,
        AUDIT_ID: newEntryId,
        ...overrides,
      },
    };
  }
  const refreshPorts = {
    ...ports,
    refresh: { store: 'REFRESH_STORE', secrets: 'REFRESH_SECRETS' },
  };

  it('composes refresh and audit when bound, and issues a refresh grant on login', async () => {
    const f = fixture();
    const r = refreshValues();
    const module = await compile(
      { ...f.values, ...r.values },
      {
        ...refreshPorts,
        audit: { writer: 'AUDIT_WRITER', newEntryId: 'AUDIT_ID' },
      },
    );
    try {
      const service = module.get<AuthenticationService>(AUTHENTICATION_SERVICE);
      const result = await service.loginWithPassword(
        { username: 'user', password: 'secret' },
        { clientBinding: 'browser' },
      );
      expect(result).toMatchObject({ refreshToken: 'opaque-refresh' });
      expect(r.store.issue).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });

  it('keeps login working without refresh or audit bindings', async () => {
    const f = fixture();
    const module = await compile(f.values, ports);
    try {
      const service = module.get<AuthenticationService>(AUTHENTICATION_SERVICE);
      const result = await service.loginWithPassword(
        { username: 'user', password: 'secret' },
        { clientBinding: 'browser' },
      );
      expect(result).not.toHaveProperty('refreshToken');
    } finally {
      await module.close();
    }
  });

  it('rejects a refresh binding without secrets before initialization', () => {
    expect(() =>
      FoundationCoreModule.withAuthentication({
        ports: {
          ...ports,
          refresh: {
            store: 'REFRESH_STORE',
            secrets: undefined as unknown as string,
          },
        },
      }),
    ).toThrow('Invalid authentication binding: refresh.secrets');
  });

  it.each([-1, 30_001, 1.5])(
    'rejects a grace window of %s outside 0 to 30 s',
    (graceWindowMs) => {
      expect(() =>
        FoundationCoreModule.withAuthentication({
          ports: {
            ...refreshPorts,
            refresh: { ...refreshPorts.refresh, graceWindowMs },
          },
        }),
      ).toThrow('Invalid refresh policy: graceWindowMs');
    },
  );

  it.each([0, 30_000])(
    'accepts the grace window boundary %s',
    (graceWindowMs) => {
      expect(() =>
        FoundationCoreModule.withAuthentication({
          ports: {
            ...refreshPorts,
            refresh: { ...refreshPorts.refresh, graceWindowMs },
          },
        }),
      ).not.toThrow();
    },
  );

  it('rejects a non-positive idle TTL', () => {
    expect(() =>
      FoundationCoreModule.withAuthentication({
        ports: {
          ...refreshPorts,
          refresh: { ...refreshPorts.refresh, idleTtlMs: 0 },
        },
      }),
    ).toThrow('Invalid refresh policy: idleTtlMs');
  });

  it.each([
    ['REFRESH_STORE', { issue: () => null, rotate: () => null }],
    ['REFRESH_SECRETS', { generate: () => 'x' }],
  ])(
    'rejects a refresh provider with the wrong shape: %s',
    async (name, bad) => {
      const f = fixture();
      const r = refreshValues({ [name]: bad });
      await expect(
        compile({ ...f.values, ...r.values }, refreshPorts),
      ).rejects.toThrow(
        `Invalid authentication provider: ${name === 'REFRESH_STORE' ? 'refresh.store' : 'refresh.secrets'}`,
      );
    },
  );

  it('rejects an audit writer without append at initialization', async () => {
    const f = fixture();
    const r = refreshValues({ AUDIT_WRITER: {} });
    await expect(
      compile(
        { ...f.values, ...r.values },
        {
          ...refreshPorts,
          audit: { writer: 'AUDIT_WRITER', newEntryId: 'AUDIT_ID' },
        },
      ),
    ).rejects.toThrow('Invalid authentication provider: audit.writer');
  });

  it('rejects a non-function newEntryId at initialization', async () => {
    const f = fixture();
    const r = refreshValues({ AUDIT_ID: 'not-a-function' });
    await expect(
      compile(
        { ...f.values, ...r.values },
        {
          ...refreshPorts,
          audit: { writer: 'AUDIT_WRITER', newEntryId: 'AUDIT_ID' },
        },
      ),
    ).rejects.toThrow('Invalid authentication provider: audit.newEntryId');
  });
});
