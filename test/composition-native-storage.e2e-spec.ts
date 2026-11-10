import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateCompositionFile } from '../src/core/infrastructure/composition/composition-generator';
import { AWS_S3_OBJECT_STORAGE, S3ObjectStorage } from '../src/native/aws-s3';
import {
  RedisRateLimiter,
  SHARED_RATE_LIMITER,
} from '../src/native/cache-redis';

/**
 * Composições geradas com natives de armazenamento e persistência. Sem LocalStack
 * nem PostgreSQL: o S3 é provado por um host token de dublê (o construtor do SDK não
 * abre conexão), e a persistência só prova que o módulo gerado compila e que o boot
 * falha de forma clara sem o host token, antes de qualquer conexão com o banco.
 */

interface GeneratedShape {
  readonly GeneratedCompositionModule: new () => object;
  readonly COMPOSITION_HOST_TOKENS: Record<string, symbol>;
}

// Módulo gerado: carregado do diretório temporário pelo require do Jest, que transforma o TypeScript.
const loadGenerated = (file: string): GeneratedShape =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(file) as GeneratedShape;

const S3_PROFILE = `foundationApiMajor: 1
natives:
  - id: native/aws-s3
extensions: []
`;

const PERSISTENCE_PROFILE = `foundationApiMajor: 1
natives:
  - id: native/persistence-typeorm
extensions: []
`;

const CACHE_PROFILE = `foundationApiMajor: 1
natives:
  - id: native/cache-redis
extensions: []
`;

// Porta fechada: o cliente falha rápido, sem Redis real. Timeouts mínimos evitam espera no boot.
const REDIS_DOUBLE_OPTIONS = {
  host: '127.0.0.1',
  port: 1,
  connectTimeoutMs: 10,
  commandTimeoutMs: 10,
};

const S3_DOUBLE_OPTIONS = {
  region: 'us-east-1',
  bucket: 'foundation-test',
  endpoint: 'http://127.0.0.1:9',
  forcePathStyle: true,
};

describe('composição nativa gerada: armazenamento e persistência', () => {
  let tempDir: string;
  let apps: INestApplication[] = [];

  beforeAll(() => {
    // realpath: em macOS o tmpdir é link simbólico; imports relativos precisam do caminho real.
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-native-storage-')),
    );
    // O diretório temporário precisa enxergar as dependências do projeto para compilar o arquivo gerado.
    fs.symlinkSync(
      path.resolve(__dirname, '../node_modules'),
      path.join(tempDir, 'node_modules'),
      'dir',
    );
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps = [];
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Gera e carrega uma composição isolada; cada perfil ganha seu próprio arquivo. */
  function generate(name: string, profile: string): GeneratedShape {
    const outputPath = path.join(tempDir, `${name}.composition.generated.ts`);
    generateCompositionFile({
      profileSource: profile,
      extensions: [],
      outputPath,
      check: false,
    });
    return loadGenerated(outputPath);
  }

  /** Módulo de host global com os tokens informados; ausentes simulam host sem configuração. */
  function hostModule(tokens: Array<[symbol, unknown]>) {
    @Global()
    @Module({
      providers: tokens.map(([provide, useValue]) => ({ provide, useValue })),
      exports: tokens.map(([provide]) => provide),
    })
    class HostModule {}
    return HostModule;
  }

  async function boot(
    generated: GeneratedShape,
    tokens: Array<[symbol, unknown]>,
  ): Promise<INestApplication> {
    @Module({ imports: [generated.GeneratedCompositionModule] })
    class RootModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [hostModule(tokens), RootModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    apps.push(app);
    await app.init();
    return app;
  }

  it('gera composição com native/aws-s3 que compila e resolve o object storage com host token de dublê', async () => {
    const generated = generate('aws-s3', S3_PROFILE);
    const app = await boot(generated, [
      [generated.COMPOSITION_HOST_TOKENS.awsS3Options, S3_DOUBLE_OPTIONS],
    ]);
    expect(app.get(AWS_S3_OBJECT_STORAGE)).toBeInstanceOf(S3ObjectStorage);
  });

  it('falha no boot com erro claro quando falta o host token de native/aws-s3', async () => {
    const generated = generate('aws-s3-missing', S3_PROFILE);
    const description = 'foundation.api.v1.host.aws-s3.options';
    await expect(boot(generated, [])).rejects.toThrow(description);
  });

  it('gera composição com native/persistence-typeorm que compila e falha sem o host token', async () => {
    const generated = generate('persistence', PERSISTENCE_PROFILE);
    const description = 'foundation.api.v1.host.persistence.options';
    expect(generated.COMPOSITION_HOST_TOKENS.persistenceOptions).toBeDefined();
    await expect(boot(generated, [])).rejects.toThrow(description);
  });

  it('gera composição com native/cache-redis que compila e resolve o rate limiter com host token de dublê', async () => {
    const generated = generate('cache-redis', CACHE_PROFILE);
    const app = await boot(generated, [
      [
        generated.COMPOSITION_HOST_TOKENS.cacheRedisOptions,
        REDIS_DOUBLE_OPTIONS,
      ],
    ]);
    expect(app.get(SHARED_RATE_LIMITER)).toBeInstanceOf(RedisRateLimiter);
  });

  it('falha no boot com erro claro quando falta o host token de native/cache-redis', async () => {
    const generated = generate('cache-redis-missing', CACHE_PROFILE);
    const description = 'foundation.api.v1.host.cache-redis.options';
    await expect(boot(generated, [])).rejects.toThrow(description);
  });
});
