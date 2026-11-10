import type {
  ActivityOutcome,
  ActivityRequest,
  MetricsRecorder,
  OperationSignals,
  SpanRecorder,
  TraceContextCarrier,
  TraceContextPropagator,
} from './signal-contracts';
import {
  sanitizeMetricAttributes,
  sanitizeSignalAttributes,
} from './signal-attributes';
import {
  ACTIVITY_COUNT_METRIC,
  ACTIVITY_DURATION_METRIC,
  type SaturationCounterName,
} from './signal-catalog';

export {
  ACTIVITY_COUNT_METRIC,
  ACTIVITY_DURATION_METRIC,
} from './signal-catalog';

/** Nome de atividade de baixa cardinalidade; valores fora do padrão viram `invalid`. */
const ACTIVITY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface OperationSignalsPorts {
  readonly metrics: MetricsRecorder;
  readonly spans: SpanRecorder;
  readonly propagator: TraceContextPropagator;
  /** Relógio monotônico em milissegundos, injetado (nunca lido aqui). */
  readonly monotonicMs: () => number;
}

function activityName(name: string): string {
  return ACTIVITY_NAME.test(name) ? name : 'invalid';
}

export function createOperationSignals(
  ports: OperationSignalsPorts,
): OperationSignals {
  const recordActivity = (
    name: string,
    outcome: ActivityOutcome,
    durationMs: number,
  ): void => {
    const attributes = {
      'activity.name': activityName(name),
      'activity.outcome': outcome,
    };
    ports.metrics.count(
      ACTIVITY_COUNT_METRIC,
      sanitizeMetricAttributes(ACTIVITY_COUNT_METRIC, attributes),
    );
    if (Number.isFinite(durationMs) && durationMs >= 0)
      ports.metrics.observe(
        ACTIVITY_DURATION_METRIC,
        durationMs,
        sanitizeMetricAttributes(ACTIVITY_DURATION_METRIC, attributes),
      );
  };

  return {
    recordActivity,
    recordSaturation(name: SaturationCounterName, attributes) {
      ports.metrics.count(name, sanitizeMetricAttributes(name, attributes));
    },
    async runActivity<T>(
      request: ActivityRequest,
      work: () => Promise<T>,
    ): Promise<T> {
      const name = activityName(request.name);
      const attributes = sanitizeSignalAttributes({
        ...request.attributes,
        'activity.name': name,
      });
      const started = ports.monotonicMs();
      let outcome: ActivityOutcome = 'failed';
      try {
        const result = await ports.propagator.run(request.traceContext, () =>
          ports.spans.runSpan(name, attributes, work),
        );
        outcome = 'succeeded';
        return result;
      } finally {
        recordActivity(name, outcome, ports.monotonicMs() - started);
      }
    },
    injectTraceContext(): TraceContextCarrier {
      return ports.propagator.inject();
    },
  };
}

/** Implementação sem efeito: executa o trabalho e preserva o resultado e os erros. */
export function createNoopOperationSignals(): OperationSignals {
  return createOperationSignals({
    metrics: { count: () => undefined, observe: () => undefined },
    spans: { runSpan: (_name, _attributes, work) => work() },
    propagator: {
      inject: () => ({}),
      run: (_carrier, work) => work(),
    },
    monotonicMs: () => 0,
  });
}
