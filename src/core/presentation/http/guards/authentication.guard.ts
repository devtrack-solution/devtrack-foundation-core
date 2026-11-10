import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthorizationError,
  OPERATION_AUTHORIZER,
} from '../../../application/security/operation-authorizer';
import type { OperationAuthorizer } from '../../../application/security/operation-authorizer';
import { AuthenticationError } from '../../../application/security/authentication.service';
import type { OperationContext } from '../../../application/context/operation-context';
import { REQUIRED_PERMISSIONS_METADATA } from '../decorators/require-permissions.decorator';
import {
  bindOperationContext,
  ensureCorrelationId,
  type HttpRequestLike,
} from '../request-state';

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/** Extrai o token de `Authorization: Bearer <token>`. Qualquer outra forma vira undefined. */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== 'string') return undefined;
  return BEARER.exec(header)?.[1];
}

/** Defesa em profundidade: só aceita contexto com principal e prazo íntegros. */
function isEstablishedContext(value: unknown): value is OperationContext {
  if (typeof value !== 'object' || value === null) return false;
  const context = value as Partial<OperationContext>;
  return (
    typeof context.correlationId === 'string' &&
    typeof context.principal === 'object' &&
    context.principal !== null &&
    typeof context.deadlineAt === 'number'
  );
}

/**
 * Fail-closed: só libera quando o OperationAuthorizer devolve contexto. Qualquer
 * outra falha é negação. O contexto autorizado fica na requisição para o
 * OperationContextInterceptor estabelecê-lo no AsyncLocalStorage.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(OPERATION_AUTHORIZER)
    private readonly authorizer: OperationAuthorizer,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const correlationId = ensureCorrelationId(request);
    try {
      const bearerToken = extractBearerToken(request.headers.authorization);
      if (bearerToken === undefined)
        throw new AuthenticationError('invalid_credentials');
      const requiredPermissions =
        this.reflector.getAllAndOverride<readonly string[] | undefined>(
          REQUIRED_PERMISSIONS_METADATA,
          [context.getHandler(), context.getClass()],
        ) ?? [];
      const operationContext = await this.authorizer.authorize({
        bearerToken,
        correlationId,
        requiredPermissions,
      });
      if (!isEstablishedContext(operationContext))
        throw new AuthenticationError('authentication_unavailable');
      bindOperationContext(request, operationContext);
      return true;
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof AuthorizationError
      )
        throw error;
      throw new AuthenticationError('authentication_unavailable');
    }
  }
}
