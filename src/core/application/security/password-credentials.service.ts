import type {
  PasswordCredentials,
  PasswordCredentialsVerifier,
  PasswordCredentialStore,
  PasswordHashVerifier,
} from './authentication.ports';

export class PasswordCredentialsService implements PasswordCredentialsVerifier {
  constructor(
    private readonly store: PasswordCredentialStore,
    private readonly hashes: PasswordHashVerifier,
    /** Valid hash with production algorithm/cost, provisioned by the adapter. */
    private readonly dummyPasswordHash: string,
  ) {
    if (!dummyPasswordHash) throw new Error('Dummy password hash is required');
  }

  async verify(credentials: PasswordCredentials) {
    const { username, password } = credentials;
    // Bounds protect adapters from unbounded input. Do not trim passwords.
    if (
      !username ||
      username.length > 256 ||
      !password ||
      password.length > 4096
    )
      return null;
    const record = await this.store.findByUsername(username);
    const valid = await this.hashes.verify(
      password,
      record?.passwordHash ?? this.dummyPasswordHash,
    );
    // Dummy hashing reduces enumeration; it does not ensure equal timing.
    return valid && record ? { subjectId: record.subjectId } : null;
  }
}
