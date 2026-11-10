import type {
  AuthenticationMethod,
  Principal,
} from '../../domain/security/identity';
import type { AuditWriter } from '../audit/audit-writer.port';
import { createAuditContext } from '../audit/audit-context';
import type {
  AccessTokenIssuer,
  AuthenticationResult,
  AuthenticationSessions,
  Clock,
  FederatedIdentityProvider,
  FederatedLoginCallback,
  FederatedLoginChallenge,
  FederatedLoginStart,
  IdentityAccessResolver,
  PasswordCredentials,
  PasswordCredentialsVerifier,
  RefreshGrant,
  RefreshRotationDecision,
  RefreshRotationSnapshot,
  RefreshTokenSecrets,
  RefreshTokenStore,
} from './authentication.ports';
import { decideRotation } from './refresh-rotation.policy';

export type AuthenticationErrorCode =
  'invalid_credentials' | 'authentication_unavailable' | 'refresh_conflict';

export class AuthenticationError extends Error {
  constructor(readonly code: AuthenticationErrorCode) {
    super(code);
    this.name = 'AuthenticationError';
  }
}

/** Renovação opcional. Sem ela, login e refresh mantêm o contrato anterior. */
export interface RefreshOptions {
  readonly store: RefreshTokenStore;
  readonly secrets: RefreshTokenSecrets;
  /** Ociosidade do refresh. Padrão 7 dias. */
  readonly idleTtlMs?: number;
  /** Janela de graça (0 a 30 s). Padrão 10 s. */
  readonly graceWindowMs?: number;
}

/** Auditoria opcional. Falha do writer falha fechado (sem token). */
export interface AuthenticationAuditOptions {
  readonly writer: AuditWriter;
  /** Identificador único de cada entrada de auditoria. */
  readonly newEntryId: () => string;
}

export interface AuthenticationDependencies {
  readonly password?: PasswordCredentialsVerifier;
  readonly federation?: readonly FederatedIdentityProvider[];
  readonly identities: IdentityAccessResolver;
  readonly sessions: AuthenticationSessions;
  readonly tokens: AccessTokenIssuer;
  readonly clock: Clock;
  readonly refresh?: RefreshOptions;
  readonly audit?: AuthenticationAuditOptions;
}

/** Contexto confiável do chamador, usado somente para auditoria. */
export interface AuthenticationActor {
  readonly subjectId: string;
  readonly correlationId: string;
}

export interface RefreshInput {
  /** Opaque value received from login or a previous refresh. */
  readonly refreshToken: string;
  /** Established by trusted transport; never copied from the body. */
  readonly clientBinding: string;
  readonly correlationId?: string;
}

/** Login opcional com refresh: o binding é obrigatório quando o store existe. */
export interface PasswordLoginContext {
  readonly clientBinding: string;
}

const DEFAULT_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_WINDOW_MS = 10_000;
const MAX_GRACE_WINDOW_MS = 30_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Pure application orchestration. Nest supplies ports at composition. */
export class AuthenticationService {
  private readonly federation = new Map<string, FederatedIdentityProvider>();
  private readonly refreshPolicy: {
    readonly store: RefreshTokenStore;
    readonly secrets: RefreshTokenSecrets;
    readonly idleTtlMs: number;
    readonly graceWindowMs: number;
  } | null;

  constructor(private readonly ports: AuthenticationDependencies) {
    for (const provider of ports.federation ?? []) {
      if (!provider.id || this.federation.has(provider.id))
        throw new Error('Invalid or duplicate federation provider');
      this.federation.set(provider.id, provider);
    }
    if (ports.refresh) {
      const idleTtlMs = ports.refresh.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
      const graceWindowMs =
        ports.refresh.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
      if (
        !Number.isSafeInteger(idleTtlMs) ||
        idleTtlMs <= 0 ||
        !Number.isSafeInteger(graceWindowMs) ||
        graceWindowMs < 0 ||
        graceWindowMs > MAX_GRACE_WINDOW_MS
      )
        throw new Error('Invalid refresh policy');
      this.refreshPolicy = {
        store: ports.refresh.store,
        secrets: ports.refresh.secrets,
        idleTtlMs,
        graceWindowMs,
      };
    } else {
      this.refreshPolicy = null;
    }
  }

  loginWithPassword(
    input: PasswordCredentials,
    context?: PasswordLoginContext,
  ): Promise<AuthenticationResult & Partial<RefreshGrant>> {
    return this.protect(async () => {
      const identity = await this.ports.password?.verify(input);
      if (!identity) throw new AuthenticationError('invalid_credentials');
      const principal = await this.ports.identities.bySubject(
        identity.subjectId,
      );
      if (principal && principal.subjectId !== identity.subjectId)
        throw new AuthenticationError('authentication_unavailable');
      return this.establishSession(
        principal,
        { kind: 'password' },
        context?.clientBinding,
      );
    });
  }

  beginFederatedLogin(
    providerId: string,
    input: FederatedLoginStart,
  ): Promise<FederatedLoginChallenge> {
    return this.protect(async () => {
      if (!input.redirectId || !input.clientBinding)
        throw new AuthenticationError('invalid_credentials');
      const challenge = await this.provider(providerId).begin(input);
      return {
        authorizationUrl: challenge.authorizationUrl,
        expiresAt: challenge.expiresAt,
      };
    });
  }

  completeFederatedLogin(
    providerId: string,
    input: FederatedLoginCallback,
  ): Promise<AuthenticationResult & Partial<RefreshGrant>> {
    return this.protect(async () => {
      if (!input.code || !input.state || !input.clientBinding)
        throw new AuthenticationError('invalid_credentials');
      const identity = await this.provider(providerId).complete(input);
      if (!identity?.issuer || !identity.subject)
        throw new AuthenticationError('invalid_credentials');
      const principal = await this.ports.identities.byExternalIdentity({
        providerId,
        issuer: identity.issuer,
        subject: identity.subject,
      });
      return this.establishSession(
        principal,
        {
          kind: 'federated',
          providerId,
        },
        input.clientBinding,
      );
    });
  }

  /**
   * Rotaciona o refresh (D2): um único sucessor ativo por uso válido. Conflito
   * dentro da janela de graça não cria sucessor; reuso revoga a sessão inteira.
   */
  refresh(input: RefreshInput): Promise<AuthenticationResult & RefreshGrant> {
    return this.protect(async () => {
      const policy = this.refreshPolicy;
      if (!policy) throw new AuthenticationError('authentication_unavailable');
      if (
        !isNonEmptyString(input.refreshToken) ||
        !isNonEmptyString(input.clientBinding)
      )
        throw new AuthenticationError('invalid_credentials');

      const now = this.ports.clock.now();
      if (!Number.isSafeInteger(now))
        throw new AuthenticationError('authentication_unavailable');
      const successorValue = policy.secrets.generate();
      const successorDigest = policy.secrets.digest(successorValue);
      const bindingDigest = policy.secrets.digest(input.clientBinding);

      const result = await policy.store.rotate({
        presentedDigest: policy.secrets.digest(input.refreshToken),
        now,
        decide: (snapshot: RefreshRotationSnapshot | null) =>
          decideRotation(snapshot, {
            now,
            bindingDigest,
            successorDigest,
            graceWindowMs: policy.graceWindowMs,
            idleTtlMs: policy.idleTtlMs,
          }),
      });
      const { decision, snapshot } = result;

      if (decision.kind === 'conflict' && snapshot) {
        await this.audit(
          input.correlationId,
          snapshot.subjectId,
          'session.refresh_conflict',
          snapshot.sessionId,
          'denied',
        );
        throw new AuthenticationError('refresh_conflict');
      }
      if (decision.kind === 'reuse' && snapshot) {
        await this.audit(
          input.correlationId,
          snapshot.subjectId,
          'session.refresh_reuse_revoked',
          snapshot.sessionId,
          'denied',
        );
        throw new AuthenticationError('invalid_credentials');
      }
      if (decision.kind !== 'rotate' || snapshot === null)
        throw new AuthenticationError('invalid_credentials');

      return this.issueRotated(
        snapshot,
        decision,
        successorValue,
        now,
        input.correlationId,
      );
    });
  }

  /**
   * Revoga a sessão e todos os seus refresh tokens. Idempotente. Auditoria só
   * é registrada quando o chamador informa o ator confiável.
   */
  revokeSession(sessionId: string, actor?: AuthenticationActor): Promise<void> {
    return this.protect(async () => {
      if (!isNonEmptyString(sessionId))
        throw new AuthenticationError('invalid_credentials');
      await this.ports.sessions.revoke(sessionId);
      if (this.refreshPolicy)
        await this.refreshPolicy.store.revokeFamily(sessionId);
      if (actor)
        await this.audit(
          actor.correlationId,
          actor.subjectId,
          'session.revoked',
          sessionId,
          'succeeded',
        );
    });
  }

  private provider(id: string): FederatedIdentityProvider {
    const provider = this.federation.get(id);
    if (!provider) throw new AuthenticationError('invalid_credentials');
    return provider;
  }

  private async establishSession(
    principal: Principal | null,
    method: AuthenticationMethod,
    clientBinding?: string,
  ): Promise<AuthenticationResult & Partial<RefreshGrant>> {
    if (!principal?.subjectId)
      throw new AuthenticationError('invalid_credentials');
    if (this.refreshPolicy && !isNonEmptyString(clientBinding))
      throw new AuthenticationError('invalid_credentials');
    const session = await this.ports.sessions.createPending(principal, method);
    try {
      if (
        !session.id ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt <= this.ports.clock.now()
      )
        throw new AuthenticationError('authentication_unavailable');
      const token = await this.ports.tokens.issue({
        principal,
        session,
        method,
      });
      if (
        !token.value ||
        !Number.isSafeInteger(token.expiresAt) ||
        token.expiresAt <= this.ports.clock.now() ||
        token.expiresAt > session.expiresAt
      )
        throw new AuthenticationError('authentication_unavailable');
      const refresh =
        this.refreshPolicy && clientBinding
          ? await this.issueInitialRefresh(
              session.id,
              session.expiresAt,
              clientBinding,
            )
          : null;
      await this.ports.sessions.activate(session.id);
      if (token.expiresAt <= this.ports.clock.now())
        throw new AuthenticationError('authentication_unavailable');
      return {
        accessToken: token.value,
        tokenType: 'Bearer',
        expiresAt: token.expiresAt,
        sessionId: session.id,
        subjectId: principal.subjectId,
        ...(refresh ?? {}),
      };
    } catch {
      // Never return token after failure. Expiry handles pending-session crashes;
      // durable recovery/diagnostics belong to the session adapter.
      if (session.id) await this.compensate(session.id);
      throw new AuthenticationError('authentication_unavailable');
    }
  }

  private async issueInitialRefresh(
    sessionId: string,
    sessionExpiresAt: number,
    clientBinding: string,
  ): Promise<RefreshGrant> {
    const policy = this.refreshPolicy;
    if (!policy) throw new AuthenticationError('authentication_unavailable');
    const now = this.ports.clock.now();
    const refreshValue = policy.secrets.generate();
    const idleExpiresAt = Math.min(now + policy.idleTtlMs, sessionExpiresAt);
    if (idleExpiresAt <= now)
      throw new AuthenticationError('authentication_unavailable');
    await policy.store.issue({
      sessionId,
      digest: policy.secrets.digest(refreshValue),
      clientBindingDigest: policy.secrets.digest(clientBinding),
      idleExpiresAt,
      now,
    });
    return { refreshToken: refreshValue, refreshExpiresAt: idleExpiresAt };
  }

  private async issueRotated(
    snapshot: RefreshRotationSnapshot,
    decision: Extract<RefreshRotationDecision, { kind: 'rotate' }>,
    successorValue: string,
    now: number,
    correlationId: string | undefined,
  ): Promise<AuthenticationResult & RefreshGrant> {
    const session = {
      id: snapshot.sessionId,
      expiresAt: snapshot.sessionExpiresAt,
    };
    try {
      const principal = await this.ports.identities.bySubject(
        snapshot.subjectId,
      );
      if (!principal?.subjectId || principal.subjectId !== snapshot.subjectId)
        throw new AuthenticationError('invalid_credentials');
      const token = await this.ports.tokens.issue({
        principal,
        session,
        method: snapshot.method,
      });
      if (
        !token.value ||
        !Number.isSafeInteger(token.expiresAt) ||
        token.expiresAt <= now ||
        token.expiresAt > session.expiresAt
      )
        throw new AuthenticationError('authentication_unavailable');
      await this.audit(
        correlationId,
        snapshot.subjectId,
        'session.refresh_rotated',
        snapshot.sessionId,
        'succeeded',
      );
      return {
        accessToken: token.value,
        tokenType: 'Bearer',
        expiresAt: token.expiresAt,
        sessionId: snapshot.sessionId,
        subjectId: snapshot.subjectId,
        refreshToken: successorValue,
        refreshExpiresAt: decision.successorIdleExpiresAt,
      };
    } catch (error) {
      await this.compensate(session.id);
      if (
        error instanceof AuthenticationError &&
        error.code === 'invalid_credentials'
      )
        throw error;
      throw new AuthenticationError('authentication_unavailable');
    }
  }

  /** Revoga sessão e família após falha; erros de compensação são ignorados. */
  private async compensate(sessionId: string): Promise<void> {
    try {
      await this.ports.sessions.revoke(sessionId);
    } catch {
      /* fail closed */
    }
    if (this.refreshPolicy) {
      try {
        await this.refreshPolicy.store.revokeFamily(sessionId);
      } catch {
        /* fail closed */
      }
    }
  }

  private async audit(
    correlationId: string | undefined,
    subjectId: string,
    action: string,
    sessionId: string,
    outcome: 'succeeded' | 'denied',
  ): Promise<void> {
    const audit = this.ports.audit;
    if (!audit) return;
    await audit.writer.append({
      id: audit.newEntryId(),
      occurredAt: this.ports.clock.now(),
      context: createAuditContext({
        correlationId: correlationId ?? `session:${sessionId}`,
        principal: { subjectId, permissions: [] },
        deadlineAt: 0,
      }),
      action,
      target: sessionId,
      outcome,
    });
  }

  private async protect<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      // Provider exceptions may contain secrets. Do not propagate them.
      throw new AuthenticationError('authentication_unavailable');
    }
  }
}
