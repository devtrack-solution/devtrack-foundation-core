import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  Controller,
  Get,
  Global,
  Module,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { generateCompositionFile } from '../src/core/infrastructure/composition/composition-generator';
import { AuthenticationGuard } from '../src/core/presentation/http/guards/authentication.guard';
import { JwtAccessTokenAdapter } from '../src/native/jwt-auth/jwt-auth.adapter';
import type { JwtAuthOptions } from '../src/native/jwt-auth/jwt-auth.options';
import type { GeneratedCompositionModule as GeneratedModuleClass } from '../src/composition/composition.generated';

/** Tokens de host exigidos pelo módulo gerado com http-security + jwt-auth. */
type HostTokenName = 'jwtAuthOptions' | 'sessions' | 'identities' | 'clock';

interface GeneratedShape {
  readonly GeneratedCompositionModule: typeof GeneratedModuleClass;
  readonly COMPOSITION_HOST_TOKENS: Record<HostTokenName, symbol>;
  readonly COMPOSITION_METADATA: {
    readonly modules: readonly { id: string }[];
  };
}

const HOST_TOKEN_SUFFIX: Record<HostTokenName, string> = {
  jwtAuthOptions: 'jwt-auth.options',
  sessions: 'sessions',
  identities: 'identities',
  clock: 'clock',
};

const PROFILE = `foundationApiMajor: 1
natives:
  - id: native/http-security
  - id: native/jwt-auth
extensions: []
`;

const NOW = Date.now();
const SUBJECT = 'user-a';
const SESSION_ID = 'sess-user-a';

// Módulo gerado: carregado do diretório temporário pelo require do Jest, que transforma o TypeScript.
const loadGenerated = (file: string): GeneratedShape =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(file) as GeneratedShape;

describe('composição nativa gerada: http-security + jwt-auth', () => {
  let tempDir: string;
  let generated: GeneratedShape;
  let jwtOptions: JwtAuthOptions;
  let sessions: Map<
    string,
    { id: string; subjectId: string; state: string; expiresAt: number }
  >;
  let identities: Map<
    string,
    { subjectId: string; permissions: string[] } | null
  >;
  let app: INestApplication<App> | undefined;

  beforeAll(() => {
    // realpath: em macOS o tmpdir é link simbólico; imports relativos precisam do caminho real.
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-native-')),
    );
    // O diretório temporário precisa enxergar as dependências do projeto para compilar o arquivo gerado.
    fs.symlinkSync(
      path.resolve(__dirname, '../node_modules'),
      path.join(tempDir, 'node_modules'),
      'dir',
    );
    const outputPath = path.join(tempDir, 'composition.generated.ts');
    generateCompositionFile({
      profileSource: PROFILE,
      extensions: [],
      outputPath,
      check: false,
    });
    generated = loadGenerated(outputPath);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    jwtOptions = {
      issuer: 'https://auth.example.test',
      audience: 'foundation-api',
      ttlMs: 15 * 60_000,
      clockToleranceMs: 1_000,
      algorithms: ['EdDSA'],
      signingKey: { kid: 'ed-test', alg: 'EdDSA', key: privateKey },
      verificationKeys: [{ kid: 'ed-test', alg: 'EdDSA', key: publicKey }],
      clock: { now: () => Date.now() },
    };
  });

  beforeEach(() => {
    sessions = new Map([
      [
        SESSION_ID,
        {
          id: SESSION_ID,
          subjectId: SUBJECT,
          state: 'active',
          expiresAt: NOW + 60 * 60_000,
        },
      ],
    ]);
    identities = new Map([[SUBJECT, { subjectId: SUBJECT, permissions: [] }]]);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Módulo de host global com os tokens informados; `omit` simula um token ausente. */
  function hostModule(omit?: HostTokenName) {
    const tokens = generated.COMPOSITION_HOST_TOKENS;
    const all: Record<HostTokenName, unknown> = {
      jwtAuthOptions: jwtOptions,
      sessions: {
        find: (id: string) => Promise.resolve(sessions.get(id) ?? null),
      },
      identities: {
        bySubject: (subjectId: string) =>
          Promise.resolve(identities.get(subjectId) ?? null),
        byExternalIdentity: () => Promise.resolve(null),
      },
      clock: { now: () => Date.now() },
    };
    const names = (Object.keys(all) as HostTokenName[]).filter(
      (name) => name !== omit,
    );
    @Global()
    @Module({
      providers: names.map((name) => ({
        provide: tokens[name],
        useValue: all[name],
      })),
      exports: names.map((name) => tokens[name]),
    })
    class HostModule {}
    return HostModule;
  }

  @Controller()
  class ProbeController {
    @Get('protected')
    @UseGuards(AuthenticationGuard)
    protectedRoute(): { ok: boolean } {
      return { ok: true };
    }
  }

  /** Sonda protegida: importa o módulo gerado para receber o OperationAuthorizer exportado. */
  function probeModule() {
    @Module({
      imports: [generated.GeneratedCompositionModule],
      controllers: [ProbeController],
    })
    class ProbeModule {}
    return ProbeModule;
  }

  async function boot(omit?: HostTokenName): Promise<INestApplication<App>> {
    const moduleRef = await Test.createTestingModule({
      imports: [hostModule(omit), probeModule()],
    }).compile();
    const instance = moduleRef.createNestApplication<INestApplication<App>>();
    await instance.init();
    return instance;
  }

  it('compila o módulo gerado e registra os módulos nativos selecionados', () => {
    expect(generated.COMPOSITION_METADATA.modules.map((m) => m.id)).toEqual([
      'native/jwt-auth',
      'native/http-security',
    ]);
  });

  it('nega rota protegida sem token com 401', async () => {
    app = await boot();
    await request(app.getHttpServer()).get('/protected').expect(401);
  });

  it('libera rota protegida com token emitido pelo JwtAccessTokenAdapter e sessão ativa', async () => {
    app = await boot();
    const issuer = new JwtAccessTokenAdapter(jwtOptions);
    const issued = await issuer.issue({
      principal: { subjectId: SUBJECT, permissions: [] },
      session: { id: SESSION_ID, expiresAt: NOW + 60 * 60_000 },
      method: { kind: 'password' },
    });
    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${issued.value}`)
      .expect(200)
      .expect({ ok: true });
  });

  it('nega o mesmo token quando a sessão foi revogada no armazenamento', async () => {
    app = await boot();
    const issued = await new JwtAccessTokenAdapter(jwtOptions).issue({
      principal: { subjectId: SUBJECT, permissions: [] },
      session: { id: SESSION_ID, expiresAt: NOW + 60 * 60_000 },
      method: { kind: 'password' },
    });
    sessions.set(SESSION_ID, {
      id: SESSION_ID,
      subjectId: SUBJECT,
      state: 'revoked',
      expiresAt: NOW + 60 * 60_000,
    });
    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${issued.value}`)
      .expect(401);
  });

  for (const missing of [
    'jwtAuthOptions',
    'sessions',
    'identities',
    'clock',
  ] as const) {
    it(`falha no boot quando falta o host token ${missing} e não abre a rota`, async () => {
      const description = `foundation.api.v1.host.${HOST_TOKEN_SUFFIX[missing]}`;
      await expect(boot(missing)).rejects.toThrow(description);
    });
  }
});
