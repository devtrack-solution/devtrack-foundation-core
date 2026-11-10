import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import {
  CORRELATION_ID_HEADER,
  ensureCorrelationId,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../request-state';

/** Devolve o X-Correlation-Id válido (ou o gerado) no header da resposta. */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    response.setHeader(CORRELATION_ID_HEADER, ensureCorrelationId(request));
    return next.handle();
  }
}
