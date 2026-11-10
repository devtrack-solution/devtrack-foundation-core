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
  - id: native/jwt-auth
  - id: native/http-security
    features: [b-feature, a-feature]
extensions: []
`);
    expect(profile.natives.map((n) => n.id)).toEqual([
      'native/http-security',
      'native/jwt-auth',
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
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\n    version: 2\nextensions: []',
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
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\n    privateKey: abc\nextensions: []',
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
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\n  - id: native/jwt-auth\nextensions: []',
      'PROFILE_DUPLICATE_ENTRY',
    ],
    [
      'duplicate feature',
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\n    features: [x, x]\nextensions: []',
      'PROFILE_DUPLICATE_ENTRY',
    ],
    [
      'duplicate binding',
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\n  - id: native/http-security\nextensions: []\nbindings:\n  - consumer: native/http-security\n    capability: access-token\n    provider: native/jwt-auth\n  - consumer: native/http-security\n    capability: access-token\n    provider: native/jwt-auth',
      'PROFILE_DUPLICATE_ENTRY',
    ],
    [
      'unknown feature',
      'foundationApiMajor: 1\nnatives:\n  - id: native/jwt-auth\n    features: [turbo]\nextensions: []',
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

  it('resolves a protected extension when http-security and jwt-auth are selected', () => {
    const resolved = resolveCompositionProfile(
      `foundationApiMajor: 1
natives:
  - id: native/http-security
  - id: native/jwt-auth
${validExtension}`,
      [protectedDemo],
    );
    expect(resolved.orderedModuleIds).toEqual([
      'native/jwt-auth',
      'native/http-security',
      'ext/protected-demo',
    ]);
    expect(resolved.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumerId: 'native/http-security',
          capabilityId: 'access-token',
          providerId: 'native/jwt-auth',
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
