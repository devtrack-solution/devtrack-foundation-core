import {
  ADMISSION_REJECTED_METRIC,
  RATELIMIT_REJECTED_METRIC,
} from '../../../application/observability/signal-catalog';
import type { OperationSignals } from '../../../application/observability/signal-contracts';

/**
 * Sinais de admissão. Recusas por capacidade e por limite de taxa usam os contadores
 * do catálogo (`recordSaturation`, atributo `reason`). Os demais eventos são atividades
 * (`recordActivity`). Valores de `reason` usam hífen: o validador de atributos não aceita `_`.
 */
export const ADMISSION_SIGNAL = {
  admitted: 'admission.admitted',
  queued: 'admission.queued',
  queueWait: 'admission.queue_wait',
  rateAllowed: 'ratelimit.allowed',
  rateDegraded: 'ratelimit.degraded',
} as const;

export type AdmissionRejectionReason =
  'queue-full' | 'queue-timeout' | 'draining';

export type RateLimitRejectionReason = 'limit-exceeded' | 'store-unavailable';

export function recordSignal(
  signals: OperationSignals,
  name: (typeof ADMISSION_SIGNAL)[keyof typeof ADMISSION_SIGNAL],
  outcome: 'succeeded' | 'failed',
  durationMs = 0,
): void {
  signals.recordActivity(name, outcome, durationMs);
}

export function recordAdmissionRejection(
  signals: OperationSignals,
  reason: AdmissionRejectionReason,
): void {
  signals.recordSaturation(ADMISSION_REJECTED_METRIC, { reason });
}

export function recordRateLimitRejection(
  signals: OperationSignals,
  reason: RateLimitRejectionReason,
): void {
  signals.recordSaturation(RATELIMIT_REJECTED_METRIC, { reason });
}
