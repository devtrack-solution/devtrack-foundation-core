import type { Principal } from '../../domain/security/identity';
import type { OperationContext } from '../context/operation-context';
import type { SessionReader } from '../sessions/session-reader.port';
import type {
  AccessTokenVerifier,
  Clock,
  IdentityAccessResolver,
} from './authentication.ports';
import { AuthenticationError } from './authentication.service';

/** Negação de permissão. Não distingue o motivo além da ausência de permissão. */
export class AuthorizationError extends Error {
  readonly code = 'permission_denied';

  constructor() {
    super('permission_denied');
    this.name = 'AuthorizationError';
  }
}

export interface OperationAuthorizationDependencies {
  readonly tokens: AccessTokenVerifier;
  readonly sessions: SessionReader;
  readonly identities: IdentityAccessResolver;
  readonly clock: Clock;
}

export interface OperationAuthorizationRequest {
  /** Undefined when the transport did not present a bearer token. */
  readonly bearerToken: string | undefined;
  readonly correlationId: string;
  readonly requiredPermissions: readonly string[];
}

/** Stable across compatible copies of the public contracts package. */
export const OPERATION_AUTHORIZER = Symbol.for(
  'foundation.api.v1.operation-authorizer',
);

const SESSION_STATES: readonly string[] = [
  'pending',
  'active',
  'revoked',
  'expired',
];

function unavailable(): AuthenticationError {
  return new AuthenticationError('authentication_unavailable');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Autoriza uma operação a partir de um token bearer. Falha fechada: qualquer
 * exceção ou resposta malformada de porta vira authentication_unavailable.
 * A autorização vem do resolver atual, nunca do token ou de headers.
 */
export class OperationAuthorizer {
  constructor(
    private readonly ports: OperationAuthorizationDependencies,
    private readonly timeoutMs: number,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error('Invalid operation timeout');
  }

  async authorize(
    request: OperationAuthorizationRequest,
  ): Promise<OperationContext> {
    try {
      return await this.evaluate(request);
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof AuthorizationError
      )
        throw error;
      throw unavailable();
    }
  }

  private async evaluate(
    request: OperationAuthorizationRequest,
  ): Promise<OperationContext> {
    const denied = (): AuthenticationError =>
      new AuthenticationError('invalid_credentials');

    if (!isNonEmptyString(request.bearerToken)) throw denied();
    const token = await this.ports.tokens.verify(request.bearerToken);
    if (token === null) throw denied();
    if (
      !isNonEmptyString(token.subjectId) ||
      !isNonEmptyString(token.sessionId) ||
      !Number.isSafeInteger(token.expiresAt)
    )
      throw unavailable();

    const now = this.ports.clock.now();
    if (!Number.isSafeInteger(now)) throw unavailable();
    if (token.expiresAt <= now) throw denied();

    const session = await this.ports.sessions.find(token.sessionId);
    if (session === null) throw denied();
    if (
      session.id !== token.sessionId ||
      !Number.isSafeInteger(session.expiresAt) ||
      typeof session.subjectId !== 'string' ||
      !SESSION_STATES.includes(session.state)
    )
      throw unavailable();
    if (
      session.state !== 'active' ||
      session.subjectId !== token.subjectId ||
      session.expiresAt <= now
    )
      throw denied();

    const principal = await this.ports.identities.bySubject(token.subjectId);
    if (principal === null) throw denied();
    if (
      principal.subjectId !== token.subjectId ||
      !Array.isArray(principal.permissions) ||
      (principal.tenantId !== undefined &&
        typeof principal.tenantId !== 'string')
    )
      throw unavailable();
    if (
      !request.requiredPermissions.every((permission) =>
        principal.permissions.includes(permission),
      )
    )
      throw new AuthorizationError();

    return {
      correlationId: request.correlationId,
      principal: copyPrincipal(principal),
      deadlineAt: now + this.timeoutMs,
    };
  }
}

/** Copia campos escalares e permissões, sem manter referências do adapter. */
function copyPrincipal(principal: Principal): Principal {
  return {
    subjectId: principal.subjectId,
    ...(principal.tenantId === undefined
      ? {}
      : { tenantId: principal.tenantId }),
    permissions: [...principal.permissions],
  };
}
