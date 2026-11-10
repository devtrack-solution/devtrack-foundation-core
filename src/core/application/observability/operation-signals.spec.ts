import {
  createNoopOperationSignals,
  createOperationSignals,
} from './operation-signals';
import { sanitizeSignalAttributes } from './signal-attributes';
import type {
  MetricsRecorder,
  SignalAttributes,
  SpanRecorder,
  TraceContextCarrier,
  TraceContextPropagator,
} from './signal-contracts';

function recorders() {
  const counts: { name: string; attributes?: SignalAttributes }[] = [];
  const observations: {
    name: string;
    value: number;
    attributes?: SignalAttributes;
  }[] = [];
  const spans: { name: string; attributes: SignalAttributes }[] = [];
  const carriers: (TraceContextCarrier | undefined)[] = [];
  const metrics: MetricsRecorder = {
    count: (name, attributes) => counts.push({ name, attributes }),
    observe: (name, value, attributes) =>
      observations.push({ name, value, attributes }),
  };
  const spanRecorder: SpanRecorder = {
    runSpan: (name, attributes, work) => {
      spans.push({ name, attributes });
      return work();
    },
  };
  const propagator: TraceContextPropagator = {
    inject: () => ({ traceparent: '00-abc-def-01' }),
    run: (carrier, work) => {
      carriers.push(carrier);
      return work();
    },
  };
  let now = 100;
  const signals = createOperationSignals({
    metrics,
    spans: spanRecorder,
    propagator,
    monotonicMs: () => {
      now += 25;
      return now;
    },
  });
  return { counts, observations, spans, carriers, signals };
}

describe('operation signals contracts', () => {
  it('drops attributes outside the allowlist and values that look personal or secret', () => {
    expect(
      sanitizeSignalAttributes({
        'activity.name': 'contacts.import',
        'user.email': 'maria@example.test',
        'auth.token': 'abc',
        'http.route': '/contacts/:id',
        'operation.kind': 'read',
        'activity.outcome': 'Bearer secret',
      }),
    ).toEqual({
      'activity.name': 'contacts.import',
      'http.route': '/contacts/:id',
      'operation.kind': 'read',
    });
  });

  it('caps value length and rejects non-finite numbers', () => {
    expect(
      sanitizeSignalAttributes({ 'activity.name': 'x'.repeat(65) }),
    ).toEqual({});
  });

  it('records counts and durations with sanitized attributes only', () => {
    const { counts, observations, signals } = recorders();
    signals.recordActivity('contacts.import', 'succeeded', 40);
    expect(counts).toEqual([
      {
        name: 'foundation.activity.count',
        attributes: {
          'activity.name': 'contacts.import',
          'activity.outcome': 'succeeded',
        },
      },
    ]);
    expect(observations).toEqual([
      {
        name: 'foundation.activity.duration_ms',
        value: 40,
        attributes: {
          'activity.name': 'contacts.import',
          'activity.outcome': 'succeeded',
        },
      },
    ]);
  });

  it('replaces unbounded activity names with a stable value', () => {
    const { counts, signals } = recorders();
    signals.recordActivity('user@example.test', 'failed', 1);
    expect(counts[0].attributes).toMatchObject({ 'activity.name': 'invalid' });
  });

  it('runs an activity inside the extracted context and records success', async () => {
    const { counts, spans, carriers, signals } = recorders();
    const result = await signals.runActivity(
      {
        name: 'probe.activity',
        traceContext: { traceparent: '00-abc-def-01' },
        attributes: {
          'user.email': 'maria@example.test',
          'operation.kind': 'probe',
        },
      },
      () => Promise.resolve('done'),
    );
    expect(result).toBe('done');
    expect(carriers).toEqual([{ traceparent: '00-abc-def-01' }]);
    expect(spans).toEqual([
      {
        name: 'probe.activity',
        attributes: {
          'activity.name': 'probe.activity',
          'operation.kind': 'probe',
        },
      },
    ]);
    expect(counts[0].attributes).toMatchObject({
      'activity.outcome': 'succeeded',
    });
  });

  it('records a failed outcome and rethrows the original error', async () => {
    const { counts, signals } = recorders();
    const failure = new Error('boom');
    await expect(
      signals.runActivity({ name: 'probe.activity' }, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(counts[0].attributes).toMatchObject({
      'activity.outcome': 'failed',
    });
  });

  it('injects the trace context used to schedule an envelope', () => {
    const { signals } = recorders();
    expect(signals.injectTraceContext()).toEqual({
      traceparent: '00-abc-def-01',
    });
  });

  it('no-op signals keep results and errors but export nothing', async () => {
    const signals = createNoopOperationSignals();
    await expect(
      signals.runActivity({ name: 'x' }, () => Promise.resolve(1)),
    ).resolves.toBe(1);
    await expect(
      signals.runActivity({ name: 'x' }, () =>
        Promise.reject(new Error('fail')),
      ),
    ).rejects.toThrow('fail');
    expect(signals.injectTraceContext()).toEqual({});
    expect(() => signals.recordActivity('x', 'succeeded', 1)).not.toThrow();
  });
});
