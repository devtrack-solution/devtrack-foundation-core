import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AdmissionRejectedError } from '../../../application/admission/admission.gate';
import { CORRELATION_ID_HEADER, ensureCorrelationId } from '../request-state';
import { ADMISSION_SERVICE } from './admission.tokens';
import { AdmissionService } from './admission.service';

/**
 * Primeira barreira da requisição: vaga de processamento com fila limitada.
 * Rejeita com 503 e Retry-After; a vaga é devolvida quando a resposta termina.
 */
@Injectable()
export class AdmissionMiddleware implements NestMiddleware {
  constructor(
    @Inject(ADMISSION_SERVICE) private readonly admission: AdmissionService,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (this.admission.isExempt(request.path)) {
      next();
      return;
    }
    this.admission.admit().then(
      (grant) => {
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          grant.permit.release();
        };
        response.once('finish', release);
        response.once('close', release);
        this.admission.recordAdmitted(grant.queued, grant.waitedMs);
        try {
          next();
        } catch (error) {
          next(error);
        }
      },
      (error: unknown) => this.reject(request, response, error),
    );
  }

  private reject(request: Request, response: Response, error: unknown): void {
    this.admission.recordRejected(
      error instanceof AdmissionRejectedError ? error.reason : 'unknown',
    );
    const correlationId = ensureCorrelationId(request);
    response.setHeader('Retry-After', String(this.admission.retryAfterSeconds));
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    response
      .status(503)
      .json({ statusCode: 503, error: 'Service Unavailable', correlationId });
  }
}
