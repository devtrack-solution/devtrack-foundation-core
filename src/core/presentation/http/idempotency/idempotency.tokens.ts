/**
 * Porta `IdempotencyService` do host (use `IDEMPOTENCY_SERVICE` de application).
 * Esta é a porta `IdentityAccessResolver` usada para revalidar o acesso em replay.
 * Deve apontar para o mesmo provider do registro de segurança HTTP.
 */
export const IDEMPOTENCY_IDENTITY_RESOLVER = Symbol.for(
  'foundation.api.v1.idempotency.identity-resolver',
);

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
