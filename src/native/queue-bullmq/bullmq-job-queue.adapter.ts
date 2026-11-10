import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type {
  EnqueueOutcome,
  JobQueue,
} from '../../core/application/activities/job-queue.port';
import { JOB_RETRY_POLICY } from '../../core/application/activities/activities.tokens';
import type { JobRetryPolicy } from '../../core/application/activities/job-retry-policy';
import type { JobEnvelope } from '../../core/application/execution/job-envelope';
import { validateJobEnvelope } from '../../core/application/execution/job-envelope.validation';
import { FOUNDATION_BACKOFF_TYPE } from './queue-bullmq.constants';
import type { ValidatedQueueBullmqOptions } from './queue-bullmq.options';
import { QUEUE_BULLMQ_OPTIONS } from './queue-bullmq.tokens';

/** Retenção de jobs concluídos no Redis; a fonte de verdade do estado é a ActivityStore. */
const COMPLETED_RETENTION_COUNT = 1000;

/**
 * Adapter da porta JobQueue sobre BullMQ. O orçamento de tentativas vai no job
 * (`attempts`) e o backoff vem da política da aplicação: uma única camada de retry.
 * Jobs terminais permanecem no conjunto `failed` do BullMQ, consultável.
 */
@Injectable()
export class BullmqJobQueue implements JobQueue, OnModuleDestroy {
  private readonly queue: Queue<JobEnvelope<unknown>>;

  constructor(
    @Inject(QUEUE_BULLMQ_OPTIONS)
    private readonly options: ValidatedQueueBullmqOptions,
    @Inject(JOB_RETRY_POLICY) private readonly retry: JobRetryPolicy,
  ) {
    this.queue = new Queue<JobEnvelope<unknown>>(options.queueName, {
      connection: { ...options.connection, maxRetriesPerRequest: 3 },
    });
  }

  async enqueue(envelope: JobEnvelope<unknown>): Promise<EnqueueOutcome> {
    validateJobEnvelope(envelope, {
      maxPayloadBytes: this.options.maxPayloadBytes,
      maxAttemptsCeiling: 100,
    });
    if ((await this.queue.getJob(envelope.id)) !== undefined) {
      return 'already_present';
    }
    await this.queue.add(envelope.type, envelope, {
      jobId: envelope.id,
      attempts: this.retry.resolveMaxAttempts(envelope.maxAttempts),
      backoff: { type: FOUNDATION_BACKOFF_TYPE },
      removeOnComplete: { count: COMPLETED_RETENTION_COUNT },
      removeOnFail: false,
    });
    return 'accepted';
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
