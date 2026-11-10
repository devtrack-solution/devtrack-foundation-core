import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { AuthorizationError } from '../../../application/security/operation-authorizer';
import { AuthenticationError } from '../../../application/security/authentication.service';
import {
  CORRELATION_ID_HEADER,
  ensureCorrelationId,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../request-state';

interface Classification {
  readonly status: number;
  readonly error: string;
}

/** Mapeia erros para respostas neutras. Nunca inclui mensagem, causa ou stack. */
function classify(exception: unknown): Classification {
  if (exception instanceof AuthenticationError) {
    if (exception.code === 'invalid_credentials')
      return { status: 401, error: 'unauthorized' };
    // Renovação concorrente perdida: corpo neutro, sem indicar a sessão nem o token.
    if (exception.code === 'refresh_conflict')
      return { status: 409, error: 'refresh_conflict' };
    return { status: 503, error: 'service_unavailable' };
  }
  if (exception instanceof AuthorizationError)
    return { status: 403, error: 'forbidden' };
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, error: STATUS_CODES[status] ?? 'error' };
  }
  return { status: 500, error: 'internal_error' };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const correlationId = ensureCorrelationId(request);
    if (response.headersSent) return;
    const { status, error } = classify(exception);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    response.status(status).json({ statusCode: status, error, correlationId });
  }
}
