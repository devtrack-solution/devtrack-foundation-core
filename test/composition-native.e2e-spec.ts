import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import type { ExtensionSource } from '../src/core/infrastructure/composition/composition-profile';
import { AuthenticationGuard } from '../src/core/presentation/http/guards/authentication.guard';
import type { GeneratedCompositionModule as GeneratedModuleClass } from '../src/composition/composition.generated';

/** Tokens de host exigidos pelo módulo gerado com http-security + extensão de access-token. */
type HostTokenName =
  'accessTokenFixtureOptions' | 'sessions' | 'identities' | 'clock';

interface GeneratedShape {
  readonly GeneratedCompositionModule: typeof GeneratedModuleClass;
  readonly COMPOSITION_HOST_TOKENS: Record<HostTokenName, symbol>;
  readonly COMPOSITION_METADATA: {
    readonly modules: readonly { id: string }[];
  };
}

const HOST_TOKEN_SUFFIX: Record<HostTokenName, string> = {
  accessTokenFixtureOptions: 'access-token-fixture.options',
  sessions: 'sessions',
  identities: 'identities',
  clock: 'clock',
};

const INTEGRITY = 'sha512-ZmFrZS1pbnRlZ3JpdHktZm9yLXRlc3RzCg==';
const FIXTURE_PACKAGE = 'fixture-access-token';

/** Extensão npm de teste que fornece `access-token`, montada pelo bloco `composition` (D7). */
const ACCESS_TOKEN_EXTENSION: ExtensionSource = {
  descriptor: {
    id: 'ext/access-token-fixture',
    foundationApiMajor: 1,
    origin: {
      kind: 'npm',
      packageName: FIXTURE_PACKAGE,
      version: '1.0.0',
      integrity: INTEGRITY,
    },
    provides: [{ id: 'access-token', major: 1 }],
    requires: [],
  },
  exportName: 'FixtureAccessTokenModule',
  composition: {
    hostOptions: {
      token: 'access-token-fixture.options',
      type: 'FixtureAccessTokenOptions',
    },
    capabilityTokens: { 'access-token': 'FIXTURE_ACCESS_TOKEN' },
  },
};

const PROFILE = `foundationApiMajor: 1
natives:
  - id: native/http-security
extensions:
  - id: ext/access-token-fixture
    packageName: ${FIXTURE_PACKAGE}
    version: 1.0.0
    integrity: ${INTEGRITY}
`;

/** Pacote instalado em node_modules: JS sem transformação mais tipos, como um pacote publicado. */
const FIXTURE_JS = `'use strict';
const { Module } = require('@nestjs/common');
const FIXTURE_ACCESS_TOKEN = Symbol.for('fixture.access-token.verifier');
class FixtureAccessTokenModule {
  static registerAsync(options) {
    return {
      module: FixtureAccessTokenModule,
      providers: [{
        provide: FIXTURE_ACCESS_TOKEN,
        inject: [...(options.inject || [])],
        useFactory: async (...args) => {
          const config = await options.useFactory(...args);
          return { verify: (value) => Promise.resolve(config.tokens[value] || null) };
        },
      }],
      exports: [FIXTURE_ACCESS_TOKEN],
    };
  }
}
Module({})(FixtureAccessTokenModule);
module.exports = { FIXTURE_ACCESS_TOKEN, FixtureAccessTokenModule };
`;
const FIXTURE_DTS = `import type { DynamicModule } from '@nestjs/common';
export interface FixtureAccessTokenOptions {
  readonly tokens: Readonly<Record<string, { subjectId: string; sessionId: string; expiresAt: number }>>;
}
export declare const FIXTURE_ACCESS_TOKEN: unique symbol;
export declare class FixtureAccessTokenModule {
  static registerAsync(options: {
    readonly inject?: readonly symbol[];
    readonly useFactory: (...args: unknown[]) => FixtureAccessTokenOptions | Promise<FixtureAccessTokenOptions>;
  }): DynamicModule;
}
`;
const VALID_TOKEN = 'token-user-a';

const NOW = Date.now();
const SUBJECT = 'user-a';
const SESSION_ID = 'sess-user-a';

// Módulo gerado: carregado do diretório temporário pelo require do Jest, que transforma o TypeScript.
const loadGenerated = (file: string): GeneratedShape =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(file) as GeneratedShape;

describe('composição gerada: http-security + extensão npm de access-token', () => {
  let tempDir: string;
  let generated: GeneratedShape;
  let tokenOptions: {
    tokens: Record<
      string,
      { subjectId: string; sessionId: string; expiresAt: number }
    >;
  };
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
    // node_modules do diretório temporário: as dependências do projeto (links) mais o pacote fixture.
    const projectModules = path.resolve(__dirname, '../node_modules');
    const tempModules = path.join(tempDir, 'node_modules');
    fs.mkdirSync(tempModules);
    for (const entry of fs.readdirSync(projectModules))
      fs.symlinkSync(
        path.join(projectModules, entry),
        path.join(tempModules, entry),
        'dir',
      );
    const fixtureDir = path.join(tempModules, FIXTURE_PACKAGE);
    fs.mkdirSync(fixtureDir);
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: FIXTURE_PACKAGE,
        version: '1.0.0',
        main: 'index.js',
        types: 'index.d.ts',
      }),
    );
    fs.writeFileSync(path.join(fixtureDir, 'index.js'), FIXTURE_JS);
    fs.writeFileSync(path.join(fixtureDir, 'index.d.ts'), FIXTURE_DTS);

    const outputPath = path.join(tempDir, 'composition.generated.ts');
    generateCompositionFile({
      profileSource: PROFILE,
      extensions: [ACCESS_TOKEN_EXTENSION],
      outputPath,
      check: false,
    });
    generated = loadGenerated(outputPath);

    tokenOptions = {
      tokens: {
        [VALID_TOKEN]: {
          subjectId: SUBJECT,
          sessionId: SESSION_ID,
          expiresAt: NOW + 60 * 60_000,
        },
      },
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
      accessTokenFixtureOptions: tokenOptions,
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

  it('compila o módulo gerado e registra a extensão antes do http-security', () => {
    expect(generated.COMPOSITION_METADATA.modules.map((m) => m.id)).toEqual([
      'ext/access-token-fixture',
      'native/http-security',
    ]);
  });

  it('nega rota protegida sem token com 401', async () => {
    app = await boot();
    await request(app.getHttpServer()).get('/protected').expect(401);
  });

  it('libera rota protegida com token aceito pelo verificador da extensão e sessão ativa', async () => {
    app = await boot();
    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200)
      .expect({ ok: true });
  });

  it('nega token que o verificador da extensão não reconhece', async () => {
    app = await boot();
    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', 'Bearer token-desconhecido')
      .expect(401);
  });

  it('nega o mesmo token quando a sessão foi revogada no armazenamento', async () => {
    app = await boot();
    sessions.set(SESSION_ID, {
      id: SESSION_ID,
      subjectId: SUBJECT,
      state: 'revoked',
      expiresAt: NOW + 60 * 60_000,
    });
    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(401);
  });

  for (const missing of [
    'accessTokenFixtureOptions',
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
