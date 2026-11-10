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

const withSecurity = `foundationApiMajor: 1
natives:
  - id: native/http-security
  - id: native/jwt-auth
extensions:
  - id: ext/protected-demo
    packageName: fixture-protected-demo
    version: 1.0.0
    integrity: ${INTEGRITY}
`;

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

  it('keeps swagger out of the default output and only imports it when selected', () => {
    const profile = fs.readFileSync(PROFILE_FILE, 'utf8');
    expect(renderComposition(profile, EXTENSION_SOURCES).source).not.toMatch(
      /swagger/i,
    );
    const selected = `foundationApiMajor: 1
natives:
  - id: native/swagger-adapter
extensions: []
`;
    const { source } = renderComposition(selected, EXTENSION_SOURCES);
    expect(source).toContain(`from '../native/swagger-adapter'`);
    expect(source).toContain('SwaggerAdapterModule.registerAsync');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.swaggerOptions');
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

  it('resolves the protected extension with http-security and jwt-auth and imports them statically', () => {
    const { source, resolved } = renderComposition(withSecurity, [
      protectedDemo,
    ]);
    expect(resolved.orderedModuleIds).toEqual([
      'native/jwt-auth',
      'native/http-security',
      'ext/protected-demo',
    ]);
    expect(source).toContain(`from '../native/jwt-auth'`);
    expect(source).toContain(
      `from '../core/infrastructure/modules/foundation-core.module'`,
    );
    expect(source).toContain(`from 'fixture-protected-demo'`);
    expect(source).toContain('FoundationCoreModule.withHttpSecurity');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.jwtAuthOptions');
    expect(source).toContain('COMPOSITION_HOST_TOKENS.sessions');
    expect(source).not.toMatch(/import\(|require\(/);
  });

  it('imports only the selected natives', () => {
    const jwtOnly = `foundationApiMajor: 1
natives:
  - id: native/jwt-auth
extensions:
  - id: ext/plain-demo
    packageName: fixture-plain-demo
    version: 1.0.0
    integrity: ${INTEGRITY}
`;
    const { source } = renderComposition(jwtOnly, [plainDemo]);
    expect(source).toContain(`from '../native/jwt-auth'`);
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
    provider: native/jwt-auth
extensions:
  - id: ext/protected-demo
    integrity: ${INTEGRITY}
    version: 1.0.0
    packageName: fixture-protected-demo
natives:
  - id: native/jwt-auth
  - id: native/http-security
`;
    const first = renderComposition(withSecurity, [protectedDemo]);
    const second = renderComposition(reordered, [protectedDemo]);
    expect(second.source).toBe(first.source);
  });

  it('fails the check mode when the generated file is stale and repairs it in write mode', () => {
    const dir = tempDir();
    const outputPath = path.join(dir, 'composition.generated.ts');
    try {
      const options = {
        profileSource: withSecurity,
        extensions: [protectedDemo],
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
