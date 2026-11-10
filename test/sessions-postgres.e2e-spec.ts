import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';
import {
  AuthenticationService,
  AuthenticationError,
} from '../src/core/application/security/authentication.service';
import { OperationAuthorizer } from '../src/core/application/security/operation-authorizer';
import type { OperationAuthorizationDependencies } from '../src/core/application/security/operation-authorizer';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  type PersistenceCatalog,
} from '../src/native/persistence-typeorm';
import {
  NODE_REFRESH_TOKEN_SECRETS,
  TypeOrmAuthenticationSessions,
  TypeOrmRefreshTokenStore,
  TypeOrmSessionReader,
} from '../src/native/persistence-typeorm/sessions';
import { SESSIONS_TEST_CONTRIBUTIONS } from './fixtures/sessions-catalog';
import {
  accessTokensForTest,
  identitiesForTest,
  passwordVerifierForTest,
} from './fixtures/sessions-ports';

jest.setTimeout(300_000);

const ADMIN_PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_sessions';
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROUNDS = 20;
const CLIENT = 'browser-binding-test';
const CREDENTIALS = {
  username: 'sessions-user',
  password: 'sessions-test-only',
};
const clock = { now: () => Date.now() };

let container: StartedPostgreSqlContainer;
let catalog: PersistenceCatalog;
const sources: DataSource[] = [];

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

function connect(
  host: string,
  port: number,
  applicationName: string,
  poolMax: number,
): DataSource {
  const dataSource = createMigrationDataSource(catalog, {
    host,
    port,
    database: DATABASE,
    username: 'foundation',
    password: ADMIN_PASSWORD,
    applicationName,
    poolMax,
    connectTimeoutMs: 2_000,
  });
  sources.push(dataSource);
  return dataSource;
}

/** Réplica = DataSource próprio + serviços independentes sobre o mesmo banco. */
function replica(dataSource: DataSource) {
  const sessions = new TypeOrmAuthenticationSessions({
    dataSource,
    clock,
    absoluteTtlMs: ABSOLUTE_TTL_MS,
  });
  const reader = new TypeOrmSessionReader(dataSource);
  const store = new TypeOrmRefreshTokenStore(dataSource);
  const service = new AuthenticationService({
    password: passwordVerifierForTest,
    identities: identitiesForTest,
    sessions,
    tokens: accessTokensForTest,
    clock,
    refresh: {
      store,
      secrets: NODE_REFRESH_TOKEN_SECRETS,
      idleTtlMs: IDLE_TTL_MS,
    },
  });
  const authorizerPorts: OperationAuthorizationDependencies = {
    tokens: accessTokensForTest,
    sessions: reader,
    identities: identitiesForTest,
    clock,
  };
  return {
    service,
    reader,
    authorizer: new OperationAuthorizer(authorizerPorts, 5_000),
  };
}

async function initialize(dataSource: DataSource): Promise<DataSource> {
  await dataSource.initialize();
  return dataSource;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'succeeded';
  } catch (error) {
    return error instanceof AuthenticationError ? error.code : 'unexpected';
  }
}

beforeAll(async () => {
  container = await startPostgres();
  catalog = buildPersistenceCatalog(SESSIONS_TEST_CONTRIBUTIONS);
  const admin = await initialize(
    connect(container.getHost(), container.getPort(), 'sessions-admin', 1),
  );
  await admin.runMigrations();
  await admin.destroy();
});

afterAll(async () => {
  for (const dataSource of sources) {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
  await container?.stop();
});

describe('Sessões compartilhadas (PostgreSQL 16, duas réplicas)', () => {
  let replicaA: ReturnType<typeof replica>;
  let replicaB: ReturnType<typeof replica>;
  let sourceA: DataSource;
  let sourceB: DataSource;

  beforeAll(async () => {
    sourceA = await initialize(
      connect(
        container.getHost(),
        container.getPort(),
        'sessions-replica-a',
        4,
      ),
    );
    sourceB = await initialize(
      connect(
        container.getHost(),
        container.getPort(),
        'sessions-replica-b',
        4,
      ),
    );
    replicaA = replica(sourceA);
    replicaB = replica(sourceB);
  });

  it('creates the schema only through the catalog migration', async () => {
    const rows: Array<{ table_name: string }> = await sourceA.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('auth_sessions', 'auth_refresh_tokens')
       ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'auth_refresh_tokens',
      'auth_sessions',
    ]);
  });

  it('revocation in replica A is seen by replica B immediately (window 0)', async () => {
    const login = await replicaA.service.loginWithPassword(CREDENTIALS, {
      clientBinding: CLIENT,
    });
    const before = await replicaB.authorizer.authorize({
      bearerToken: login.accessToken,
      correlationId: 'corr-before',
      requiredPermissions: [],
    });
    expect(before.principal.subjectId).toBe('subject-sessions-test');

    await replicaA.service.revokeSession(login.sessionId);

    expect((await replicaB.reader.find(login.sessionId))?.state).toBe(
      'revoked',
    );
    await expect(
      replicaB.authorizer.authorize({
        bearerToken: login.accessToken,
        correlationId: 'corr-after',
        requiredPermissions: [],
      }),
    ).rejects.toEqual(new AuthenticationError('invalid_credentials'));
    expect(
      await code(
        replicaB.service.refresh({
          refreshToken: login.refreshToken ?? '',
          clientBinding: CLIENT,
        }),
      ),
    ).toBe('invalid_credentials');
  });

  it(`concurrent renewal with the same token creates exactly one successor in ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const login = await replicaA.service.loginWithPassword(CREDENTIALS, {
        clientBinding: CLIENT,
      });
      const presented = login.refreshToken ?? '';
      const results = await Promise.allSettled([
        replicaA.service.refresh({
          refreshToken: presented,
          clientBinding: CLIENT,
        }),
        replicaB.service.refresh({
          refreshToken: presented,
          clientBinding: CLIENT,
        }),
      ]);
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toMatchObject({ code: 'refresh_conflict' });

      const chain: Array<{ active: string; total: string; consumed: string }> =
        await sourceA.query(
          `SELECT
             COUNT(*) FILTER (WHERE state = 'active')::text AS active,
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE state = 'consumed')::text AS consumed
           FROM auth_refresh_tokens WHERE session_id = $1`,
          [login.sessionId],
        );
      expect(chain[0]).toEqual({ active: '1', total: '2', consumed: '1' });
      const session = await replicaB.reader.find(login.sessionId);
      expect(session?.state).toBe('active');
    }
  });

  it('reuse after a successful rotation across replicas revokes the family', async () => {
    const login = await replicaA.service.loginWithPassword(CREDENTIALS, {
      clientBinding: CLIENT,
    });
    const first = login.refreshToken ?? '';
    const rotated = await replicaB.service.refresh({
      refreshToken: first,
      clientBinding: CLIENT,
    });
    const successor = rotated.refreshToken;
    await replicaA.service.refresh({
      refreshToken: successor,
      clientBinding: CLIENT,
    });
    expect(
      await code(
        replicaB.service.refresh({
          refreshToken: first,
          clientBinding: CLIENT,
        }),
      ),
    ).toBe('invalid_credentials');
    expect((await replicaA.reader.find(login.sessionId))?.state).toBe(
      'revoked',
    );
  });
});

describe('Armazenamento indisponível (PostgreSQL 16 parado)', () => {
  let stopped: StartedPostgreSqlContainer;
  let service: AuthenticationService;
  let authorizer: OperationAuthorizer;
  let storedRefresh: string;
  let storedAccess: string;

  beforeAll(async () => {
    stopped = await startPostgres();
    const admin = await initialize(
      connect(stopped.getHost(), stopped.getPort(), 'sessions-down-admin', 1),
    );
    await admin.runMigrations();
    await admin.destroy();
    const source = await initialize(
      connect(stopped.getHost(), stopped.getPort(), 'sessions-down', 2),
    );
    const handle = replica(source);
    service = handle.service;
    authorizer = handle.authorizer;
    const login = await service.loginWithPassword(CREDENTIALS, {
      clientBinding: CLIENT,
    });
    storedRefresh = login.refreshToken ?? '';
    storedAccess = login.accessToken;
    await stopped.stop();
  });

  afterAll(async () => {
    await stopped?.stop().catch(() => undefined);
  });

  it('refresh fails closed with authentication_unavailable', async () => {
    expect(
      await code(
        service.refresh({ refreshToken: storedRefresh, clientBinding: CLIENT }),
      ),
    ).toBe('authentication_unavailable');
  });

  it('protected read fails closed and never accepts the session', async () => {
    await expect(
      authorizer.authorize({
        bearerToken: storedAccess,
        correlationId: 'corr-down',
        requiredPermissions: [],
      }),
    ).rejects.toEqual(new AuthenticationError('authentication_unavailable'));
  });

  it('login does not return a token while storage is down', async () => {
    const outcome = await code(
      service.loginWithPassword(CREDENTIALS, { clientBinding: CLIENT }),
    );
    expect(outcome).toBe('authentication_unavailable');
  });
});
