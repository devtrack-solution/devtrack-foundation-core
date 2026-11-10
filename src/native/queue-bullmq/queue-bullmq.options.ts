import type { JobRetryPolicyConfig } from '../../core/application/activities/job-retry-policy';

export interface QueueBullmqConnection {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;
}

export interface QueueBullmqConsumerOptions {
  /** Jobs simultâneos por processo worker (1 a 64). */
  readonly concurrency: number;
  /** Validade do lock; após expirar sem renovação, outro worker retoma o job. */
  readonly lockDurationMs: number;
  /** Intervalo da verificação de jobs travados. */
  readonly stalledIntervalMs: number;
  /** Quantas vezes um job travado pode voltar à fila antes de falhar. */
  readonly maxStalledCount: number;
  /** Prazo de drenagem no SIGTERM: aguarda jobs em execução até este tempo. */
  readonly drainDeadlineMs: number;
}

export interface QueueBullmqOptions {
  readonly connection: QueueBullmqConnection;
  /** Nome da fila no Redis. Padrão `foundation-jobs`. */
  readonly queueName?: string;
  /** Limite de tamanho do payload serializado (bytes). Padrão 65536. */
  readonly maxPayloadBytes?: number;
  readonly retry: JobRetryPolicyConfig;
  /** Obrigatório apenas quando o módulo consome jobs (`consume: true`). */
  readonly consumer?: QueueBullmqConsumerOptions;
}

export interface ValidatedQueueBullmqOptions {
  readonly connection: QueueBullmqConnection;
  readonly queueName: string;
  readonly maxPayloadBytes: number;
  readonly retry: JobRetryPolicyConfig;
  readonly consumer: QueueBullmqConsumerOptions;
}

/** Erro de configuração: nomeia o campo, nunca o valor (pode ser segredo). */
export class QueueBullmqConfigError extends Error {
  constructor(readonly field: string) {
    super(`queue_bullmq_config_invalid:${field}`);
    this.name = 'QueueBullmqConfigError';
  }
}

const QUEUE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function integer(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new QueueBullmqConfigError(field);
  }
  return value;
}

function validateConsumer(
  consumer: QueueBullmqConsumerOptions | undefined,
): QueueBullmqConsumerOptions {
  if (consumer === undefined) throw new QueueBullmqConfigError('consumer');
  return {
    concurrency: integer(consumer.concurrency, 'consumer.concurrency', 1, 64),
    lockDurationMs: integer(
      consumer.lockDurationMs,
      'consumer.lockDurationMs',
      1000,
      600_000,
    ),
    stalledIntervalMs: integer(
      consumer.stalledIntervalMs,
      'consumer.stalledIntervalMs',
      500,
      600_000,
    ),
    maxStalledCount: integer(
      consumer.maxStalledCount,
      'consumer.maxStalledCount',
      1,
      20,
    ),
    drainDeadlineMs: integer(
      consumer.drainDeadlineMs,
      'consumer.drainDeadlineMs',
      1,
      600_000,
    ),
  };
}

/** Valida a configuração no boot. Consumo exige bloco `consumer` completo. */
export function validateQueueBullmqOptions(
  options: QueueBullmqOptions,
  mode: { readonly consume: boolean },
): ValidatedQueueBullmqOptions {
  const { connection, retry } = options;
  if (typeof connection?.host !== 'string' || connection.host.length === 0) {
    throw new QueueBullmqConfigError('connection.host');
  }
  const port = integer(connection.port, 'connection.port', 1, 65535);
  if (
    connection.password !== undefined &&
    typeof connection.password !== 'string'
  ) {
    throw new QueueBullmqConfigError('connection.password');
  }
  const db =
    connection.db === undefined
      ? undefined
      : integer(connection.db, 'connection.db', 0, 15);

  const queueName = options.queueName ?? 'foundation-jobs';
  if (!QUEUE_NAME.test(queueName))
    throw new QueueBullmqConfigError('queueName');

  const globalMaxAttempts = integer(
    retry?.globalMaxAttempts,
    'retry.globalMaxAttempts',
    1,
    100,
  );
  const baseDelayMs = integer(
    retry?.baseDelayMs,
    'retry.baseDelayMs',
    1,
    3_600_000,
  );
  const maxDelayMs = integer(
    retry?.maxDelayMs,
    'retry.maxDelayMs',
    1,
    86_400_000,
  );
  if (baseDelayMs > maxDelayMs)
    throw new QueueBullmqConfigError('retry.baseDelayMs');
  const timeoutMs = integer(retry?.timeoutMs, 'retry.timeoutMs', 1, 86_400_000);

  return {
    connection: {
      host: connection.host,
      port,
      ...(connection.password === undefined
        ? {}
        : { password: connection.password }),
      ...(db === undefined ? {} : { db }),
    },
    queueName,
    maxPayloadBytes: integer(
      options.maxPayloadBytes ?? 65_536,
      'maxPayloadBytes',
      1024,
      1_048_576,
    ),
    retry: { globalMaxAttempts, baseDelayMs, maxDelayMs, timeoutMs },
    consumer: mode.consume
      ? validateConsumer(options.consumer)
      : validateOptionalConsumer(options.consumer),
  };
}

function validateOptionalConsumer(
  consumer: QueueBullmqConsumerOptions | undefined,
): QueueBullmqConsumerOptions {
  return consumer === undefined ? DEFAULT_CONSUMER : validateConsumer(consumer);
}

const DEFAULT_CONSUMER: QueueBullmqConsumerOptions = {
  concurrency: 4,
  lockDurationMs: 30_000,
  stalledIntervalMs: 30_000,
  maxStalledCount: 3,
  drainDeadlineMs: 30_000,
};
