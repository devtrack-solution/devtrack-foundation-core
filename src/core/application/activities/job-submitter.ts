import type { JobEnvelope } from '../execution/job-envelope';
import {
  validateJobEnvelope,
  type JobEnvelopeLimits,
} from '../execution/job-envelope.validation';
import { activityFromEnvelope } from './activity.model';
import type { ActivityStore } from './activity-store.port';
import type { JobExecutorDependencies } from './job-executor';
import type { JobQueue, EnqueueOutcome } from './job-queue.port';

export interface JobSubmission {
  readonly activityId: string;
  /** false quando a atividade já existia (reenvio com o mesmo id). */
  readonly activityCreated: boolean;
  readonly queue: EnqueueOutcome;
}

/**
 * Registra a atividade como `queued` e depois enfileira. Reenviar o mesmo id é
 * seguro: a atividade não é sobrescrita e a fila deduplica por id.
 * Se o broker falhar após o registro, a atividade fica `queued` e o produtor
 * repete a chamada com o mesmo id.
 */
export class JobSubmitter {
  constructor(
    private readonly deps: {
      readonly activities: ActivityStore;
      readonly queue: JobQueue;
      readonly clock: JobExecutorDependencies['clock'];
      readonly limits: JobEnvelopeLimits;
    },
  ) {}

  async submit(envelope: JobEnvelope<unknown>): Promise<JobSubmission> {
    validateJobEnvelope(envelope, this.deps.limits);
    const created = await this.deps.activities.insertIfAbsent(
      activityFromEnvelope(envelope, {
        state: 'queued',
        attempts: 0,
        lastErrorCode: null,
        now: this.deps.clock.now(),
      }),
    );
    const queue = await this.deps.queue.enqueue(envelope);
    return { activityId: envelope.id, activityCreated: created, queue };
  }
}
