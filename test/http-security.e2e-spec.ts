/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Post,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AuthenticationGuard,
  FoundationCoreModule,
  RequestBodyLimitPipe,
  RequirePermissions,
} from '../src/core/infrastructure/modules/foundation-core.module';
import {
  OPERATION_CONTEXT_ACCESSOR,
  type OperationContextAccessor,
} from '../src/core/application/context/operation-context.accessor';

const NOW = 1_000_000;

interface TokenEntry {
  subjectId: string;
  sessionId: string;
  expiresAt: number;
}
interface SessionEntry {
  id: string;
  subjectId: string;
  state: string;
  expiresAt: number;
}
interface IdentityEntry {
  subjectId: string;
  tenantId?: string;
  permissions: string[];
}

/** Estado em memória das portas falsas, redefinido antes de cada teste. */
const store = {
  tokens: new Map<string, TokenEntry | 'throw'>(),
  sessions: new Map<string, SessionEntry | 'throw'>(),
  identities: new Map<string, IdentityEntry | null | 'throw'>(),
};

function seed(): void {
  store.tokens.clear();
  store.sessions.clear();
  store.identities.clear();
  const actors: [string, string, IdentityEntry, Partial<SessionEntry>][] = [
    [
      'tok-a',
      'user-a',
      {
        subjectId: 'user-a',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      {},
    ],
    [
      'tok-b',
      'user-b',
      {
        subjectId: 'user-b',
        tenantId: 'tenant-b',
        permissions: ['things:read'],
      },
      {},
    ],
    [
      'tok-noperm',
      'user-c',
      { subjectId: 'user-c', tenantId: 'tenant-a', permissions: [] },
      {},
    ],
    [
      'tok-pending',
      'user-d',
      {
        subjectId: 'user-d',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      { state: 'pending' },
    ],
    [
      'tok-revoked',
      'user-e',
      {
        subjectId: 'user-e',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      { state: 'revoked' },
    ],
    [
      'tok-expired-session',
      'user-f',
      {
        subjectId: 'user-f',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      { expiresAt: NOW },
    ],
    [
      'tok-subject-mismatch',
      'user-g',
      {
        subjectId: 'user-g',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      { subjectId: 'user-x' },
    ],
    [
      'tok-blocked',
      'user-h',
      {
        subjectId: 'user-h',
        tenantId: 'tenant-a',
        permissions: ['things:read'],
      },
      {},
    ],
  ];
  for (const [token, subjectId, identity, sessionOverride] of actors) {
    const sessionId = `sess-${subjectId}`;
    store.tokens.set(token, { subjectId, sessionId, expiresAt: NOW + 1000 });
    store.sessions.set(sessionId, {
      id: sessionId,
      subjectId,
      state: 'active',
      expiresAt: NOW + 1000,
      ...sessionOverride,
    });
    store.identities.set(subjectId, identity);
  }
  store.identities.set('user-h', null);
  store.tokens.set('tok-expired-token', {
    subjectId: 'user-a',
    sessionId: 'sess-user-a',
    expiresAt: NOW,
  });
  store.tokens.set('tok-verifier-throws', 'throw');
  store.tokens.set('tok-session-throws', {
    subjectId: 'user-s',
    sessionId: 'sess-throw',
    expiresAt: NOW + 1000,
  });
  store.sessions.set('sess-throw', 'throw');
  store.tokens.set('tok-identity-throws', {
    subjectId: 'user-i',
    sessionId: 'sess-user-i',
    expiresAt: NOW + 1000,
  });
  store.sessions.set('sess-user-i', {
    id: 'sess-user-i',
    subjectId: 'user-i',
    state: 'active',
    expiresAt: NOW + 1000,
  });
  store.identities.set('user-i', 'throw');
}

@Module({
  providers: [
    {
      provide: 'E2E_TOKENS',
      useValue: {
        verify: async (value: string) => {
          const entry = store.tokens.get(value) ?? null;
          if (entry === 'throw')
            throw new Error('verifier down: postgres://secret');
          return entry;
        },
      },
    },
    {
      provide: 'E2E_SESSIONS',
      useValue: {
        find: async (id: string) => {
          const entry = store.sessions.get(id) ?? null;
          if (entry === 'throw') throw new Error('session store down');
          return entry;
        },
      },
    },
    {
      provide: 'E2E_IDENTITIES',
      useValue: {
        bySubject: async (subjectId: string) => {
          const entry = store.identities.get(subjectId) ?? null;
          if (entry === 'throw') throw new Error('identity down');
          return entry;
        },
        byExternalIdentity: async () => null,
      },
    },
    { provide: 'E2E_CLOCK', useValue: { now: () => NOW } },
  ],
  exports: ['E2E_TOKENS', 'E2E_SESSIONS', 'E2E_IDENTITIES', 'E2E_CLOCK'],
})
class FakeAdaptersModule {}

interface Probe {
  subjectId?: string;
  tenantId?: string | null;
  correlationId?: string;
}

const jitter = () =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * 4)),
  );

@Controller()
class ProbeController {
  constructor(
    @Inject(OPERATION_CONTEXT_ACCESSOR)
    private readonly contexts: OperationContextAccessor,
  ) {}

  /** Sem guard: nenhum contexto deve existir aqui. */
  @Get('open')
  open(): { correlationId: string } {
    return { correlationId: this.contexts.current().correlationId };
  }

  @Get('boom')
  boom(): never {
    throw new Error('segredo-do-banco');
  }

  @Get('protected/whoami')
  @UseGuards(AuthenticationGuard)
  @RequirePermissions('things:read')
  async whoami() {
    await jitter();
    await jitter();
    const context = this.contexts.current();
    return {
      subjectId: context.principal.subjectId,
      tenantId: context.principal.tenantId ?? null,
      correlationId: context.correlationId,
    };
  }

  @Get('protected/admin')
  @UseGuards(AuthenticationGuard)
  @RequirePermissions('admin')
  admin(): { ok: boolean } {
    return { ok: true };
  }

  @Post('protected/echo')
  @UseGuards(AuthenticationGuard)
  echo(
    @Body(new RequestBodyLimitPipe({ maxDepth: 3, maxBytes: 200 }))
    body: unknown,
  ): { received: boolean; body: unknown } {
    return { received: true, body };
  }
}

@Module({
  imports: [
    FoundationCoreModule.withHttpSecurity({
      imports: [FakeAdaptersModule],
      ports: {
        tokens: 'E2E_TOKENS',
        sessions: 'E2E_SESSIONS',
        identities: 'E2E_IDENTITIES',
        clock: 'E2E_CLOCK',
      },
      operationTimeoutMs: 5000,
    }),
  ],
  controllers: [ProbeController],
})
class ProbeAppModule {}

describe('HTTP security (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ProbeAppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    seed();
  });

  const server = () => app.getHttpServer();
  const as = (token: string, path = '/protected/whoami') =>
    request(server()).get(path).set('Authorization', `Bearer ${token}`);

  it('autoriza e expõe ator, tenant e correlação do principal atual', async () => {
    const response = await as('tok-a');
    expect(response.status).toBe(200);
    const body = response.body as Probe;
    expect(body).toMatchObject({ subjectId: 'user-a', tenantId: 'tenant-a' });
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.correlationId).toBe(response.headers['x-correlation-id']);
  });

  it('ignora header de tenant forjado', async () => {
    const response = await as('tok-a').set('x-tenant-id', 'tenant-b');
    expect(response.status).toBe(200);
    expect((response.body as Probe).tenantId).toBe('tenant-a');
  });

  it('preserva correlação válida e substitui inválida', async () => {
    const kept = await as('tok-a').set('x-correlation-id', 'client-123');
    expect(kept.headers['x-correlation-id']).toBe('client-123');
    expect((kept.body as Probe).correlationId).toBe('client-123');

    const replaced = await as('tok-a').set('x-correlation-id', 'bad id!');
    expect(replaced.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.headers['x-correlation-id']).not.toBe('bad id!');
  });

  it.each([
    ['sem header Authorization', (r: request.Test) => r],
    [
      'esquema não Bearer',
      (r: request.Test) => r.set('Authorization', 'Basic abc'),
    ],
    [
      'token desconhecido',
      (r: request.Test) => r.set('Authorization', 'Bearer tok-unknown'),
    ],
    [
      'token expirado',
      (r: request.Test) => r.set('Authorization', 'Bearer tok-expired-token'),
    ],
    [
      'sessão pendente',
      (r: request.Test) => r.set('Authorization', 'Bearer tok-pending'),
    ],
    [
      'sessão revogada',
      (r: request.Test) => r.set('Authorization', 'Bearer tok-revoked'),
    ],
    [
      'sessão com prazo vencido',
      (r: request.Test) => r.set('Authorization', 'Bearer tok-expired-session'),
    ],
    [
      'subject divergente',
      (r: request.Test) =>
        r.set('Authorization', 'Bearer tok-subject-mismatch'),
    ],
    [
      'identidade bloqueada',
      (r: request.Test) => r.set('Authorization', 'Bearer tok-blocked'),
    ],
  ])('nega com 401 neutro: %s', async (_name, build) => {
    const response = await build(request(server()).get('/protected/whoami'));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'unauthorized' });
    expect(JSON.stringify(response.body)).not.toMatch(
      /invalid_credentials|user-|sess-/,
    );
  });

  it.each([
    ['verifier lança', 'tok-verifier-throws'],
    ['sessão lança', 'tok-session-throws'],
    ['identidade lança', 'tok-identity-throws'],
  ])('nega com 503 sem vazar detalhe quando %s', async (_name, token) => {
    const response = await as(token);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'service_unavailable' });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|secret|down/);
  });

  it('nega com 403 quando a permissão declarada não foi concedida', async () => {
    const response = await as('tok-noperm', '/protected/admin');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'forbidden' });
  });

  it('nega com 403 quando o ator autenticado não tem a permissão da rota', async () => {
    const response = await as('tok-a', '/protected/admin');
    expect(response.status).toBe(403);
  });

  it('não expõe contexto em rota sem guard e traduz erro genérico para 500 neutro', async () => {
    const open = await request(server()).get('/open');
    expect(open.status).toBe(500);
    expect(open.body).toMatchObject({ error: 'internal_error' });

    const boom = await request(server()).get('/boom');
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain('segredo-do-banco');
    expect(boom.headers['x-correlation-id']).toBeDefined();
  });

  it('mantém 404 neutro para rota inexistente', async () => {
    const response = await request(server()).get('/nao-existe');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ statusCode: 404 });
  });

  it('isola atores e tenants em requisições concorrentes intercaladas', async () => {
    const expected = Array.from({ length: 40 }, (_, index) => ({
      token: index % 2 === 0 ? 'tok-a' : 'tok-b',
      subjectId: index % 2 === 0 ? 'user-a' : 'user-b',
      tenantId: index % 2 === 0 ? 'tenant-a' : 'tenant-b',
      correlationId: `concurrent-${index}`,
    }));
    const responses = await Promise.all(
      expected.map((item) =>
        as(item.token).set('x-correlation-id', item.correlationId),
      ),
    );
    responses.forEach((response, index) => {
      const item = expected[index];
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        subjectId: item?.subjectId,
        tenantId: item?.tenantId,
        correlationId: item?.correlationId,
      });
      expect(response.headers['x-correlation-id']).toBe(item?.correlationId);
    });
  });

  it('aplica limite de profundidade e tamanho no corpo com 400', async () => {
    const ok = await request(server())
      .post('/protected/echo')
      .set('Authorization', 'Bearer tok-a')
      .send({ a: { b: 1 } });
    expect(ok.status).toBe(201);

    const deep = await request(server())
      .post('/protected/echo')
      .set('Authorization', 'Bearer tok-a')
      .send({ a: { b: { c: { d: 1 } } } });
    expect(deep.status).toBe(400);

    const large = await request(server())
      .post('/protected/echo')
      .set('Authorization', 'Bearer tok-a')
      .send({ text: 'x'.repeat(300) });
    expect(large.status).toBe(400);
  });
});
