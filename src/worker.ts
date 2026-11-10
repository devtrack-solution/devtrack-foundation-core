// Inicialização antecipada: este import deve ser a PRIMEIRA linha. Carrega a
// instrumentação OTel (vazia quando não selecionada) antes dos módulos instrumentados.
import './composition/instrumentation.generated';
import {
  Logger,
  type DynamicModule,
  type INestApplicationContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { IdentityAccessResolver } from './core/application/security/authentication.ports';
import type { JobHandler } from './core/application/activities/job-handler';
import {
  PERSISTENCE_DATA_SOURCE,
  PersistenceTypeOrmModule,
  persistenceConfigFromEnv,
} from './native/persistence-typeorm';
import { PERSISTENCE_CONTRIBUTIONS } from './native/persistence-typeorm/persistence-contributions';
import {
  ACTIVITIES_PERSISTENCE,
  TypeOrmActivityStore,
} from './native/persistence-typeorm/activities';
import {
  ACTIVITY_STORE,
  BullmqJobConsumer,
  JOB_CONSUMER,
  JOB_IDENTITY_RESOLVER,
  QueueBullmqModule,
  type DrainReport,
  type QueueBullmqOptions,
} from './native/queue-bullmq';
import type { DataSource } from 'typeorm';

export type WorkerEnv = Readonly<Record<string, string | undefined>>;

export interface WorkerStartInput {
  readonly env: WorkerEnv;
  /** Handlers de negócio dos módulos. Um por `type`. */
  readonly handlers: readonly JobHandler[];
  /** Autorização atual dos subjects. Obrigatória: o worker não executa sem ela. */
  readonly identity: IdentityAccessResolver | undefined;
}

export interface RunningWorker {
  readonly app: INestApplicationContext;
  readonly consumer: BullmqJobConsumer;
  readonly drainDeadlineMs: number;
}

export class WorkerConfigurationError extends Error {
  constructor(readonly code: 'worker_identity_resolver_missing') {
    super(code);
    this.name = 'WorkerConfigurationError';
  }
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

/** Lê a configuração do worker. Valores inválidos são rejeitados pela validação do adapter. */
export function queueBullmqOptionsFromEnv(env: WorkerEnv): QueueBullmqOptions {
  const port = intEnv(env.FOUNDATION_REDIS_PORT, 6379);
  const db =
    env.FOUNDATION_REDIS_DB === undefined
      ? undefined
      : intEnv(env.FOUNDATION_REDIS_DB, 0);
  return {
    connection: {
      host: env.FOUNDATION_REDIS_HOST ?? '',
      port,
      ...(env.FOUNDATION_REDIS_PASSWORD === undefined
        ? {}
        : { password: env.FOUNDATION_REDIS_PASSWORD }),
      ...(db === undefined ? {} : { db }),
    },
    queueName: env.FOUNDATION_JOBS_QUEUE ?? 'foundation-jobs',
    maxPayloadBytes: intEnv(env.FOUNDATION_JOBS_MAX_PAYLOAD_BYTES, 65_536),
    retry: {
      globalMaxAttempts: intEnv(env.FOUNDATION_JOBS_MAX_ATTEMPTS, 5),
      baseDelayMs: intEnv(env.FOUNDATION_JOBS_BACKOFF_BASE_MS, 1000),
      maxDelayMs: intEnv(env.FOUNDATION_JOBS_BACKOFF_MAX_MS, 60_000),
      timeoutMs: intEnv(env.FOUNDATION_JOBS_TIMEOUT_MS, 30_000),
    },
    consumer: {
      concurrency: intEnv(env.FOUNDATION_WORKER_CONCURRENCY, 4),
      lockDurationMs: intEnv(env.FOUNDATION_WORKER_LOCK_MS, 30_000),
      stalledIntervalMs: intEnv(
        env.FOUNDATION_WORKER_STALLED_INTERVAL_MS,
        30_000,
      ),
      maxStalledCount: intEnv(env.FOUNDATION_WORKER_MAX_STALLED, 3),
      drainDeadlineMs: intEnv(env.FOUNDATION_WORKER_DRAIN_DEADLINE_MS, 30_000),
    },
  };
}

class WorkerRootModule {}

function workerModule(input: WorkerStartInput): DynamicModule {
  const contributions = [
    ACTIVITIES_PERSISTENCE,
    ...PERSISTENCE_CONTRIBUTIONS.filter(
      (contribution) =>
        contribution.moduleId !== ACTIVITIES_PERSISTENCE.moduleId,
    ),
  ];
  return {
    module: WorkerRootModule,
    imports: [
      QueueBullmqModule.register({
        options: queueBullmqOptionsFromEnv(input.env),
        consume: true,
        handlers: input.handlers,
        imports: [
          PersistenceTypeOrmModule.register({
            contributions,
            config: persistenceConfigFromEnv(input.env),
          }),
        ],
        ports: [
          {
            provide: ACTIVITY_STORE,
            useFactory: (dataSource: DataSource) =>
              new TypeOrmActivityStore(dataSource),
            inject: [PERSISTENCE_DATA_SOURCE],
          },
          { provide: JOB_IDENTITY_RESOLVER, useValue: input.identity },
        ],
      }),
    ],
  };
}

/**
 * Sobe o worker sem HTTP: contexto de aplicação Nest, persistência, fila e consumo.
 * Não registra sinais: quem chama decide o encerramento (ver `runWorkerProcess`).
 */
export async function startWorker(
  input: WorkerStartInput,
): Promise<RunningWorker> {
  if (input.identity === undefined) {
    throw new WorkerConfigurationError('worker_identity_resolver_missing');
  }
  const options = queueBullmqOptionsFromEnv(input.env);
  const app = await NestFactory.createApplicationContext(workerModule(input), {
    logger: ['error', 'warn', 'log'],
  });
  return {
    app,
    consumer: app.get<BullmqJobConsumer>(JOB_CONSUMER),
    drainDeadlineMs: options.consumer?.drainDeadlineMs ?? 30_000,
  };
}

/**
 * Encerramento ordenado: para de buscar jobs, aguarda os em execução até o prazo,
 * fecha o worker (jobs ainda ativos perdem o lock e voltam à fila) e fecha a aplicação.
 * Feito antes de `app.close()` para que o DataSource ainda esteja aberto durante a drenagem.
 */
export async function shutdownWorker(
  worker: RunningWorker,
): Promise<DrainReport> {
  const report = await worker.consumer.drain(worker.drainDeadlineMs);
  await worker.app.close();
  return report;
}

/**
 * Processo worker: SIGTERM/SIGINT disparam a drenagem e saída com código 0.
 * `enableShutdownHooks` do Nest não é usado para sinais porque ele fecharia o
 * DataSource antes da drenagem; o encerramento acontece aqui, na ordem certa.
 */
export function runWorkerProcess(input: WorkerStartInput): Promise<void> {
  const logger = new Logger('Worker');
  return startWorker(input).then((worker) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      const backstop = setTimeout(
        () => process.exit(1),
        worker.drainDeadlineMs + 10_000,
      );
      backstop.unref();
      void shutdownWorker(worker)
        .then((report) => {
          logger.log(
            `drain signal=${signal} completed=${report.completed} abandoned=${report.abandoned} elapsedMs=${report.elapsedMs}`,
          );
          process.exit(0);
        })
        .catch(() => {
          logger.error(`drain signal=${signal} failed`);
          process.exit(1);
        });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

if (require.main === module) {
  // Entrypoint de produção: sem resolver de identidade configurado, o boot falha.
  // O integrador deve chamar `startWorker`/`runWorkerProcess` com o resolver do host.
  runWorkerProcess({
    env: process.env,
    handlers: [],
    identity: undefined,
  }).catch((error: unknown) => {
    const code =
      error instanceof WorkerConfigurationError
        ? error.code
        : 'worker_boot_failed';
    new Logger('Worker').error(code);
    process.exit(1);
  });
}
