import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_SOURCES } from '../../../composition/extension-sources';
import { NATIVE_MODULE_DESCRIPTORS } from '../../application/modules/native-catalog';
import type { ExtensionSource } from './composition-profile';
import { NATIVE_SOURCES } from './native-sources';
import {
  DEFAULT_INSTRUMENTATION_OUTPUT,
  generateCompositionFile,
  generateInstrumentationFile,
  renderComposition,
  renderInstrumentation,
} from './composition-generator';

const INTEGRITY = 'sha512-ZmFrZS1pbnRlZ3JpdHktZm9yLXRlc3RzCg==';
const COMPOSITION_FILE = path.resolve(
  __dirname,
  '../../../composition/composition.generated.ts',
);
const PROFILE_FILE = path.resolve(
  __dirname,
  '../../../../config/composition.yaml',
);

function protectedSource(
  id = 'ext/protected-demo',
  requires = true,
): ExtensionSource {
  return {
    descriptor: {
      id,
      foundationApiMajor: 1,
      origin: {
        kind: 'npm',
        packageName: `fixture-${id.replace('ext/', '')}`,
        version: '1.0.0',
        integrity: INTEGRITY,
      },
      provides: [],
      requires: requires ? [{ id: 'authenticator', major: 1 }] : [],
    },
    exportName: 'ProtectedDemoModule',
  };
}

const protectedDemo = protectedSource();
const plainDemo = protectedSource('ext/plain-demo', false);

/** http-security com o access-token vindo de uma extensão npm (papel do antigo native/jwt-auth). */
const withSecurity = `foundationApiMajor: 1
natives:
  - id: native/http-security
extensions:
${extensionEntry('ext/jwt-fixture')}${extensionEntry('ext/protected-demo')}`;

/** Código do erro lançado pela ação, ou undefined quando nada é lançado. */
function thrownCode(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-composition-'));
}

describe('composition generator', () => {
  it('keeps the native source table aligned with the native catalog', () => {
    expect(Object.keys(NATIVE_SOURCES).sort()).toEqual(
      NATIVE_MODULE_DESCRIPTORS.map((d) => d.id).sort(),
    );
  });

  it('renders the default host without extensions, JWT or dynamic imports', () => {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8');
    const { source, resolved } = renderComposition(profile, EXTENSION_SOURCES);
    expect(resolved.modules).toEqual([]);
    expect(source).toContain('export class GeneratedCompositionModule');
    expect(source).toContain('gerado — não editar');
    expect(source).not.toMatch(/jwt-auth|foundation-core|import\(|require\(/);
  });

  it('keeps swagger out of the default output and registers ext/swagger-adapter with the same host token', () => {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8');
    expect(renderComposition(profile, EXTENSION_SOURCES).source).not.toMatch(
      /swagger/i,
    );
    const swagger: ExtensionSource = {
      ...configurableSource(
        'ext/swagger-adapter',
        {
          hostOptions: {
            token: 'swagger.options',
            type: 'SwaggerAdapterOptions',
          },
        },
        [{ id: 'api-documentation', major: 1 }],
      ),
      exportName: 'SwaggerAdapterModule',
    };
    const selected = `foundationApiMajor: 1
natives: []
extensions:
${extensionEntry('ext/swagger-adapter')}`;
    const { source } = renderComposition(selected, [swagger]);
    expect(source).toContain(`from 'fixture-swagger-adapter'`);
    expect(source).toContain('extSwaggerAdapterModule.registerAsync');
    expect(source).toContain(
      `swaggerOptions: Symbol.for('foundation.api.v1.host.swagger.options')`,
    );
    expect(source).not.toMatch(/from '@nestjs\/swagger'/);
  });

  it('matches the committed generated file exactly', () => {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8');
    const { source } = renderComposition(profile, EXTENSION_SOURCES);
    expect(fs.readFileSync(COMPOSITION_FILE, 'utf8')).toBe(source);
  });

  it('imports the queue producer with persistence, host options and host identity', () => {
    const profile = `foundationApiMajor: 1
natives:
  - id: native/persistence-typeorm
  - id: native/queue-bullmq
extensions: []
`;
    const { source, resolved } = renderComposition(profile, EXTENSION_SOURCES);
    expect(resolved.orderedModuleIds).toEqual([
      'native/persistence-typeorm',
      'native/queue-bullmq',
    ]);
    expect(source).toContain(`from '../native/queue-bullmq'`);
    expect(source).toContain('QueueBullmqModule.registerAsync');
    expect(source).toContain('imports: [nativePersistenceTypeorm]');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.queueBullmqOptions');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.jobIdentityResolver');
    expect(source).toContain(`from '../native/persistence-typeorm/activities'`);
    expect(source).not.toMatch(/consume:\s*true|from 'bullmq'|ioredis/);
  });

  it('rejects queue-bullmq without persistence as a missing dependency', () => {
    expect(
      thrownCode(() =>
        renderComposition(
          `foundationApiMajor: 1
natives:
  - id: native/queue-bullmq
extensions: []
`,
          EXTENSION_SOURCES,
        ),
      ),
    ).toBe('MISSING_PROVIDER');
  });

  it('rejects a protected extension without an authenticator and writes nothing', () => {
    const dir = tempDir();
    const outputPath = path.join(dir, 'composition.generated.ts');
    try {
      expect(
        thrownCode(() =>
          generateCompositionFile({
            profileSource: `foundationApiMajor: 1
natives: []
extensions:
  - id: ext/protected-demo
    packageName: fixture-protected-demo
    version: 1.0.0
    integrity: ${INTEGRITY}
`,
            extensions: [protectedDemo],
            outputPath,
            check: false,
          }),
        ),
      ).toBe('MISSING_PROVIDER');
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the protected extension with http-security and an access-token extension and imports them statically', () => {
    const { source, resolved } = renderComposition(withSecurity, [
      jwtFixture,
      protectedDemo,
    ]);
    expect(resolved.orderedModuleIds).toEqual([
      'ext/jwt-fixture',
      'native/http-security',
      'ext/protected-demo',
    ]);
    expect(source).toContain(`from 'fixture-jwt-fixture'`);
    expect(source).toContain(
      `from '../core/infrastructure/modules/foundation-core.module'`,
    );
    expect(source).toContain(`from 'fixture-protected-demo'`);
    expect(source).toContain('FoundationCoreModule.withHttpSecurity');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.jwtFixtureOptions');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.sessions');
    expect(source).not.toMatch(/import\(|require\(/);
  });

  it('imports only the selected natives', () => {
    const s3Only = `foundationApiMajor: 1
natives:
  - id: native/aws-s3
extensions:
  - id: ext/plain-demo
    packageName: fixture-plain-demo
    version: 1.0.0
    integrity: ${INTEGRITY}
`;
    const { source } = renderComposition(s3Only, [plainDemo]);
    expect(source).toContain(`from '../native/aws-s3'`);
    expect(source).not.toContain('foundation-core');
    expect(source).not.toContain('withHttpSecurity');
  });

  it('omits jwt-auth from the output when it is not selected', () => {
    const extensionOnly = `foundationApiMajor: 1
natives: []
extensions:
  - id: ext/plain-demo
    packageName: fixture-plain-demo
    version: 1.0.0
    integrity: ${INTEGRITY}
`;
    const { source } = renderComposition(extensionOnly, [plainDemo]);
    expect(source).not.toContain('jwt-auth');
    expect(source).not.toContain('JwtAuthModule');
    expect(source).toContain(`from 'fixture-plain-demo'`);
  });

  it('produces byte-identical output for equivalent profiles in a different order', () => {
    const reordered = `foundationApiMajor: 1
bindings:
  - consumer: native/http-security
    capability: access-token
    provider: ext/jwt-fixture
extensions:
  - id: ext/protected-demo
    integrity: ${INTEGRITY}
    version: 1.0.0
    packageName: fixture-protected-demo
  - id: ext/jwt-fixture
    integrity: ${INTEGRITY}
    version: 1.0.0
    packageName: fixture-jwt-fixture
natives:
  - id: native/http-security
`;
    const first = renderComposition(withSecurity, [jwtFixture, protectedDemo]);
    const second = renderComposition(reordered, [protectedDemo, jwtFixture]);
    expect(second.source).toBe(first.source);
  });

  it('fails the check mode when the generated file is stale and repairs it in write mode', () => {
    const dir = tempDir();
    const outputPath = path.join(dir, 'composition.generated.ts');
    try {
      const options = {
        profileSource: withSecurity,
        extensions: [jwtFixture, protectedDemo],
        outputPath,
      };
      expect(
        thrownCode(() => generateCompositionFile({ ...options, check: true })),
      ).toBe('GENERATED_STALE');

      generateCompositionFile({ ...options, check: false });
      expect(
        thrownCode(() => generateCompositionFile({ ...options, check: true })),
      ).toBeUndefined();

      fs.appendFileSync(outputPath, '// edited by hand\n');
      expect(
        thrownCode(() => generateCompositionFile({ ...options, check: true })),
      ).toBe('GENERATED_STALE');

      generateCompositionFile({ ...options, check: false });
      expect(
        thrownCode(() => generateCompositionFile({ ...options, check: true })),
      ).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function configurableSource(
  id: string,
  composition: ExtensionSource['composition'],
  provides = [{ id: 'access-token', major: 1 }],
): ExtensionSource {
  return {
    descriptor: {
      id,
      foundationApiMajor: 1,
      origin: {
        kind: 'npm',
        packageName: `fixture-${id.replace('ext/', '')}`,
        version: '1.0.0',
        integrity: INTEGRITY,
      },
      provides,
      requires: [],
    },
    exportName: 'JwtFixtureModule',
    composition,
  };
}

function extensionEntry(id: string): string {
  return `  - id: ${id}
    packageName: fixture-${id.replace('ext/', '')}
    version: 1.0.0
    integrity: ${INTEGRITY}
`;
}

const jwtFixture = configurableSource('ext/jwt-fixture', {
  hostOptions: { token: 'jwt-fixture.options', type: 'JwtFixtureOptions' },
  capabilityTokens: { 'access-token': 'JWT_FIXTURE_VERIFIER' },
});

const securityWithExtensionToken = `foundationApiMajor: 1
natives:
  - id: native/http-security
extensions:
${extensionEntry('ext/jwt-fixture')}${extensionEntry('ext/protected-demo')}`;

describe('configurable npm extensions (composition block)', () => {
  it('registers the extension with host options declared in its descriptor', () => {
    const { source } = renderComposition(securityWithExtensionToken, [
      jwtFixture,
      protectedDemo,
    ]);
    expect(source).toMatch(
      /import \{\s*JWT_FIXTURE_VERIFIER,\s*JwtFixtureModule as extJwtFixtureModule,?\s*\} from 'fixture-jwt-fixture';/,
    );
    expect(source).toContain(
      `import type { JwtFixtureOptions } from 'fixture-jwt-fixture';`,
    );
    expect(source).toContain(
      `jwtFixtureOptions: Symbol.for('foundation.api.v1.host.jwt-fixture.options')`,
    );
    expect(source).toMatch(
      /const extJwtFixture = extJwtFixtureModule\.registerAsync\(\{\s*inject: \[COMPOSITION_HOST_TOKENS\.jwtFixtureOptions\],/,
    );
    expect(source).not.toMatch(/import\(|require\(/);
  });

  it('binds http-security to the access-token export of an extension', () => {
    const { source, resolved } = renderComposition(securityWithExtensionToken, [
      jwtFixture,
      protectedDemo,
    ]);
    expect(resolved.bindings).toContainEqual({
      consumerId: 'native/http-security',
      capabilityId: 'access-token',
      providerId: 'ext/jwt-fixture',
    });
    expect(source).toMatch(/imports: \[extJwtFixture\]/);
    expect(source).toContain('tokens: JWT_FIXTURE_VERIFIER');
  });

  it('keeps the plain import for an extension without a composition block', () => {
    const profile = `foundationApiMajor: 1
natives: []
extensions:
${extensionEntry('ext/plain-demo')}`;
    const { source } = renderComposition(profile, [plainDemo]);
    expect(source).toContain(
      `import { ProtectedDemoModule as extPlainDemoModule } from 'fixture-plain-demo';`,
    );
    expect(source).not.toContain('registerAsync');
    expect(source).toContain('imports: [extPlainDemoModule]');
  });

  it.each([
    [
      'host token with invalid characters',
      { hostOptions: { token: 'Bad Token', type: 'JwtFixtureOptions' } },
    ],
    [
      'options type that is not an identifier',
      { hostOptions: { token: 'jwt-fixture.options', type: 'a-b' } },
    ],
    [
      'capability token for a capability it does not provide',
      { capabilityTokens: { 'object-storage': 'STORAGE' } },
    ],
  ])('rejects a composition block with %s', (_label, composition) => {
    const profile = `foundationApiMajor: 1
natives: []
extensions:
${extensionEntry('ext/jwt-fixture')}`;
    expect(
      thrownCode(() =>
        renderComposition(profile, [
          configurableSource('ext/jwt-fixture', composition),
        ]),
      ),
    ).toBe('GENERATOR_INVALID_EXTENSION');
  });

  it('rejects two extensions that declare the same host token', () => {
    const shared = {
      hostOptions: { token: 'shared.options', type: 'SharedOptions' },
    };
    const profile = `foundationApiMajor: 1
natives: []
extensions:
${extensionEntry('ext/first-fixture')}${extensionEntry('ext/second-fixture')}`;
    expect(
      thrownCode(() =>
        renderComposition(profile, [
          configurableSource('ext/first-fixture', shared, []),
          configurableSource('ext/second-fixture', shared, []),
        ]),
      ),
    ).toBe('GENERATOR_INVALID_EXTENSION');
  });
});

describe('instrumentation generator', () => {
  const withOtel = `foundationApiMajor: 1
natives:
  - id: native/opentelemetry
extensions: []
`;

  it('renders an empty instrumentation file without any import when telemetry is not selected', () => {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8');
    const { source, resolved } = renderInstrumentation(
      profile,
      EXTENSION_SOURCES,
    );
    expect(resolved.modules).toEqual([]);
    expect(source).toContain('export {};');
    expect(source).not.toMatch(/import|require\(|opentelemetry/i);
  });

  it('imports only the native bootstrap when telemetry is selected', () => {
    const { source } = renderInstrumentation(withOtel, EXTENSION_SOURCES);
    expect(source).toContain(`import '../native/opentelemetry/bootstrap';`);
    expect(source.match(/^import /gm)).toHaveLength(1);
  });

  it('is byte-identical across renders and matches the committed file', () => {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8');
    const first = renderInstrumentation(withOtel, EXTENSION_SOURCES).source;
    expect(renderInstrumentation(withOtel, EXTENSION_SOURCES).source).toBe(
      first,
    );
    expect(fs.readFileSync(DEFAULT_INSTRUMENTATION_OUTPUT, 'utf8')).toBe(
      renderInstrumentation(profile, EXTENSION_SOURCES).source,
    );
  });

  it('does not treat telemetry as a Nest module in the composition output', () => {
    const { source } = renderComposition(withOtel, EXTENSION_SOURCES);
    expect(source).not.toMatch(/from '[^']*opentelemetry|bootstrap/);
    expect(source).toContain('@Module({ imports: [], exports: [] })');
  });

  it('fails check mode when the instrumentation file is stale and repairs it in write mode', () => {
    const dir = tempDir();
    const outputPath = path.join(dir, 'instrumentation.generated.ts');
    try {
      const options = { profileSource: withOtel, extensions: [], outputPath };
      expect(
        thrownCode(() =>
          generateInstrumentationFile({ ...options, check: true }),
        ),
      ).toBe('GENERATED_STALE');
      generateInstrumentationFile({ ...options, check: false });
      expect(
        thrownCode(() =>
          generateInstrumentationFile({ ...options, check: true }),
        ),
      ).toBeUndefined();
      fs.appendFileSync(outputPath, '// edited by hand\n');
      expect(
        thrownCode(() =>
          generateInstrumentationFile({ ...options, check: true }),
        ),
      ).toBe('GENERATED_STALE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
