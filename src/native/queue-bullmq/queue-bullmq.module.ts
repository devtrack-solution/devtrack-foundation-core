import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type Provider,
} from '@nestjs/common';
import {
  ACTIVITY_STORE,
  JOB_EXECUTOR,
  JOB_HANDLER_REGISTRY,
  JOB_QUEUE,
  JOB_RETRY_POLICY,
  JOB_SUBMITTER,
} from '../../core/application/activities/activities.tokens';
import { JobExecutor } from '../../core/application/activities/job-executor';
import type { JobHandler } from '../../core/application/activities/job-handler';
import { JobHandlerRegistry } from '../../core/application/activities/job-handler';
import { createJobRetryPolicy } from '../../core/application/activities/job-retry-policy';
import { JobSubmitter } from '../../core/application/activities/job-submitter';
import type { ActivityStore } from '../../core/application/activities/activity-store.port';
import type { IdentityAccessResolver } from '../../core/application/security/authentication.ports';
import { JOB_IDENTITY_RESOLVER } from '../../core/application/activities/activities.tokens';
import { BullmqJobConsumer } from './bullmq-job-consumer';
import { BullmqJobQueue } from './bullmq-job-queue.adapter';
import {
  JOB_CONSUMER,
  QUEUE_BULLMQ_HANDLERS,
  QUEUE_BULLMQ_OPTIONS,
} from './queue-bullmq.tokens';
import {
  QueueBullmqConfigError,
  validateQueueBullmqOptions,
  type QueueBullmqOptions,
  type ValidatedQueueBullmqOptions,
} from './queue-bullmq.options';

export interface QueueBullmqRegistration {
  readonly options: QueueBullmqOptions;
  /** true apenas no processo worker. A API usa somente o produtor (JobSubmitter). */
  readonly consume?: boolean;
  readonly handlers?: readonly JobHandler[];
  /** Ex.: PersistenceTypeOrmModule.register(...) para expor o DataSource ao ActivityStore. */
  readonly imports?: DynamicModule['imports'];
  /**
   * Provedores do host para ACTIVITY_STORE e JOB_IDENTITY_RESOLVER. A identidade
   * é a autorização atual do subject; nenhum bearer token entra aqui.
   */
  readonly ports: readonly Provider[];
}

/**
 * Mesmo contrato de `register`, mas as opções são resolvidas na injeção (ex.: vindas
 * do host por token). Validação idêntica, feita na criação do módulo.
 */
export interface QueueBullmqAsyncRegistration extends Omit<
  QueueBullmqRegistration,
  'options'
> {
  readonly inject?: readonly InjectionToken[];
  readonly useFactory: (
    ...args: unknown[]
  ) => QueueBullmqOptions | Promise<QueueBullmqOptions>;
}

/** Teto absoluto do envelope; o teto global da política apenas limita a tentativa efetiva. */
const ABSOLUTE_MAX_ATTEMPTS = 100;

/** Providers comuns a register e registerAsync: dependem só das opções validadas injetadas. */
function buildModule(
  registration: Pick<
    QueueBullmqRegistration,
    'consume' | 'handlers' | 'imports' | 'ports'
  >,
  consume: boolean,
  optionsProvider: Provider,
): DynamicModule {
  const providers: Provider[] = [
    ...registration.ports,
    optionsProvider,
    { provide: QUEUE_BULLMQ_HANDLERS, useValue: registration.handlers ?? [] },
    {
      provide: JOB_RETRY_POLICY,
      inject: [QUEUE_BULLMQ_OPTIONS],
      useFactory: (options: ValidatedQueueBullmqOptions) =>
        createJobRetryPolicy(options.retry),
    },
    {
      provide: JOB_HANDLER_REGISTRY,
      useFactory: (handlers: readonly JobHandler[]) =>
        new JobHandlerRegistry(handlers),
      inject: [QUEUE_BULLMQ_HANDLERS],
    },
    { provide: JOB_QUEUE, useClass: BullmqJobQueue },
    {
      provide: JOB_EXECUTOR,
      useFactory: (
        registry: JobHandlerRegistry,
        activities: ActivityStore,
        identities: IdentityAccessResolver,
        retry: ReturnType<typeof createJobRetryPolicy>,
      ) =>
        new JobExecutor({
          registry,
          activities,
          identities,
          clock: { now: () => Date.now() },
          retry,
        }),
      inject: [
        JOB_HANDLER_REGISTRY,
        ACTIVITY_STORE,
        JOB_IDENTITY_RESOLVER,
        JOB_RETRY_POLICY,
      ],
    },
    {
      provide: JOB_SUBMITTER,
      useFactory: (
        activities: ActivityStore,
        queue: BullmqJobQueue,
        options: ValidatedQueueBullmqOptions,
      ) =>
        new JobSubmitter({
          activities,
          queue,
          clock: { now: () => Date.now() },
          limits: {
            maxPayloadBytes: options.maxPayloadBytes,
            maxAttemptsCeiling: ABSOLUTE_MAX_ATTEMPTS,
          },
        }),
      inject: [ACTIVITY_STORE, JOB_QUEUE, QUEUE_BULLMQ_OPTIONS],
    },
  ];
  if (consume) {
    providers.push(BullmqJobConsumer, {
      provide: JOB_CONSUMER,
      useExisting: BullmqJobConsumer,
    });
  }
  return {
    module: QueueBullmqModule,
    imports: registration.imports ?? [],
    providers,
    exports: [
      JOB_QUEUE,
      JOB_SUBMITTER,
      JOB_EXECUTOR,
      ...(consume ? [JOB_CONSUMER] : []),
    ],
  };
}

@Module({})
export class QueueBullmqModule {
  static register(registration: QueueBullmqRegistration): DynamicModule {
    const consume = registration.consume === true;
    const options = validateQueueBullmqOptions(registration.options, {
      consume,
    });
    return buildModule(registration, consume, {
      provide: QUEUE_BULLMQ_OPTIONS,
      useValue: options,
    });
  }

  /**
   * Opções vindas do host (ex.: cofre), resolvidas na injeção. Configuração inválida
   * falha na criação do módulo, antes de qualquer conexão com o Redis.
   */
  static registerAsync(
    registration: QueueBullmqAsyncRegistration,
  ): DynamicModule {
    if (typeof registration?.useFactory !== 'function')
      throw new QueueBullmqConfigError('useFactory');
    const consume = registration.consume === true;
    return buildModule(registration, consume, {
      provide: QUEUE_BULLMQ_OPTIONS,
      inject: [...(registration.inject ?? [])],
      useFactory: async (...args: unknown[]) =>
        validateQueueBullmqOptions(await registration.useFactory(...args), {
          consume,
        }),
    });
  }
}
