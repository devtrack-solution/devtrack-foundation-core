import {
  NATIVE_MODULE_DESCRIPTORS,
  findNativeDescriptor,
} from './native-catalog';
import { resolveComposition } from './resolve-composition';
import { CompositionError } from './composition-error';

describe('native catalog', () => {
  it('has no native access-token provider: JWT Auth is the official npm module ext/jwt-auth', () => {
    expect(findNativeDescriptor('native/jwt-auth')).toBeUndefined();
    expect(
      NATIVE_MODULE_DESCRIPTORS.some((descriptor) =>
        descriptor.provides.some((cap) => cap.id === 'access-token'),
      ),
    ).toBe(false);
  });

  it('declares http-security as the explicit authenticator and requires access-token', () => {
    expect(findNativeDescriptor('native/http-security')).toMatchObject({
      provides: expect.arrayContaining([
        { id: 'authenticator', major: 1 },
      ]) as unknown,
      requires: [{ id: 'access-token', major: 1 }],
    });
  });

  it('keeps every descriptor on the current Foundation API major', () => {
    expect(
      NATIVE_MODULE_DESCRIPTORS.every((d) => d.foundationApiMajor === 1),
    ).toBe(true);
  });

  it('does not resolve http-security without an access-token provider', () => {
    const security = findNativeDescriptor('native/http-security');
    expect(security).toBeDefined();
    let error: unknown;
    try {
      resolveComposition({ modules: [{ descriptor: security! }] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompositionError);
    expect((error as CompositionError).code).toBe('MISSING_PROVIDER');
  });
});
