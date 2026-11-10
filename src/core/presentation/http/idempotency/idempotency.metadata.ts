export const IDEMPOTENT_METADATA = 'foundation.api.v1.idempotent';

/** Entrada que entra no fingerprint quando a rota não declara `semanticContent`. */
export interface IdempotentRequestPayload {
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
}

export interface IdempotentRouteOptions {
  /** Identificador estável da operação. */
  readonly operationId: string;
  /** Retenção da intenção em ms (1 s a 30 dias). */
  readonly retentionMs: number;
  /** Campos semânticos do fingerprint. Padrão: params, query e body. Deve devolver JSON puro. */
  readonly semanticContent?: (payload: IdempotentRequestPayload) => unknown;
}
