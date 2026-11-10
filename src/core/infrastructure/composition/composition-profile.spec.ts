import fs from 'node:fs';
import path from 'node:path';
import { CompositionError } from '../../application/modules/composition-error';
import {
  CompositionProfileError,
  readCompositionProfile,
  resolveCompositionProfile,
} from './composition-profile';
import type {
  CompositionProfileErrorCode,
  ExtensionSource,
} from './composition-profile';

const INTEGRITY = 'sha512-ZmFrZS1pbnRlZ3JpdHktZm9yLXRlc3RzCg==';

const protectedDemo: ExtensionSource = {
  descriptor: {
    id: 'ext/protected-demo',
    foundationApiMajor: 1,
    origin: {
      kind: 'npm',
      packageName: 'fixture-protected-demo',
      version: '1.0.0',
      integrity: INTEGRITY,
    },
    provides: [],
    requires: [{ id: 'authenticator', major: 1 }],
  },
  exportName: 'ProtectedDemoModule',
};

/** Extensão que fornece `access-token`, papel que era do nativo jwt-auth. */
const tokenProvider: ExtensionSource = {
  descriptor: {
    id: 'ext/token-provider',
    foundationApiMajor: 1,
    origin: {
      kind: 'npm',
      packageName: 'fixture-token-provider',
      version: '1.0.0',
      integrity: INTEGRITY,
    },
    provides: [{ id: 'access-token', major: 1 }],
    requires: [],
  },
  exportName: 'TokenProviderModule',
};

const validExtension = `
extensions:
  - id: ext/protected-demo
    packageName: fixture-protected-demo
    version: 1.0.0
    integrity: ${INTEGRITY}
`;

function profileCode(
  source: string,
  extensions: ExtensionSource[] = [],
): string {
  try {
    resolveCompositionProfile(source, extensions);
  } catch (error) {
    if (
      error instanceof CompositionProfileError ||
      error instanceof CompositionError
    )
      return error.code;
    throw error;
  }
  return 'OK';
}

describe('composition profile reader', () => {
  it('reads the versioned default profile as a minimal host without extensions or JWT', () => {
    const file = path.resolve(__dirname, '../../../../config/composition.yaml');
    const profile = readCompositionProfile(fs.readFileSync(file, 'utf8'));
    expect(profile).toEqual({
      foundationApiMajor: 1,
      natives: [],
      extensions: [],
      bindings: [],
    });
    expect(
      resolveCompositionProfile(fs.readFileSync(file, 'utf8'), []).modules,
    ).toEqual([]);
  });

  it('reads natives with features and sorts entries deterministically', () => {
    const profile = readCompositionProfile(`
foundationApiMajor: 1
natives:
  - id: native/opentelemetry
  - id: native/http-security
    features: [b-feature, a-feature]
extensions: []
`);
    expect(profile.natives.map((n) => n.id)).toEqual([
      'native/http-security',
      'native/opentelemetry',
    ]);
    expect(profile.natives[0].features).toEqual(['a-feature', 'b-feature']);
  });

  const cases: [
    string,
    string,
    CompositionProfileErrorCode | 'UNKNOWN_FEATURE' | 'MISSING_PROVIDER',
  ][] = [
    ['malformed YAML', 'foundationApiMajor: [1', 'PROFILE_MALFORMED'],
    [
      'duplicate key',
      'foundationApiMajor: 1\nfoundationApiMajor: 1\nnatives: []\nextensions: []',
      'PROFILE_MALFORMED',
    ],
    [
      'YAML alias',
      'foundationApiMajor: 1\nnatives: &a []\nextensions: *a',
      'PROFILE_MALFORMED',
    ],
    [
      'unknown top-level field',
      'foundationApiMajor: 1\nnatives: []\nextensions: []\nhost: x',
      'PROFILE_UNKNOWN_FIELD',
    ],
    [
      'unknown native field',
      'foundationApiMajor: 1\nnatives:\n  - id: native/opentelemetry\n    version: 2\nextensions: []',
      'PROFILE_UNKNOWN_FIELD',
    ],
    [
      'missing foundationApiMajor',
      'natives: []\nextensions: []',
      'PROFILE_MISSING_FIELD',
    ],
    [
      'foundationApiMajor other than 1',
      'foundationApiMajor: 2\nnatives: []\nextensions: []',
      'PROFILE_INVALID_VALUE',
    ],
    [
      'missing natives list',
      'foundationApiMajor: 1\nextensions: []',
      'PROFILE_MISSING_FIELD',
    ],
    [
      'secret-named key at top level',
      'foundationApiMajor: 1\nnatives: []\nextensions: []\npassword: hunter2',
      'PROFILE_SECRET_FIELD',
    ],
    [
      'private key field on a native',
      'foundationApiMajor: 1\nnatives:\n  - id: native/opentelemetry\n    privateKey: abc\nextensions: []',
      'PROFILE_SECRET_FIELD',
    ],
    [
      'token field on an extension',
      `foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: ext/protected-demo\n    packageName: fixture-protected-demo\n    version: 1.0.0\n    integrity: ${INTEGRITY}\n    accessToken: abc`,
      'PROFILE_SECRET_FIELD',
    ],
    [
      'JWT-looking value',
      'foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: ext/protected-demo\n    packageName: eyJhbGciOi.abcdef.ghijkl\n    version: 1.0.0\n    integrity: ' +
        INTEGRITY,
      'PROFILE_SECRET_FIELD',
    ],
    [
      'PEM value',
      'foundationApiMajor: 1\nnatives: []\nextensions: []\nnote: "-----BEGIN PRIVATE KEY-----"',
      'PROFILE_SECRET_FIELD',
    ],
    [
      'unknown native',
      'foundationApiMajor: 1\nnatives:\n  - id: native/unknown\nextensions: []',
      'PROFILE_UNKNOWN_NATIVE',
    ],
    [
      'extension without integrity',
      `foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: ext/protected-demo\n    packageName: fixture-protected-demo\n    version: 1.0.0`,
      'PROFILE_MISSING_FIELD',
    ],
    [
      'extension with version range',
      `foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: ext/protected-demo\n    packageName: fixture-protected-demo\n    version: ^1.0.0\n    integrity: ${INTEGRITY}`,
      'PROFILE_INVALID_VALUE',
    ],
    [
      'extension with malformed integrity',
      `foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: ext/protected-demo\n    packageName: fixture-protected-demo\n    version: 1.0.0\n    integrity: md5-abc`,
      'PROFILE_INVALID_VALUE',
    ],
    [
      'invalid identifier',
      'foundationApiMajor: 1\nnatives:\n  - id: Native Bad\nextensions: []',
      'PROFILE_INVALID_VALUE',
    ],
    [
      'extension in native namespace',
      `foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: native/fake\n    packageName: fixture-protected-demo\n    version: 1.0.0\n    integrity: ${INTEGRITY}`,
      'PROFILE_INVALID_VALUE',
    ],
    [
      'duplicate module entry',
      'foundationApiMajor: 1\nnatives:\n  - id: native/opentelemetry\n  - id: native/opentelemetry\nextensions: []',
      'PROFILE_DUPLICATE_ENTRY',
    ],
    [
      'duplicate feature',
      'foundationApiMajor: 1\nnatives:\n  - id: native/opentelemetry\n    features: [x, x]\nextensions: []',
      'PROFILE_DUPLICATE_ENTRY',
    ],
    [
      'duplicate binding',
      'foundationApiMajor: 1\nnatives:\n  - id: native/aws-s3\n  - id: native/http-security\nextensions: []\nbindings:\n  - consumer: native/http-security\n    capability: access-token\n    provider: native/aws-s3\n  - consumer: native/http-security\n    capability: access-token\n    provider: native/aws-s3',
      'PROFILE_DUPLICATE_ENTRY',
    ],
    [
      'unknown feature',
      'foundationApiMajor: 1\nnatives:\n  - id: native/opentelemetry\n    features: [turbo]\nextensions: []',
      'UNKNOWN_FEATURE',
    ],
    [
      'extension not in registry',
      `foundationApiMajor: 1\nnatives: []\n${validExtension}`,
      'PROFILE_UNKNOWN_EXTENSION',
    ],
    [
      'extension integrity differs from registry',
      `foundationApiMajor: 1\nnatives: []\nextensions:\n  - id: ext/protected-demo\n    packageName: fixture-protected-demo\n    version: 1.0.0\n    integrity: sha512-b3RoZXItaW50ZWdyaXR5Cg==`,
      'PROFILE_EXTENSION_MISMATCH',
    ],
  ];

  for (const [name, source, code] of cases) {
    it(`rejects ${name} with a stable code`, () => {
      const extensions =
        code === 'PROFILE_UNKNOWN_EXTENSION' ? [] : [protectedDemo];
      expect(profileCode(source, extensions)).toBe(code);
    });
  }

  it('rejects JWT selected without the @devtrack/jwt-auth package and names the package', () => {
    const profile = `foundationApiMajor: 1
natives:
  - id: native/http-security
extensions:
  - id: ext/jwt-auth
    packageName: '@devtrack/jwt-auth'
    version: 0.1.0
    integrity: ${INTEGRITY}
`;
    expect(() => resolveCompositionProfile(profile, [])).toThrow(
      /Unknown extension ext\/jwt-auth: install @devtrack\/jwt-auth@0\.1\.0/,
    );
    expect(profileCode(profile)).toBe('PROFILE_UNKNOWN_EXTENSION');
  });

  it('rejects the former native/jwt-auth id with a stable code that names it', () => {
    const profile =
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\nextensions: []';
    expect(profileCode(profile)).toBe('PROFILE_UNKNOWN_NATIVE');
    expect(() => resolveCompositionProfile(profile, [])).toThrow(
      /native\/jwt-auth/,
    );
  });

  it('rejects Swagger selected without @devtrack/swagger-adapter and the former native id', () => {
    const missingPackage = `foundationApiMajor: 1
natives: []
extensions:
  - id: ext/swagger-adapter
    packageName: '@devtrack/swagger-adapter'
    version: 0.1.0
    integrity: ${INTEGRITY}
`;
    expect(() => resolveCompositionProfile(missingPackage, [])).toThrow(
      /install @devtrack\/swagger-adapter@0\.1\.0/,
    );
    expect(
      profileCode(
        'foundationApiMajor: 1\nnatives:\n  - id: native/swagger-adapter\nextensions: []',
      ),
    ).toBe('PROFILE_UNKNOWN_NATIVE');
  });

  it('does not expose profile values in the error message', () => {
    const secret = 'eyJhbGciOi.abcdef.ghijkl';
    try {
      readCompositionProfile(
        `foundationApiMajor: 1\nnatives: []\nextensions: []\nnote: ${secret}`,
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionProfileError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('rejects a protected extension when no authenticator is selected', () => {
    expect(
      profileCode(`foundationApiMajor: 1\nnatives: []\n${validExtension}`, [
        protectedDemo,
      ]),
    ).toBe('MISSING_PROVIDER');
  });

  it('resolves a protected extension when http-security and an access-token extension are selected', () => {
    const resolved = resolveCompositionProfile(
      `foundationApiMajor: 1
natives:
  - id: native/http-security
${validExtension}  - id: ext/token-provider
    packageName: fixture-token-provider
    version: 1.0.0
    integrity: ${INTEGRITY}
`,
      [protectedDemo, tokenProvider],
    );
    expect(resolved.orderedModuleIds).toEqual([
      'ext/token-provider',
      'native/http-security',
      'ext/protected-demo',
    ]);
    expect(resolved.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumerId: 'native/http-security',
          capabilityId: 'access-token',
          providerId: 'ext/token-provider',
        }),
        expect.objectContaining({
          consumerId: 'ext/protected-demo',
          capabilityId: 'authenticator',
          providerId: 'native/http-security',
        }),
      ]),
    );
  });
});
