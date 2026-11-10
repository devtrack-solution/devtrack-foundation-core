import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type {
  JobExecutor,
  JobOutcome,
} from '../../core/application/activities/job-executor';
import {
  JOB_EXECUTOR,
  JOB_RETRY_POLICY,
} from '../../core/application/activities/activities.tokens';
import type { JobRetryPolicy } from '../../core/application/activities/job-retry-policy';
import type { JobEnvelope } from '../../core/application/execution/job-envelope';
import { FOUNDATION_BACKOFF_TYPE } from './queue-bullmq.constants';
import type { ValidatedQueueBullmqOptions } from './queue-bullmq.options';
import { QUEUE_BULLMQ_OPTIONS } from './queue-bullmq.tokens';

export interface DrainReport {
  /** true quando nenhum job estava em execução ao fim do prazo. */
  readonly completed: boolean;
  /** Jobs ainda em execução quando o worker foi fechado à força; voltam à fila pelo lock. */
  readonly abandoned: number;
  readonly elapsedMs: number;
}

/** Espera a promessa ou o prazo; devolve true se a promessa terminou primeiro. */
function settleWithin(
  promise: Promise<unknown>,
  deadlineMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Consumidor BullMQ. Concorrência limitada pelo worker; cada job passa pelo
 * JobExecutor. Falhas recuperáveis viram erro comum (BullMQ aplica backoff) e
 * terminais viram UnrecoverableError (vão direto para a fila de falha).
 */
@Injectable()
export class BullmqJobConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker: Worker<JobEnvelope<unknown>, void, string> | undefined;
  private readonly inFlight = new Set<Promise<JobOutcome>>();
  private stopping: Promise<DrainReport> | undefined;

  constructor(
    @Inject(QUEUE_BULLMQ_OPTIONS)
    private readonly options: ValidatedQueueBullmqOptions,
    @Inject(JOB_EXECUTOR) private readonly executor: JobExecutor,
    @Inject(JOB_RETRY_POLICY) private readonly retry: JobRetryPolicy,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  start(): void {
    if (this.worker !== undefined || this.stopping !== undefined) return;
    const { consumer, connection, queueName } = this.options;
    this.worker = new Worker<JobEnvelope<unknown>, void, string>(
      queueName,
      (job) => this.process(job),
      {
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: consumer.concurrency,
        lockDuration: consumer.lockDurationMs,
        stalledInterval: consumer.stalledIntervalMs,
        maxStalledCount: consumer.maxStalledCount,
        settings: {
          backoffStrategy: (failedAttempts: number, type: string) =>
            type === FOUNDATION_BACKOFF_TYPE
              ? this.retry.backoffDelayMs(failedAttempts, Math.random)
              : 0,
        },
      },
    );
  }

  /**
   * Para de buscar jobs, aguarda os em execução até o prazo e fecha o worker
   * sem esperar. Jobs ainda ativos perdem o lock e são retomados por outro worker.
   */
  drain(
    deadlineMs: number = this.options.consumer.drainDeadlineMs,
  ): Promise<DrainReport> {
    this.stopping ??= this.stop(deadlineMs);
    return this.stopping;
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  private async stop(deadlineMs: number): Promise<DrainReport> {
    const started = Date.now();
    const worker = this.worker;
    if (worker === undefined) {
      return { completed: true, abandoned: 0, elapsedMs: 0 };
    }
    await worker.pause(true);
    const idle = await settleWithin(
      Promise.allSettled([...this.inFlight]),
      deadlineMs,
    );
    const abandoned = this.inFlight.size;
    await worker.close(true);
    this.worker = undefined;
    return { completed: idle, abandoned, elapsedMs: Date.now() - started };
  }

  private async process(
    job: Job<JobEnvelope<unknown>, void, string>,
  ): Promise<void> {
    const envelope = job.data;
    const maxAttempts = this.retry.resolveMaxAttempts(envelope.maxAttempts);
    const run = this.executor.execute(
      envelope,
      job.attemptsStarted,
      maxAttempts,
    );
    this.inFlight.add(run);
    try {
      const outcome = await run;
      if (outcome.kind === 'succeeded') return;
      if (outcome.kind === 'terminal')
        throw new UnrecoverableError(outcome.code);
      throw new Error(outcome.code);
    } finally {
      this.inFlight.delete(run);
    }
  }
}
