import type { ClientRequest, IncomingMessage } from 'node:http';
import { metrics, type Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  createAllowListAttributesProcessor,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SIGNAL_ATTRIBUTE_ALLOWLIST } from '../../core/application/observability/signal-attributes';
import type {
  OpenTelemetryHostConfig,
  OpenTelemetryLimits,
} from './opentelemetry.config';
import {
  BoundedRedactingSpanProcessor,
  observeMetricExporter,
  observeSpanExporter,
  TelemetryCounters,
  type OpenTelemetryDiagnostics,
} from './opentelemetry.pipeline';
import { redactText } from './opentelemetry.redaction';
import {
  EXPORT_DROPPED_METRIC,
  EXPORT_FAILED_METRIC,
  findSignalMetric,
  QUEUE_DEPTH_METRIC,
} from '../../core/application/observability/signal-catalog';

export type { OpenTelemetryDiagnostics } from './opentelemetry.pipeline';

export interface OpenTelemetryRuntime {
  /** Envia o que estiver em fila; resolve `false` se o prazo estourar. Nunca rejeita. */
  forceFlush(): Promise<boolean>;
  /** Encerra os sinais dentro do prazo; resolve `false` se o prazo estourar. Nunca rejeita. */
  shutdown(): Promise<boolean>;
  /** Contadores de descarte e falha, sem dados de sinal. */
  diagnostics(): OpenTelemetryDiagnostics;
}

let current: OpenTelemetryRuntime | undefined;

/**
 * Espera `work` por no máximo `deadlineMs`. O temporizador não é `unref`: o
 * prazo precisa valer mesmo sem outra atividade no event loop.
 */
function withDeadline(
  work: Promise<unknown>,
  deadlineMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  const finished = work.then(
    () => true as const,
    () => false as const,
  );
  return Promise.race([finished, deadline]).finally(() => clearTimeout(timer));
}

/** Remove a query string do alvo HTTP antes que a instrumentação o registre. */
function httpRequestHook(
  span: Span,
  request: ClientRequest | IncomingMessage,
): void {
  if ('url' in request && typeof request.url === 'string') {
    const path = request.url.split('?')[0] ?? '';
    span.setAttribute('http.target', redactText(path));
  }
}

const HEALTH_SCOPE = 'foundation-api';

/**
 * Publica como métricas OTel os contadores de `diagnostics()`. São observáveis:
 * o SDK lê o valor na coleta, sem escrita extra no caminho de exportação.
 * Unidade e descrição vêm do catálogo; atributo `signal` identifica a origem.
 */
function registerExportHealthMetrics(counters: TelemetryCounters): void {
  const meter = metrics.getMeter(HEALTH_SCOPE);
  const describe = (name: string) => {
    const definition = findSignalMetric(name);
    return definition === undefined
      ? {}
      : { unit: definition.unit, description: definition.description };
  };

  const failed = meter.createObservableCounter(
    EXPORT_FAILED_METRIC,
    describe(EXPORT_FAILED_METRIC),
  );
  failed.addCallback((result) => {
    const snapshot = counters.snapshot();
    result.observe(snapshot.spansFailed, { signal: 'traces' });
    result.observe(snapshot.metricExportsFailed, { signal: 'metrics' });
  });

  const dropped = meter.createObservableCounter(
    EXPORT_DROPPED_METRIC,
    describe(EXPORT_DROPPED_METRIC),
  );
  dropped.addCallback((result) => {
    result.observe(counters.snapshot().spansDropped, { signal: 'traces' });
  });

  const depth = meter.createObservableGauge(
    QUEUE_DEPTH_METRIC,
    describe(QUEUE_DEPTH_METRIC),
  );
  depth.addCallback((result) => {
    result.observe(counters.snapshot().spansQueued, { signal: 'traces' });
  });
}

/**
 * Inicia o SDK único do processo. Chamadas repetidas devolvem o mesmo runtime:
 * um SDK por módulo é proibido. Exportação OTLP/HTTP usa `OTEL_EXPORTER_OTLP_ENDPOINT`.
 */
export function startOpenTelemetry(
  host: OpenTelemetryHostConfig,
  limits: OpenTelemetryLimits,
): OpenTelemetryRuntime {
  if (current !== undefined) return current;
  const counters = new TelemetryCounters(limits.spanQueueSize);

  const traceExporter = new OTLPTraceExporter({
    timeoutMillis: limits.exportTimeoutMs,
  });
  observeSpanExporter(traceExporter, counters);
  const batchProcessor = new BatchSpanProcessor({
    exporter: traceExporter,
    maxQueueSize: limits.spanQueueSize,
    maxExportBatchSize: limits.spanBatchSize,
    scheduledDelayMillis: limits.spanScheduledDelayMs,
    exportTimeoutMillis: limits.exportTimeoutMs,
  });
  const spanProcessor = new BoundedRedactingSpanProcessor(
    batchProcessor,
    counters,
  );

  const metricExporter = new OTLPMetricExporter({
    timeoutMillis: limits.exportTimeoutMs,
  });
  observeMetricExporter(metricExporter, counters);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: limits.metricExportIntervalMs,
    exportTimeoutMillis: limits.exportTimeoutMs,
  });

  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': host.serviceName,
      'service.version': host.serviceVersion,
      'deployment.environment': host.deploymentEnvironment,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(limits.samplingRatio),
    }),
    spanLimits: {
      attributeCountLimit: limits.spanAttributeCountLimit,
      attributePerEventCountLimit: limits.eventAttributeCountLimit,
      attributePerLinkCountLimit: limits.linkAttributeCountLimit,
      attributeValueLengthLimit: limits.attributeValueLengthLimit,
    },
    spanProcessors: [spanProcessor],
    metricReaders: [metricReader],
    views: [
      {
        instrumentName: '*',
        attributesProcessors: [
          createAllowListAttributesProcessor([...SIGNAL_ATTRIBUTE_ALLOWLIST]),
        ],
        aggregationCardinalityLimit: limits.metricCardinalityLimit,
      },
    ],
    instrumentations: [
      new HttpInstrumentation({ requestHook: httpRequestHook }),
      new ExpressInstrumentation(),
    ],
  });
  sdk.start();
  registerExportHealthMetrics(counters);

  let shutdownResult: Promise<boolean> | undefined;
  const runtime: OpenTelemetryRuntime = {
    forceFlush: () =>
      withDeadline(
        Promise.all([spanProcessor.forceFlush(), metricReader.forceFlush()]),
        limits.shutdownDeadlineMs,
      ),
    shutdown: () => {
      shutdownResult ??= withDeadline(
        Promise.resolve().then(() => sdk.shutdown()),
        limits.shutdownDeadlineMs,
      );
      return shutdownResult;
    },
    diagnostics: () => counters.snapshot(),
  };
  current = runtime;
  return runtime;
}

/**
 * Encerramento opt-in: SIGTERM e SIGINT chamam `shutdown` (com prazo) e saem
 * com código 0. Sem esta chamada o processo não registra handler algum.
 */
export function registerSignalShutdown(
  runtime: OpenTelemetryRuntime,
  processRef: NodeJS.Process = process,
): void {
  const onSignal = (): void => {
    void runtime.shutdown().finally(() => processRef.exit(0));
  };
  processRef.on('SIGTERM', onSignal);
  processRef.on('SIGINT', onSignal);
}
