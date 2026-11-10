import type { JsonValue } from '../idempotency/idempotency.types';
import { OUTBOX_LIMITS, type OutboxIntent } from './outbox.model';

/** Erro de validação: nomeia o campo, nunca o valor. */
export class OutboxValidationError extends Error {
  constructor(readonly field: string) {
    super(`outbox_invalid:${field}`);
    this.name = 'OutboxValidationError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const TRACE_KEYS = new Set(['traceparent', 'tracestate']);
const TRACE_VALUE_MAX = 512;
const encoder = new TextEncoder();

function text(value: unknown, field: string, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new OutboxValidationError(field);
  }
}

/**
 * Valida a intenção antes de gravá-la. Não aceita bearer token: só identidade
 * interna e causalidade. Payload deve ser JSON e caber no limite.
 */
export function validateOutboxIntent(intent: OutboxIntent): void {
  text(intent.id, 'id', ID_PATTERN);
  if (/^\d+$/.test(intent.id)) throw new OutboxValidationError('id');
  text(intent.type, 'type', TYPE_PATTERN);
  if (
    !Number.isSafeInteger(intent.payloadVersion) ||
    intent.payloadVersion < 1 ||
    intent.payloadVersion > 1000
  ) {
    throw new OutboxValidationError('payloadVersion');
  }
  text(intent.subjectId, 'subjectId', ID_PATTERN);
  if (intent.tenantId !== undefined)
    text(intent.tenantId, 'tenantId', ID_PATTERN);
  text(intent.correlationId, 'correlationId', ID_PATTERN);
  if (intent.payload === undefined) throw new OutboxValidationError('payload');
  const serialized = JSON.stringify(intent.payload satisfies JsonValue);
  if (
    typeof serialized !== 'string' ||
    encoder.encode(serialized).byteLength > OUTBOX_LIMITS.maxPayloadBytes
  ) {
    throw new OutboxValidationError('payload');
  }
  if (intent.traceContext !== undefined) {
    for (const [key, value] of Object.entries(intent.traceContext)) {
      if (
        !TRACE_KEYS.has(key) ||
        typeof value !== 'string' ||
        value.length > TRACE_VALUE_MAX
      ) {
        throw new OutboxValidationError('traceContext');
      }
    }
  }
}
