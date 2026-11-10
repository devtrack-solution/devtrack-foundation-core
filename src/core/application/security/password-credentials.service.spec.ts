/* eslint-disable @typescript-eslint/unbound-method -- Jest inspects mock methods without invoking unbound methods. */
import { PasswordCredentialsService } from './password-credentials.service';
import type {
  PasswordCredentialStore,
  PasswordHashVerifier,
} from './authentication.ports';
function fixture() {
  const store: jest.Mocked<PasswordCredentialStore> = {
    findByUsername: jest.fn().mockResolvedValue({
      subjectId: 'user-id',
      passwordHash: 'stored-encoded-hash',
    }),
  };
  const hashes: jest.Mocked<PasswordHashVerifier> = {
    verify: jest.fn().mockResolvedValue(true),
  };
  return {
    store,
    hashes,
    service: new PasswordCredentialsService(
      store,
      hashes,
      'dummy-encoded-hash',
    ),
  };
}
describe('PasswordCredentialsService', () => {
  it('verifies the hash without trimming or normalizing the password', async () => {
    const f = fixture();
    await expect(
      f.service.verify({ username: 'User', password: ' padded password ' }),
    ).resolves.toEqual({ subjectId: 'user-id' });
    expect(f.store.findByUsername).toHaveBeenCalledWith('User');
    expect(f.hashes.verify).toHaveBeenCalledWith(
      ' padded password ',
      'stored-encoded-hash',
    );
  });
  it('performs dummy verification for unknown user, denying even if it matches', async () => {
    const f = fixture();
    f.store.findByUsername.mockResolvedValue(null);
    await expect(
      f.service.verify({ username: 'missing', password: 'secret' }),
    ).resolves.toBeNull();
    expect(f.hashes.verify).toHaveBeenCalledWith(
      'secret',
      'dummy-encoded-hash',
    );
  });
  it('rejects a mismatching password', async () => {
    const f = fixture();
    f.hashes.verify.mockResolvedValue(false);
    await expect(
      f.service.verify({ username: 'user', password: 'wrong' }),
    ).resolves.toBeNull();
  });
  it.each([
    { username: '', password: 'a' },
    { username: 'a', password: '' },
    { username: 'a'.repeat(257), password: 'b' },
    { username: 'a', password: 'b'.repeat(4097) },
  ])('rejects empty or unbounded inputs', async (input) => {
    const f = fixture();
    await expect(f.service.verify(input)).resolves.toBeNull();
    expect(f.store.findByUsername).not.toHaveBeenCalled();
    expect(f.hashes.verify).not.toHaveBeenCalled();
  });
  it('requires an adapter-provisioned dummy hash', () => {
    const f = fixture();
    expect(() => new PasswordCredentialsService(f.store, f.hashes, '')).toThrow(
      'required',
    );
  });
});
