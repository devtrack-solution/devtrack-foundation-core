import type {
  AuthenticationMethod,
  ExternalIdentity,
  Principal,
} from '../../domain/security/identity';
import type {
  SessionReference,
  SessionState,
} from '../../domain/sessions/session';

export interface PasswordCredentials {
  readonly username: string;
  readonly password: string;
}
export interface PasswordCredentialRecord {
  readonly subjectId: string;
  readonly passwordHash: string;
}
export interface PasswordCredentialStore {
  /** Owns username canonicalization/uniqueness. Never returns plaintext. */
  findByUsername(username: string): Promise<PasswordCredentialRecord | null>;
}
export interface PasswordHashVerifier {
  /** Maintained password-hashing library, never plain equality. */
  verify(password: string, encodedHash: string): Promise<boolean>;
}
export interface PasswordCredentialsVerifier {
  verify(
    credentials: PasswordCredentials,
  ): Promise<{ subjectId: string } | null>;
}
export interface FederatedLoginStart {
  /** Configuration key, not a user-supplied redirect URL. */
  readonly redirectId: string;
  /** Established by trusted transport; never a field copied from the body. */
  readonly clientBinding: string;
}
export interface FederatedLoginChallenge {
  readonly authorizationUrl: string;
  readonly expiresAt: number;
}
export interface FederatedLoginCallback {
  readonly code: string;
  readonly state: string;
  readonly clientBinding: string;
}
export interface FederatedIdentityProvider {
  readonly id: string;
  /** Stores expiring state/nonce/PKCE server-side, bound to this client. */
  begin(input: FederatedLoginStart): Promise<FederatedLoginChallenge>;
  /**
   * Atomically consumes the bound attempt and validates protocol/issuer/audience/
   * signature/expiry. Rejects replay. Raw profiles/emails are not proof of identity.
   */
  complete(
    callback: FederatedLoginCallback,
  ): Promise<Omit<ExternalIdentity, 'providerId'> | null>;
}
export interface IdentityAccessResolver {
  /** Null for blocked, missing or unauthorized identity. */
  bySubject(subjectId: string): Promise<Principal | null>;
  /** Exact explicit link. Never creates an account or matches by email. */
  byExternalIdentity(identity: ExternalIdentity): Promise<Principal | null>;
}
export interface AuthenticationSessions {
  /** Pending sessions are unusable by guards and expire after process crash. */
  createPending(
    principal: Principal,
    method: AuthenticationMethod,
  ): Promise<SessionReference>;
  /** Atomic pending -> active; rejects expired/revoked state. */
  activate(sessionId: string): Promise<void>;
  /** Idempotent. Adapter owns recovery if storage is unavailable. */
  revoke(sessionId: string): Promise<void>;
}
export interface IssuedAccessToken {
  readonly value: string;
  readonly expiresAt: number;
}
export interface AccessTokenIssuer {
  /** Format private to adapter; expiry cannot exceed session expiry. */
  issue(input: {
    readonly principal: Principal;
    readonly session: SessionReference;
    readonly method: AuthenticationMethod;
  }): Promise<IssuedAccessToken>;
}
export interface AccessTokenVerifier {
  /** Checks token proof/expiry. Caller must still check active session and access. */
  verify(value: string): Promise<{
    readonly subjectId: string;
    readonly sessionId: string;
    readonly expiresAt: number;
  } | null>;
}
export interface AuthenticationResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresAt: number;
  readonly sessionId: string;
  readonly subjectId: string;
}
export interface Clock {
  now(): number;
}

/**
 * Geração e digest de refresh tokens. Application não conhece node:crypto:
 * o adapter fornece 256 bits aleatórios opacos e SHA-256 determinístico.
 */
export interface RefreshTokenSecrets {
  /** Opaque value with at least 256 random bits. Never a JWT. */
  generate(): string;
  /** Deterministic SHA-256 digest (hex). Only digests are persisted. */
  digest(value: string): string;
}
export type RefreshTokenStateValue = 'active' | 'consumed' | 'revoked';
/** Estado lido sob o lock atômico do store. Não contém valores de refresh. */
export interface RefreshRotationSnapshot {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly method: AuthenticationMethod;
  readonly sessionState: SessionState;
  readonly sessionExpiresAt: number;
  readonly refreshState: RefreshTokenStateValue;
  readonly clientBindingDigest: string;
  readonly consumedAt: number | null;
  readonly idleExpiresAt: number;
  /** State of the successor named by the presented token, if any. */
  readonly successorState: RefreshTokenStateValue | null;
}
export type RefreshRotationDecision =
  | {
      readonly kind: 'rotate';
      readonly successorDigest: string;
      readonly successorIdleExpiresAt: number;
    }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'reuse' };
export interface RefreshRotationRequest {
  readonly presentedDigest: string;
  readonly now: number;
  /** Pure and synchronous: runs while the store holds its atomic lock. */
  decide(snapshot: RefreshRotationSnapshot | null): RefreshRotationDecision;
}
export interface RefreshRotationResult {
  /** Decision that the store applied. */
  readonly decision: RefreshRotationDecision;
  readonly snapshot: RefreshRotationSnapshot | null;
}
export interface NewRefreshToken {
  readonly sessionId: string;
  readonly digest: string;
  readonly clientBindingDigest: string;
  readonly idleExpiresAt: number;
  readonly now: number;
}
/**
 * Store de refresh com operações atômicas. `rotate` lê, decide e aplica em uma
 * única unidade: CAS `active -> consumed` e criação de exatamente um sucessor
 * para a decisão `rotate`; `revoke` de toda a família para `reuse`.
 */
export interface RefreshTokenStore {
  issue(input: NewRefreshToken): Promise<void>;
  rotate(request: RefreshRotationRequest): Promise<RefreshRotationResult>;
  /** Idempotent. Revokes every active refresh token of the session. */
  revokeFamily(sessionId: string): Promise<void>;
}
/** Resultado de login/renovação quando o store de refresh está composto. */
export interface RefreshGrant {
  readonly refreshToken: string;
  readonly refreshExpiresAt: number;
}
