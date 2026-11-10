import type { JobEnvelope } from './job-envelope';
import type { JobErrorCode } from './job-failure';

export interface JobEnvelopeLimits {
  /** Tamanho máximo do payload serializado em UTF-8, em bytes. */
  readonly maxPayloadBytes: number;
  /** Teto aceito para `maxAttempts` do envelope. */
  readonly maxAttemptsCeiling: number;
}

/** Erro de validação: carrega apenas o nome do campo, nunca o valor. */
export class JobEnvelopeValidationError extends Error {
  readonly code: JobErrorCode = 'job_envelope_invalid';
  constructor(readonly field: string) {
    super(`job_envelope_invalid:${field}`);
    this.name = 'JobEnvelopeValidationError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const TRACE_KEYS = new Set(['traceparent', 'tracestate']);
const TRACE_VALUE_MAX = 512;
const encoder = new TextEncoder();

function requireText(value: unknown, field: string, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new JobEnvelopeValidationError(field);
  }
}

function requireInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new JobEnvelopeValidationError(field);
  }
}

/**
 * Valida o envelope antes de persistir atividade ou enfileirar. Não aceita
 * bearer token: só identidade interna (subjectId/tenantId) e causalidade.
 */
export function validateJobEnvelope(
  envelope: JobEnvelope<unknown>,
  limits: JobEnvelopeLimits,
): void {
  requireText(envelope.id, 'id', ID_PATTERN);
  // BullMQ rejects job ids made only of digits.
  if (/^\d+$/.test(envelope.id)) throw new JobEnvelopeValidationError('id');
  requireText(envelope.type, 'type', TYPE_PATTERN);
  requireInteger(envelope.payloadVersion, 'payloadVersion', 1, 1000);
  requireText(envelope.subjectId, 'subjectId', ID_PATTERN);
  if (envelope.tenantId !== undefined) {
    requireText(envelope.tenantId, 'tenantId', ID_PATTERN);
  }
  requireText(envelope.correlationId, 'correlationId', ID_PATTERN);
  requireInteger(envelope.deadlineAt, 'deadlineAt', 0, Number.MAX_SAFE_INTEGER);
  requireInteger(
    envelope.maxAttempts,
    'maxAttempts',
    1,
    limits.maxAttemptsCeiling,
  );

  const serialized = JSON.stringify(envelope.payload);
  if (serialized === undefined) {
    throw new JobEnvelopeValidationError('payload');
  }
  if (encoder.encode(serialized).byteLength > limits.maxPayloadBytes) {
    throw new JobEnvelopeValidationError('payload');
  }

  if (envelope.traceContext !== undefined) {
    const entries = Object.entries(envelope.traceContext);
    if (entries.length > TRACE_KEYS.size) {
      throw new JobEnvelopeValidationError('traceContext');
    }
    for (const [key, value] of entries) {
      if (
        !TRACE_KEYS.has(key) ||
        typeof value !== 'string' ||
        value.length > TRACE_VALUE_MAX
      ) {
        throw new JobEnvelopeValidationError('traceContext');
      }
    }
  }
}
