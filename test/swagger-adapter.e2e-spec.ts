import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Controller,
  Get,
  Global,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { generateCompositionFile } from '../src/core/infrastructure/composition/composition-generator';
import {
  CreateFixtureContactDto,
  FixtureContactsController,
} from './fixtures/fixture-contacts';

const WITH_SWAGGER = `foundationApiMajor: 1
natives:
  - id: native/swagger-adapter
extensions: []
`;
const WITHOUT_SWAGGER = `foundationApiMajor: 1
natives: []
extensions: []
`;
const HOST_OPTIONS = { title: 'Foundation Test API', version: '9.9.9' };
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'fixture-contacts.ts');

interface GeneratedShape {
  readonly GeneratedCompositionModule: unknown;
  readonly COMPOSITION_HOST_TOKENS: Record<string, symbol>;
}

describe('native swagger adapter', () => {
  let tempDir: string;
  let withSwagger: GeneratedShape;
  let withoutSwagger: GeneratedShape;
  let app: INestApplication<App> | undefined;

  beforeAll(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-swagger-')),
    );
    fs.symlinkSync(
      path.resolve(__dirname, '../node_modules'),
      path.join(tempDir, 'node_modules'),
      'dir',
    );
    const on = path.join(tempDir, 'on', 'composition.generated.ts');
    const off = path.join(tempDir, 'off', 'composition.generated.ts');
    fs.mkdirSync(path.dirname(on));
    fs.mkdirSync(path.dirname(off));
    generateCompositionFile({
      profileSource: WITH_SWAGGER,
      extensions: [],
      outputPath: on,
      check: false,
    });
    generateCompositionFile({
      profileSource: WITHOUT_SWAGGER,
      extensions: [],
      outputPath: off,
      check: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    withSwagger = require(on) as GeneratedShape;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    withoutSwagger = require(off) as GeneratedShape;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function hostModule(generated: GeneratedShape, options: unknown) {
    const tokens = generated.COMPOSITION_HOST_TOKENS;
    const providers = Object.keys(tokens)
      .filter((name) => name === 'swaggerOptions')
      .map((name) => ({ provide: tokens[name], useValue: options }));
    @Global()
    @Module({ providers, exports: providers.map((p) => p.provide) })
    class HostModule {}
    return HostModule;
  }

  @Controller()
  class ProbeController {
    @Get('probe')
    probe(): { ok: boolean } {
      return { ok: true };
    }
  }

  async function boot(generated: GeneratedShape, options?: unknown) {
    const generatedModule = generated.GeneratedCompositionModule as never;
    @Module({
      imports: [generatedModule],
      controllers: [ProbeController, FixtureContactsController],
    })
    class ProbeModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [hostModule(generated, options), ProbeModule],
    }).compile();
    const instance = moduleRef.createNestApplication<INestApplication<App>>();
    await instance.init();
    return instance;
  }

  it('selected: serves the OpenAPI document with the neutral DTO schema', async () => {
    app = await boot(withSwagger, HOST_OPTIONS);
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const doc = response.body as {
      info: { title: string; version: string };
      paths: Record<
        string,
        {
          post?: {
            requestBody?: { content: Record<string, { schema: unknown }> };
          };
        }
      >;
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties: Record<string, Record<string, unknown>>;
          }
        >;
      };
    };
    expect(doc.info).toMatchObject({
      title: HOST_OPTIONS.title,
      version: HOST_OPTIONS.version,
    });
    const schema = doc.components.schemas[CreateFixtureContactDto.name];
    expect(schema.required).toEqual(['name']);
    expect(schema.properties.name).toMatchObject({
      type: 'string',
      maxLength: 120,
    });
    expect(schema.properties.nickname).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(schema.properties.score).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 10,
    });
    expect(
      doc.paths['/fixture-contacts'].post?.requestBody?.content[
        'application/json'
      ].schema,
    ).toEqual({
      $ref: `#/components/schemas/${CreateFixtureContactDto.name}`,
    });
  });

  it('selected: serves the documentation UI on the configured path', async () => {
    app = await boot(withSwagger, HOST_OPTIONS);
    await request(app.getHttpServer())
      .get('/docs')
      .expect(200)
      .expect('content-type', /html/);
  });

  it('selected: keeps the same DTO working in the request path', async () => {
    app = await boot(withSwagger, HOST_OPTIONS);
    await request(app.getHttpServer())
      .post('/fixture-contacts')
      .send({ name: 'Ana' })
      .expect(201)
      .expect({ id: 'fixture-1', name: 'Ana' });
  });

  it('not selected: exposes neither /docs nor /docs-json', async () => {
    app = await boot(withoutSwagger);
    await request(app.getHttpServer()).get('/docs').expect(404);
    await request(app.getHttpServer()).get('/docs-json').expect(404);
  });

  it('not selected: the same DTO keeps working without any documentation', async () => {
    app = await boot(withoutSwagger);
    await request(app.getHttpServer())
      .post('/fixture-contacts')
      .send({ name: 'Ana' })
      .expect(201);
  });

  it('not selected: the generated file does not reference swagger', () => {
    const source = fs.readFileSync(
      path.join(tempDir, 'off', 'composition.generated.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/swagger/i);
  });

  it('selected: the generated file requires only the host options token', () => {
    const source = fs.readFileSync(
      path.join(tempDir, 'on', 'composition.generated.ts'),
      'utf8',
    );
    expect(source).toContain('swaggerOptions');
    expect(source).not.toMatch(/@nestjs\/swagger/);
  });

  it('the fixture extension does not import the documentation library', () => {
    const source = fs.readFileSync(FIXTURE_FILE, 'utf8');
    expect(source).not.toMatch(/from ['"][^'"]*swagger/i);
  });
});
