/**
 * Códigos estáveis de falha de job. Nunca carregam mensagem bruta, payload ou
 * token: a atividade grava somente o código.
 */
export type JobErrorCode =
  | 'job_envelope_invalid'
  | 'job_handler_not_found'
  | 'job_payload_version_unsupported'
  | 'job_reauthorization_denied'
  | 'job_deadline_exceeded'
  | 'job_timeout'
  | 'job_handler_error';

/** Falha que vale nova tentativa dentro do orçamento. */
export class RetryableJobError extends Error {
  constructor(readonly code: JobErrorCode = 'job_handler_error') {
    super(code);
    this.name = 'RetryableJobError';
  }
}

/** Falha que encerra o job sem nova tentativa (falha terminal). */
export class TerminalJobError extends Error {
  constructor(readonly code: JobErrorCode = 'job_handler_error') {
    super(code);
    this.name = 'TerminalJobError';
  }
}

export type JobFailureClass = 'retryable' | 'terminal';

export interface ClassifiedJobFailure {
  readonly failureClass: JobFailureClass;
  readonly code: JobErrorCode;
}

/**
 * Erro desconhecido vira retryable com código genérico: a política de orçamento
 * limita as tentativas e a mensagem original é descartada.
 */
export function classifyJobFailure(error: unknown): ClassifiedJobFailure {
  if (error instanceof TerminalJobError) {
    return { failureClass: 'terminal', code: error.code };
  }
  if (error instanceof RetryableJobError) {
    return { failureClass: 'retryable', code: error.code };
  }
  return { failureClass: 'retryable', code: 'job_handler_error' };
}
