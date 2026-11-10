import type { JobEnvelope } from '../execution/job-envelope';
import type { JobErrorCode } from '../execution/job-failure';

export const ACTIVITY_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'cancelled',
] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Registro consultável de uma atividade. Nunca guarda mensagem bruta de erro nem payload. */
export interface ActivityRecord {
  readonly id: string;
  readonly type: string;
  readonly state: ActivityState;
  readonly attempts: number;
  readonly lastErrorCode: JobErrorCode | null;
  readonly correlationId: string;
  readonly subjectId: string;
  readonly tenantId: string | null;
  /** Epoch em ms. */
  readonly createdAt: number;
  /** Epoch em ms. */
  readonly updatedAt: number;
}

export function activityFromEnvelope(
  envelope: JobEnvelope<unknown>,
  input: {
    readonly state: ActivityState;
    readonly attempts: number;
    readonly lastErrorCode: JobErrorCode | null;
    readonly now: number;
    readonly createdAt?: number;
  },
): ActivityRecord {
  return {
    id: envelope.id,
    type: envelope.type,
    state: input.state,
    attempts: input.attempts,
    lastErrorCode: input.lastErrorCode,
    correlationId: envelope.correlationId,
    subjectId: envelope.subjectId,
    tenantId: envelope.tenantId ?? null,
    createdAt: input.createdAt ?? input.now,
    updatedAt: input.now,
  };
}
