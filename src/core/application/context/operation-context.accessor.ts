import type { OperationContext } from './operation-context';

/** Leitura do contexto da operação corrente. Sem contexto estabelecido, lança. */
export interface OperationContextAccessor {
  current(): OperationContext;
}

export class OperationContextUnavailableError extends Error {
  constructor() {
    super('operation_context_unavailable');
    this.name = 'OperationContextUnavailableError';
  }
}

/** Stable across compatible copies of the public contracts package. */
export const OPERATION_CONTEXT_ACCESSOR = Symbol.for(
  'foundation.api.v1.operation-context-accessor',
);
