import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { AUTHENTICATION_SERVICE } from '../src/core/application/security/authentication.tokens';
import type { AuthenticationService } from '../src/core/application/security/authentication.service';
import { FoundationCoreModule } from '../src/core/infrastructure/modules/foundation-core.module';
import {
  SESSIONS_PERSISTENCE,
  buildPersistenceCatalog,
  createMigrationDataSource,
} from '../src/native/persistence-typeorm';
import {
  NODE_REFRESH_TOKEN_SECRETS,
  TypeOrmAuthenticationSessions,
  TypeOrmRefreshTokenStore,
  TypeOrmSessionReader,
} from '../src/native/persistence-typeorm/sessions';
import {
  accessTokensForTest,
  identitiesForTest,
  passwordVerifierForTest,
} from './fixtures/sessions-ports';

/**
 * Composição via Nest de login, renovação e revogação sobre PostgreSQL real.
 * Relógio controlado: a janela de graça é de 1 s; avançar 5 s torna o reuso fora da janela.
 */

jest.setTimeout(300_000);

const ADMIN_PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_sessions_nest';
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GRACE_WINDOW_MS = 1_000;
const CLIENT = 'browser-binding-nest';
const CREDENTIALS = {
  username: 'sessions-user',
  password: 'sessions-test-only',
};

let current = Date.now();
const clock = { now: () => current };
const advance = (ms: number) => {
  current += ms;
};

let container: StartedPostgreSqlContainer;
let dataSource: DataSource;
let sessionId: string;

async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(DATABASE)
      .withUsername('foundation')
      .withPassword(ADMIN_PASSWORD)
      .start();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (PostgreSQL 16). Make sure the Docker daemon is running. Cause: ${cause}`,
    );
  }
}

beforeAll(async () => {
  container = await startPostgres();
  dataSource = createMigrationDataSource(
    buildPersistenceCatalog([SESSIONS_PERSISTENCE]),
    {
      host: container.getHost(),
      port: container.getPort(),
      database: DATABASE,
      username: 'foundation',
      password: ADMIN_PASSWORD,
      applicationName: 'sessions-nest',
      poolMax: 2,
      connectTimeoutMs: 2_000,
    },
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
  await container?.stop();
});

/** Adapters de persistência e de identidade de teste, expostos por token Nest. */
const SESSIONS = Symbol('test.sessions');
const SESSIONS_READER = Symbol('test.sessions.reader');
const REFRESH_STORE = Symbol('test.refresh.store');
const REFRESH_SECRETS = Symbol('test.refresh.secrets');
const CLOCK = Symbol('test.clock');
const IDENTITIES = Symbol('test.identities');
const PASSWORD = Symbol('test.password');
const TOKENS = Symbol('test.tokens');

@Module({})
class AdaptersModule {}

async function compose(): Promise<AuthenticationService> {
  const adapters = {
    module: AdaptersModule,
    global: false,
    providers: [
      {
        provide: SESSIONS,
        useValue: new TypeOrmAuthenticationSessions({
          dataSource,
          clock,
          absoluteTtlMs: ABSOLUTE_TTL_MS,
        }),
      },
      {
        provide: SESSIONS_READER,
        useValue: new TypeOrmSessionReader(dataSource),
      },
      {
        provide: REFRESH_STORE,
        useValue: new TypeOrmRefreshTokenStore(dataSource),
      },
      { provide: REFRESH_SECRETS, useValue: NODE_REFRESH_TOKEN_SECRETS },
      { provide: CLOCK, useValue: clock },
      { provide: IDENTITIES, useValue: identitiesForTest },
      { provide: PASSWORD, useValue: passwordVerifierForTest },
      { provide: TOKENS, useValue: accessTokensForTest },
    ],
    exports: [
      SESSIONS,
      SESSIONS_READER,
      REFRESH_STORE,
      REFRESH_SECRETS,
      CLOCK,
      IDENTITIES,
      PASSWORD,
      TOKENS,
    ],
  };
  @Global()
  @Module({
    imports: [
      FoundationCoreModule.withAuthentication({
        imports: [adapters],
        ports: {
          identities: IDENTITIES,
          sessions: SESSIONS,
          tokens: TOKENS,
          clock: CLOCK,
          password: PASSWORD,
          refresh: {
            store: REFRESH_STORE,
            secrets: REFRESH_SECRETS,
            graceWindowMs: GRACE_WINDOW_MS,
          },
        },
      }),
    ],
    exports: [FoundationCoreModule],
  })
  class SessionsCompositionModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [SessionsCompositionModule],
  }).compile();
  return moduleRef.get<AuthenticationService>(AUTHENTICATION_SERVICE);
}

describe('sessões e renovação compostas via Nest (PostgreSQL)', () => {
  let service: AuthenticationService;

  beforeAll(async () => {
    service = await compose();
  });

  it('login, renovação, conflito na janela e reuso fora da janela revogam a sessão', async () => {
    // 1. login emite o primeiro refresh.
    const login = await service.loginWithPassword(CREDENTIALS, {
      clientBinding: CLIENT,
    });
    sessionId = login.sessionId;
    const first = login.refreshToken ?? '';
    expect(first).not.toBe('');

    // 2. renovação válida gera um único sucessor.
    const rotated = await service.refresh({
      refreshToken: first,
      clientBinding: CLIENT,
    });
    const second = rotated.refreshToken;
    expect(second).not.toBe(first);

    // 3. mesmo refresh repetido dentro da janela: conflito, sem revogar a sessão.
    await expect(
      service.refresh({ refreshToken: first, clientBinding: CLIENT }),
    ).rejects.toMatchObject({ code: 'refresh_conflict' });

    // O sucessor continua válido depois do conflito.
    const third = await service.refresh({
      refreshToken: second,
      clientBinding: CLIENT,
    });
    expect(third.refreshToken).not.toBe(second);

    // 4. reuso fora da janela: revoga a sessão inteira.
    advance(GRACE_WINDOW_MS * 5);
    await expect(
      service.refresh({ refreshToken: first, clientBinding: CLIENT }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    // 5. o refresh vigente deixa de funcionar e a sessão está revogada no banco.
    await expect(
      service.refresh({
        refreshToken: third.refreshToken,
        clientBinding: CLIENT,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    const rows = await dataSource.query<Array<{ state: string }>>(
      'SELECT state FROM auth_sessions WHERE id = $1',
      [sessionId],
    );
    expect(rows).toEqual([{ state: 'revoked' }]);
  });
});
