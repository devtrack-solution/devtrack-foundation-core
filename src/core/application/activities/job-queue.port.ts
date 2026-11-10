import type { JobEnvelope } from '../execution/job-envelope';

export type EnqueueOutcome = 'accepted' | 'already_present';

/**
 * Porta de fila. Dedup por `envelope.id`: reenviar o mesmo id não cria segundo job.
 * Adapter (ex.: BullMQ) é responsável pela entrega at-least-once.
 */
export interface JobQueue {
  enqueue(envelope: JobEnvelope<unknown>): Promise<EnqueueOutcome>;
}
