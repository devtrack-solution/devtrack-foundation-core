import {
  Inject,
  Injectable,
  HttpException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, type Observable } from 'rxjs';
import type { OperationContext } from '../../../application/context/operation-context';
import {
  IdempotencyResultError,
  IdempotentRetryableFailure,
  IdempotentTerminalFailure,
} from '../../../application/idempotency/idempotency.errors';
import type { IdempotencyService } from '../../../application/idempotency/idempotency.service';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyFailureClass,
  type IdempotentOperation,
  type JsonValue,
} from '../../../application/idempotency/idempotency.types';
import type { IdentityAccessResolver } from '../../../application/security/authentication.ports';
import { AuthorizationError } from '../../../application/security/operation-authorizer';
import { AuthenticationError } from '../../../application/security/authentication.service';
import { REQUIRED_PERMISSIONS_METADATA } from '../decorators/require-permissions.decorator';
import {
  operationContextOf,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../request-state';
import {
  IDEMPOTENCY_IDENTITY_RESOLVER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from './idempotency.tokens';
import {
  IDEMPOTENT_METADATA,
  type IdempotentRequestPayload,
  type IdempotentRouteOptions,
} from './idempotency.metadata';

/** Metadata que o Nest grava para `@HttpCode`; mesmo valor da constante interna do Nest. */
const HTTP_CODE_METADATA = '__httpCode__';

interface IdempotentHttpRequest extends HttpRequestLike {
  readonly method?: string;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
}

/** Resultado persistido de uma rota HTTP: status declarado e corpo JSON. */
interface StoredHttpResult {
  readonly status: number;
  readonly body: JsonValue;
  readonly [key: string]: JsonValue;
}

/**
 * Executa a rota marcada com `@Idempotent` pelo serviço de idempotência. Replay
 * devolve o corpo persistido sem chamar o handler e com o header `Idempotent-Replayed`.
 * Autenticação é exigida: sem contexto estabelecido pelo guard, a requisição é negada.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly service: IdempotencyService,
    @Inject(IDEMPOTENCY_IDENTITY_RESOLVER)
    private readonly identities: IdentityAccessResolver,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options = this.reflector.get<IdempotentRouteOptions | undefined>(
      IDEMPOTENT_METADATA,
      context.getHandler(),
    );
    if (options === undefined) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentHttpRequest>();
    const response = http.getResponse<HttpResponseLike>();
    const operationContext = operationContextOf(request);
    if (operationContext === undefined)
      throw new AuthenticationError('invalid_credentials');

    const required =
      this.reflector.getAllAndOverride<readonly string[] | undefined>(
        REQUIRED_PERMISSIONS_METADATA,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    const status = declaredStatus(context, request.method);
    const payload: IdempotentRequestPayload = {
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body ?? null,
    };

    const operation: IdempotentOperation<IdempotentRequestPayload> = {
      policy: {
        operationId: options.operationId,
        retentionMs: options.retentionMs,
        ...(options.semanticContent === undefined
          ? {}
          : { semanticContent: options.semanticContent }),
        classifyFailure: classifyHttpFailure,
      },
      authorize: (current: OperationContext) =>
        this.recheckAccess(current, required),
    };

    const execution = await this.service.execute<
      IdempotentRequestPayload,
      StoredHttpResult
    >(
      operationContext,
      operation,
      request.headers[IDEMPOTENCY_KEY_HEADER],
      payload,
      () => runHandler(next, status),
    );

    if (execution.replayed) {
      if (execution.result.status !== status)
        throw new IdempotencyResultError();
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return of(execution.result.body);
  }

  /**
   * Revalida a autorização atual: o principal ainda existe, pertence ao mesmo
   * tenant e mantém as permissões da rota. Falha do resolver é indisponibilidade.
   */
  private async recheckAccess(
    context: OperationContext,
    required: readonly string[],
  ): Promise<void> {
    let principal: Awaited<ReturnType<IdentityAccessResolver['bySubject']>>;
    try {
      principal = await this.identities.bySubject(context.principal.subjectId);
    } catch {
      throw new AuthenticationError('authentication_unavailable');
    }
    if (principal === null)
      throw new AuthenticationError('invalid_credentials');
    if (
      principal.subjectId !== context.principal.subjectId ||
      principal.tenantId !== context.principal.tenantId
    )
      throw new AuthorizationError();
    if (
      !required.every((permission) =>
        principal.permissions.includes(permission),
      )
    )
      throw new AuthorizationError();
  }
}

async function runHandler(
  next: CallHandler,
  status: number,
): Promise<StoredHttpResult> {
  const value: unknown = await lastValueFrom(next.handle(), {
    defaultValue: undefined,
  });
  return { status, body: toJsonBody(value) };
}

/** Converte o retorno do handler em JSON puro; qualquer valor fora de JSON é erro de resultado. */
function toJsonBody(value: unknown): JsonValue {
  if (value === undefined) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new IdempotencyResultError();
  }
  if (text === undefined) return null;
  return JSON.parse(text) as JsonValue;
}

/** Status que o Nest aplica à rota quando o handler não usa `@Res`. */
function declaredStatus(
  context: ExecutionContext,
  method: string | undefined,
): number {
  const explicit = Reflect.getMetadata(
    HTTP_CODE_METADATA,
    context.getHandler(),
  ) as number | undefined;
  if (explicit !== undefined) return explicit;
  return method?.toUpperCase() === 'POST' ? 201 : 200;
}

/**
 * Falhas de handler: 4xx do Nest (pipes, validação, regras antes de qualquer
 * efeito) são reenviáveis com a mesma chave; todo o resto é desfecho desconhecido.
 */
function classifyHttpFailure(error: unknown): IdempotencyFailureClass {
  if (error instanceof IdempotentRetryableFailure) return 'retryable';
  if (error instanceof IdempotentTerminalFailure) return 'terminal';
  if (
    error instanceof HttpException &&
    error.getStatus() >= 400 &&
    error.getStatus() < 500
  )
    return 'retryable';
  return 'unknown';
}
