/**
 * Configuração de identidade do processo vinda do host (ambiente). Nunca vem do
 * perfil de composição, que é versionado e não contém dados de implantação.
 */
export interface OpenTelemetryHostConfig {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly deploymentEnvironment: string;
}

/**
 * Limites operacionais da telemetria. Todos têm padrão seguro e faixa validada
 * no boot; valor fora da faixa impede a inicialização.
 */
export interface OpenTelemetryLimits {
  readonly spanQueueSize: number;
  readonly spanBatchSize: number;
  readonly spanScheduledDelayMs: number;
  readonly exportTimeoutMs: number;
  readonly metricExportIntervalMs: number;
  readonly metricCardinalityLimit: number;
  readonly spanAttributeCountLimit: number;
  readonly eventAttributeCountLimit: number;
  readonly linkAttributeCountLimit: number;
  readonly attributeValueLengthLimit: number;
  readonly samplingRatio: number;
  readonly shutdownDeadlineMs: number;
  readonly shutdownOnSignals: boolean;
}

export const OPEN_TELEMETRY_ENV = {
  serviceName: 'FOUNDATION_SERVICE_NAME',
  serviceVersion: 'FOUNDATION_SERVICE_VERSION',
  deploymentEnvironment: 'FOUNDATION_DEPLOYMENT_ENVIRONMENT',
} as const;

interface IntegerLimitSpec {
  readonly env: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

const INTEGER_LIMITS: {
  readonly [
    K in Exclude<
      keyof OpenTelemetryLimits,
      'samplingRatio' | 'shutdownOnSignals'
    >
  ]: IntegerLimitSpec;
} = {
  spanQueueSize: {
    env: 'FOUNDATION_OTEL_SPAN_QUEUE_SIZE',
    min: 64,
    max: 16384,
    default: 2048,
  },
  spanBatchSize: {
    env: 'FOUNDATION_OTEL_SPAN_BATCH_SIZE',
    min: 1,
    max: 4096,
    default: 512,
  },
  spanScheduledDelayMs: {
    env: 'FOUNDATION_OTEL_SPAN_SCHEDULED_DELAY_MS',
    min: 100,
    max: 60000,
    default: 5000,
  },
  exportTimeoutMs: {
    env: 'FOUNDATION_OTEL_EXPORT_TIMEOUT_MS',
    min: 500,
    max: 60000,
    default: 10000,
  },
  metricExportIntervalMs: {
    env: 'FOUNDATION_OTEL_METRIC_EXPORT_INTERVAL_MS',
    min: 1000,
    max: 300000,
    default: 60000,
  },
  metricCardinalityLimit: {
    env: 'FOUNDATION_OTEL_METRIC_CARDINALITY_LIMIT',
    min: 10,
    max: 100000,
    default: 2000,
  },
  spanAttributeCountLimit: {
    env: 'FOUNDATION_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT',
    min: 1,
    max: 256,
    default: 32,
  },
  eventAttributeCountLimit: {
    env: 'FOUNDATION_OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT',
    min: 1,
    max: 128,
    default: 16,
  },
  linkAttributeCountLimit: {
    env: 'FOUNDATION_OTEL_LINK_ATTRIBUTE_COUNT_LIMIT',
    min: 1,
    max: 128,
    default: 16,
  },
  attributeValueLengthLimit: {
    env: 'FOUNDATION_OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT',
    min: 16,
    max: 4096,
    default: 128,
  },
  shutdownDeadlineMs: {
    env: 'FOUNDATION_OTEL_SHUTDOWN_DEADLINE_MS',
    min: 100,
    max: 60000,
    default: 5000,
  },
};

export const OPEN_TELEMETRY_SAMPLING_ENV = 'FOUNDATION_OTEL_SAMPLING_RATIO';
export const OPEN_TELEMETRY_SAMPLING_DEFAULT = 0.1;
export const OPEN_TELEMETRY_SHUTDOWN_ON_SIGNALS_ENV =
  'FOUNDATION_OTEL_SHUTDOWN_ON_SIGNALS';

const HOST_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const INTEGER_TEXT = /^\d{1,9}$/;
const RATIO_TEXT = /^(?:0|1|0?\.\d{1,6}|1\.0{1,6})$/;

/**
 * Erro de configuração. A mensagem cita apenas o nome da variável, nunca o
 * valor recebido (que pode ser um segredo digitado no lugar errado).
 */
export class OpenTelemetryConfigError extends Error {
  constructor(readonly variable: string) {
    super(`Invalid OpenTelemetry configuration: ${variable}`);
    this.name = 'OpenTelemetryConfigError';
  }
}

export function readOpenTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenTelemetryHostConfig {
  const read = (field: keyof OpenTelemetryHostConfig): string => {
    const variable = OPEN_TELEMETRY_ENV[field];
    const value = env[variable];
    if (value === undefined || !HOST_VALUE.test(value))
      throw new OpenTelemetryConfigError(variable);
    return value;
  };
  return {
    serviceName: read('serviceName'),
    serviceVersion: read('serviceVersion'),
    deploymentEnvironment: read('deploymentEnvironment'),
  };
}

function readInteger(env: NodeJS.ProcessEnv, spec: IntegerLimitSpec): number {
  const raw = env[spec.env];
  if (raw === undefined || raw.trim() === '') return spec.default;
  const text = raw.trim();
  if (!INTEGER_TEXT.test(text)) throw new OpenTelemetryConfigError(spec.env);
  const value = Number(text);
  if (value < spec.min || value > spec.max)
    throw new OpenTelemetryConfigError(spec.env);
  return value;
}

/**
 * Lê os limites do ambiente. Ausente ou vazio usa o padrão; fora da faixa ou
 * em formato inválido lança `OpenTelemetryConfigError` citando o nome da variável.
 */
export function readOpenTelemetryLimits(
  env: NodeJS.ProcessEnv = process.env,
): OpenTelemetryLimits {
  const integers = {
    spanQueueSize: readInteger(env, INTEGER_LIMITS.spanQueueSize),
    spanBatchSize: readInteger(env, INTEGER_LIMITS.spanBatchSize),
    spanScheduledDelayMs: readInteger(env, INTEGER_LIMITS.spanScheduledDelayMs),
    exportTimeoutMs: readInteger(env, INTEGER_LIMITS.exportTimeoutMs),
    metricExportIntervalMs: readInteger(
      env,
      INTEGER_LIMITS.metricExportIntervalMs,
    ),
    metricCardinalityLimit: readInteger(
      env,
      INTEGER_LIMITS.metricCardinalityLimit,
    ),
    spanAttributeCountLimit: readInteger(
      env,
      INTEGER_LIMITS.spanAttributeCountLimit,
    ),
    eventAttributeCountLimit: readInteger(
      env,
      INTEGER_LIMITS.eventAttributeCountLimit,
    ),
    linkAttributeCountLimit: readInteger(
      env,
      INTEGER_LIMITS.linkAttributeCountLimit,
    ),
    attributeValueLengthLimit: readInteger(
      env,
      INTEGER_LIMITS.attributeValueLengthLimit,
    ),
    shutdownDeadlineMs: readInteger(env, INTEGER_LIMITS.shutdownDeadlineMs),
  };
  if (integers.spanBatchSize > integers.spanQueueSize)
    throw new OpenTelemetryConfigError(INTEGER_LIMITS.spanBatchSize.env);
  return {
    ...integers,
    samplingRatio: readRatio(env),
    shutdownOnSignals: readFlag(env),
  };
}

function readRatio(env: NodeJS.ProcessEnv): number {
  const raw = env[OPEN_TELEMETRY_SAMPLING_ENV];
  if (raw === undefined || raw.trim() === '')
    return OPEN_TELEMETRY_SAMPLING_DEFAULT;
  const text = raw.trim();
  if (!RATIO_TEXT.test(text))
    throw new OpenTelemetryConfigError(OPEN_TELEMETRY_SAMPLING_ENV);
  return Number(text);
}

function readFlag(env: NodeJS.ProcessEnv): boolean {
  const raw = env[OPEN_TELEMETRY_SHUTDOWN_ON_SIGNALS_ENV];
  if (raw === undefined || raw.trim() === '') return false;
  if (raw.trim() === 'true') return true;
  if (raw.trim() === 'false') return false;
  throw new OpenTelemetryConfigError(OPEN_TELEMETRY_SHUTDOWN_ON_SIGNALS_ENV);
}
