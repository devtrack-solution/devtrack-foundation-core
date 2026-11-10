import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Counter,
  type Histogram,
} from '@opentelemetry/api';
import { createOperationSignals } from '../../core/application/observability/operation-signals';
import { findSignalMetric } from '../../core/application/observability/signal-catalog';
import type {
  MetricsRecorder,
  OperationSignals,
  SpanRecorder,
  TraceContextCarrier,
  TraceContextPropagator,
} from '../../core/application/observability/signal-contracts';

const SCOPE = 'foundation-api';
/** Apenas cabeçalhos W3C de trace: baggage e demais cabeçalhos ficam de fora. */
const CARRIED_KEYS = ['traceparent', 'tracestate'] as const;

function onlyCarried(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CARRIED_KEYS) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

/** Unidade e descrição vêm do catálogo; instrumento fora dele usa só o nome. */
function instrumentOptions(name: string): {
  unit?: string;
  description?: string;
} {
  const definition = findSignalMetric(name);
  return definition === undefined
    ? {}
    : { unit: definition.unit, description: definition.description };
}

const metricsRecorder = (): MetricsRecorder => {
  const meter = metrics.getMeter(SCOPE);
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  return {
    count(name, attributes) {
      let counter = counters.get(name);
      if (counter === undefined) {
        counter = meter.createCounter(name, instrumentOptions(name));
        counters.set(name, counter);
      }
      counter.add(1, attributes);
    },
    observe(name, value, attributes) {
      let histogram = histograms.get(name);
      if (histogram === undefined) {
        histogram = meter.createHistogram(name, instrumentOptions(name));
        histograms.set(name, histogram);
      }
      histogram.record(value, attributes);
    },
  };
};

const spanRecorder = (): SpanRecorder => ({
  runSpan(name, attributes, work) {
    return trace
      .getTracer(SCOPE)
      .startActiveSpan(
        name,
        { kind: SpanKind.INTERNAL, attributes },
        async (span) => {
          try {
            return await work();
          } catch (error) {
            // Mensagem genérica: exceções podem carregar dados de entrada.
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'activity_failed',
            });
            throw error;
          } finally {
            span.end();
          }
        },
      );
  },
});

const traceContextPropagator = (): TraceContextPropagator => ({
  inject(): TraceContextCarrier {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return onlyCarried(carrier);
  },
  run(carrier, work) {
    const parent =
      carrier === undefined
        ? ROOT_CONTEXT
        : propagation.extract(ROOT_CONTEXT, onlyCarried(carrier));
    return context.with(parent, work);
  },
});

/** Sinais sobre `@opentelemetry/api`; exige `startOpenTelemetry` antes para exportar. */
export function createOpenTelemetryOperationSignals(): OperationSignals {
  return createOperationSignals({
    metrics: metricsRecorder(),
    spans: spanRecorder(),
    propagator: traceContextPropagator(),
    monotonicMs: () => performance.now(),
  });
}
