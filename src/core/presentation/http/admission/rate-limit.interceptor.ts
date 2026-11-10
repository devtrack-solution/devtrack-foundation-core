import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { operationContextOf } from '../request-state';
import { ADMISSION_SERVICE } from './admission.tokens';
import { AdmissionService } from './admission.service';

/**
 * Rate limit por requisição, depois do guard: autenticados por tenant+subject,
 * anônimos pelo digest do IP. Requisições rejeitadas pelo guard não consomem cota.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    @Inject(ADMISSION_SERVICE) private readonly admission: AdmissionService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    if (this.admission.isExempt(request.path)) return next.handle();

    const operation = operationContextOf(request);
    const result = await this.admission.rateLimit(
      operation === undefined
        ? { address: request.ip ?? 'unknown' }
        : {
            ...(operation.principal.tenantId === undefined
              ? {}
              : { tenantId: operation.principal.tenantId }),
            subjectId: operation.principal.subjectId,
          },
    );
    if (result === undefined || result.outcome === 'allowed')
      return next.handle();
    if (result.outcome === 'limited') {
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      );
      throw new HttpException('Too Many Requests', 429);
    }
    throw new ServiceUnavailableException();
  }
}
