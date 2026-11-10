/** Erros de idempotência com código estável. Nunca carregam chave, payload ou resultado. */
export type IdempotencyErrorCode =
  | 'idempotency_key_required'
  | 'idempotency_key_invalid'
  | 'idempotency_conflict'
  | 'idempotency_in_progress'
  | 'idempotency_outcome_unknown'
  | 'idempotency_failed_terminal'
  | 'idempotency_claim_lost'
  | 'idempotency_result_invalid'
  | 'idempotency_content_invalid'
  | 'idempotency_policy_invalid';

export class IdempotencyError extends Error {
  constructor(readonly code: IdempotencyErrorCode) {
    super(code);
    this.name = new.target.name;
  }
}

export class IdempotencyKeyRequiredError extends IdempotencyError {
  constructor() {
    super('idempotency_key_required');
  }
}

export class IdempotencyKeyInvalidError extends IdempotencyError {
  constructor() {
    super('idempotency_key_invalid');
  }
}

/** Mesma chave contextual com conteúdo semântico diferente. Nada é executado. */
export class IdempotencyConflictError extends IdempotencyError {
  constructor() {
    super('idempotency_conflict');
  }
}

/** Intenção já reivindicada e ainda não concluída. */
export class IdempotencyInProgressError extends IdempotencyError {
  constructor() {
    super('idempotency_in_progress');
  }
}

/** Efeito possivelmente realizado sem resultado registrado. Não é reexecutado automaticamente. */
export class IdempotencyOutcomeUnknownError extends IdempotencyError {
  constructor() {
    super('idempotency_outcome_unknown');
  }
}

/** Intenção concluída com falha terminal; a falha é reapresentada sem reexecutar. */
export class IdempotencyTerminalFailureError extends IdempotencyError {
  constructor() {
    super('idempotency_failed_terminal');
  }
}

/**
 * Executor obsoleto: a escrita de conclusão, falha, renovação de lease ou resolução
 * foi recusada porque o token ou a versão não correspondem mais ao registro, ou o
 * lease expirou. Nenhuma escrita desse executor é confirmada.
 */
export class IdempotencyStaleClaimError extends IdempotencyError {
  constructor() {
    super('idempotency_claim_lost');
  }
}

/** Resultado do efeito não é JSON canônico e não pode ser reapresentado. */
export class IdempotencyResultError extends IdempotencyError {
  constructor() {
    super('idempotency_result_invalid');
  }
}

/** Conteúdo semântico ou resultado com valor fora de JSON (undefined em array, Date, ciclo, NaN). */
export class IdempotencyContentError extends IdempotencyError {
  constructor() {
    super('idempotency_content_invalid');
  }
}

/** Política de operação inválida (identificador, retenção, funções). */
export class IdempotencyPolicyError extends IdempotencyError {
  constructor() {
    super('idempotency_policy_invalid');
  }
}

/**
 * Sinalização de operação: falha sem efeito externo confirmado, pode ser
 * reexecutada com a mesma chave. Lançada pelo `run` da operação.
 */
export class IdempotentRetryableFailure extends Error {
  readonly code = 'idempotent_retryable_failure';

  constructor() {
    super('idempotent_retryable_failure');
    this.name = 'IdempotentRetryableFailure';
  }
}

/** Sinalização de operação: falha definitiva; repetições recebem a mesma falha. */
export class IdempotentTerminalFailure extends Error {
  readonly code = 'idempotent_terminal_failure';

  constructor() {
    super('idempotent_terminal_failure');
    this.name = 'IdempotentTerminalFailure';
  }
}
