import {
  applyDecorators,
  SetMetadata,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyPolicyError } from '../../../application/idempotency/idempotency.errors';
import {
  IDEMPOTENCY_LIMITS,
  IDEMPOTENCY_OPERATION_ID_PATTERN,
} from '../../../application/idempotency/idempotency.types';
import { IdempotencyExceptionFilter } from './idempotency-exception.filter';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import {
  IDEMPOTENT_METADATA,
  type IdempotentRouteOptions,
} from './idempotency.metadata';

export { IDEMPOTENT_METADATA } from './idempotency.metadata';
export type {
  IdempotentRequestPayload,
  IdempotentRouteOptions,
} from './idempotency.metadata';

/**
 * Marca uma rota como idempotente. Exige `Idempotency-Key` e contexto autenticado
 * (use `AuthenticationGuard` na mesma rota). Validação das opções ocorre na
 * declaração: opções inválidas impedem o boot.
 *
 * Restrições: o status de resposta é o declarado pela rota (`@HttpCode` ou o padrão
 * do Nest) e é persistido; o handler não deve usar `@Res`; falhas 4xx lançadas
 * pelo handler são tratadas como sem efeito e podem ser reenviadas com a mesma chave.
 */
export function Idempotent(options: IdempotentRouteOptions): MethodDecorator {
  if (typeof options !== 'object' || options === null)
    throw new IdempotencyPolicyError();
  const { operationId, retentionMs, semanticContent } = options;
  if (
    typeof operationId !== 'string' ||
    operationId.length > IDEMPOTENCY_LIMITS.maxOperationIdLength ||
    !IDEMPOTENCY_OPERATION_ID_PATTERN.test(operationId) ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < IDEMPOTENCY_LIMITS.minRetentionMs ||
    retentionMs > IDEMPOTENCY_LIMITS.maxRetentionMs ||
    (semanticContent !== undefined && typeof semanticContent !== 'function')
  )
    throw new IdempotencyPolicyError();

  return applyDecorators(
    SetMetadata(
      IDEMPOTENT_METADATA,
      Object.freeze({
        operationId,
        retentionMs,
        ...(semanticContent === undefined ? {} : { semanticContent }),
      }) satisfies IdempotentRouteOptions,
    ),
    UseInterceptors(IdempotencyInterceptor),
    UseFilters(IdempotencyExceptionFilter),
  );
}
