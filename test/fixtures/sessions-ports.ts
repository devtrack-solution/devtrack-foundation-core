import type {
  AccessTokenIssuer,
  AccessTokenVerifier,
  IdentityAccessResolver,
  PasswordCredentialsVerifier,
} from '../../src/core/application/security/authentication.ports';
import type { Principal } from '../../src/core/domain/security/identity';

/** Identidade de teste. Não representa conta real. */
export const SESSIONS_TEST_PRINCIPAL: Principal = {
  subjectId: 'subject-sessions-test',
  tenantId: 'tenant-sessions-test',
  permissions: ['contacts.read'],
};

export const passwordVerifierForTest: PasswordCredentialsVerifier = {
  verify: (credentials) =>
    Promise.resolve(
      credentials.password === 'sessions-test-only'
        ? { subjectId: SESSIONS_TEST_PRINCIPAL.subjectId }
        : null,
    ),
};

export const identitiesForTest: IdentityAccessResolver = {
  bySubject: (subjectId) =>
    Promise.resolve(
      subjectId === SESSIONS_TEST_PRINCIPAL.subjectId
        ? SESSIONS_TEST_PRINCIPAL
        : null,
    ),
  byExternalIdentity: () => Promise.resolve(null),
};

/** Token opaco de teste: codifica claims mínimas em base64url, sem JWT. */
interface AccessClaims {
  readonly s: string;
  readonly sid: string;
  readonly exp: number;
}

export const accessTokensForTest: AccessTokenIssuer & AccessTokenVerifier = {
  issue: ({ principal, session }) => {
    const expiresAt = Math.min(Date.now() + 600_000, session.expiresAt);
    const claims: AccessClaims = {
      s: principal.subjectId,
      sid: session.id,
      exp: expiresAt,
    };
    return Promise.resolve({
      value: Buffer.from(JSON.stringify(claims)).toString('base64url'),
      expiresAt,
    });
  },
  verify: (value) => {
    try {
      const claims = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as AccessClaims;
      return Promise.resolve({
        subjectId: claims.s,
        sessionId: claims.sid,
        expiresAt: claims.exp,
      });
    } catch {
      return Promise.resolve(null);
    }
  },
};
