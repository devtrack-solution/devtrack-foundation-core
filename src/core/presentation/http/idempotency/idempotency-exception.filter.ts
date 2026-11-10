import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { IdempotencyError } from '../../../application/idempotency/idempotency.errors';
import {
  CORRELATION_ID_HEADER,
  ensureCorrelationId,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../request-state';

const STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  idempotency_key_required: 400,
  idempotency_key_invalid: 400,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  idempotency_outcome_unknown: 409,
  idempotency_failed_terminal: 409,
  idempotency_claim_lost: 409,
  idempotency_result_invalid: 500,
  idempotency_content_invalid: 500,
  idempotency_policy_invalid: 500,
});

/**
 * Traduz erros de idempotência para HTTP com código estável. Aplicado apenas às
 * rotas marcadas com `@Idempotent`. Nunca inclui mensagem interna, chave ou resultado.
 */
@Catch(IdempotencyError)
export class IdempotencyExceptionFilter implements ExceptionFilter {
  catch(exception: IdempotencyError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const correlationId = ensureCorrelationId(request);
    if (response.headersSent) return;

    const known = STATUS_BY_CODE[exception.code];
    const status = known ?? 500;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    if (exception.code === 'idempotency_in_progress')
      response.setHeader('Retry-After', '1');
    const error = known === undefined ? 'internal_error' : exception.code;
    response.status(status).json({ statusCode: status, error, correlationId });
  }
}
