import type { JsonValue } from '../idempotency/idempotency.types';

/** Estados da intenção de publicação. `failed` é terminal e inspecionável. */
export type OutboxState = 'pending' | 'published' | 'failed';

/** Códigos técnicos gravados em `last_error_code`. Nunca carregam mensagem de erro bruta. */
export type OutboxErrorCode =
  'BROKER_UNAVAILABLE' | 'ENVELOPE_INVALID' | 'MAX_ATTEMPTS_EXCEEDED';

export const OUTBOX_LIMITS = Object.freeze({
  maxPayloadBytes: 65_536,
  maxBatchSize: 500,
  maxPublishPerSecond: 10_000,
  minLeaseMs: 1_000,
  maxLeaseMs: 600_000,
  maxAttemptsCeiling: 100,
  maxBackoffMs: 86_400_000,
  maxStatusAgeMs: 31 * 24 * 60 * 60 * 1000,
});

/**
 * Intenção de publicação gravada na mesma transação da escrita de negócio.
 * `id` vira o `JobEnvelope.id` e o `jobId` no broker (dedup).
 */
export interface OutboxIntent {
  readonly id: string;
  readonly type: string;
  readonly payloadVersion: number;
  readonly payload: JsonValue;
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
  readonly traceContext?: Readonly<Record<string, string>>;
}

/** Mensagem reivindicada pelo relay: intenção mais o estado de entrega. */
export interface ClaimedOutboxMessage extends OutboxIntent {
  /** Número desta tentativa (já incrementado pela reivindicação). */
  readonly attempts: number;
  readonly createdAt: number;
}

/** Foto operacional para sinalização de pendências e falhas. */
export interface OutboxSnapshot {
  readonly pending: number;
  readonly failed: number;
  /** Idade em ms da pendência mais antiga; `null` sem pendências. */
  readonly oldestPendingAgeMs: number | null;
  /** Maior número de tentativas entre as pendências; 0 sem pendências. */
  readonly maxPendingAttempts: number;
}
