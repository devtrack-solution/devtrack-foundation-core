import {
  ACTIVITY_COUNT_METRIC,
  ACTIVITY_DURATION_METRIC,
  ADMISSION_REJECTED_METRIC,
  EXPORT_DROPPED_METRIC,
  EXPORT_FAILED_METRIC,
  QUEUE_DEPTH_METRIC,
  RATELIMIT_REJECTED_METRIC,
  SIGNAL_METRIC_CATALOG,
  findSignalMetric,
} from './signal-catalog';
import {
  SIGNAL_ATTRIBUTE_ALLOWLIST,
  sanitizeMetricAttributes,
} from './signal-attributes';
import { createOperationSignals } from './operation-signals';
import type { MetricsRecorder, SignalAttributes } from './signal-contracts';

describe('signal metric catalog', () => {
  it('keeps names unique, prefixed and with catalog units', () => {
    const names = SIGNAL_METRIC_CATALOG.map((metric) => metric.name);
    expect(new Set(names).size).toBe(names.length);
    for (const metric of SIGNAL_METRIC_CATALOG) {
      expect(metric.name).toMatch(/^foundation\.[a-z_.]+$/);
      expect(metric.unit).toMatch(/^(\{[a-z]+\}|ms)$/);
      expect(metric.description.length).toBeGreaterThan(0);
    }
  });

  it('declares only attributes that the global allowlist accepts', () => {
    for (const metric of SIGNAL_METRIC_CATALOG) {
      for (const key of metric.attributes) {
        expect(SIGNAL_ATTRIBUTE_ALLOWLIST).toContain(key);
      }
    }
  });

  it('exposes the stable names used by other modules', () => {
    expect(ACTIVITY_COUNT_METRIC).toBe('foundation.activity.count');
    expect(ACTIVITY_DURATION_METRIC).toBe('foundation.activity.duration_ms');
    expect(findSignalMetric(ACTIVITY_DURATION_METRIC)?.unit).toBe('ms');
    expect(findSignalMetric(ADMISSION_REJECTED_METRIC)?.kind).toBe('counter');
    expect(findSignalMetric(RATELIMIT_REJECTED_METRIC)?.kind).toBe('counter');
    expect(findSignalMetric(QUEUE_DEPTH_METRIC)?.kind).toBe('gauge');
    expect(findSignalMetric(EXPORT_FAILED_METRIC)?.unit).toBe('{item}');
    expect(findSignalMetric(EXPORT_DROPPED_METRIC)?.unit).toBe('{span}');
  });
});

describe('sanitizeMetricAttributes', () => {
  it('keeps only the attributes declared for the metric', () => {
    const input: SignalAttributes = {
      'activity.name': 'contacts.import',
      'activity.outcome': 'succeeded',
      reason: 'capacity',
      'user.email': 'maria@example.test',
    };
    expect(sanitizeMetricAttributes(ACTIVITY_COUNT_METRIC, input)).toEqual({
      'activity.name': 'contacts.import',
      'activity.outcome': 'succeeded',
    });
    expect(sanitizeMetricAttributes(ADMISSION_REJECTED_METRIC, input)).toEqual({
      reason: 'capacity',
    });
  });

  it('returns no attributes for a metric outside the catalog', () => {
    expect(
      sanitizeMetricAttributes('foundation.unknown', { reason: 'capacity' }),
    ).toEqual({});
  });
});

describe('recordSaturation', () => {
  it('counts the rejection with the catalog attributes only', () => {
    const counts: { name: string; attributes?: SignalAttributes }[] = [];
    const metrics: MetricsRecorder = {
      count: (name, attributes) => counts.push({ name, attributes }),
      observe: () => undefined,
    };
    const signals = createOperationSignals({
      metrics,
      spans: { runSpan: (_name, _attributes, work) => work() },
      propagator: { inject: () => ({}), run: (_carrier, work) => work() },
      monotonicMs: () => 0,
    });
    signals.recordSaturation(ADMISSION_REJECTED_METRIC, {
      reason: 'capacity',
      'auth.token': 'abc',
    });
    expect(counts).toEqual([
      { name: ADMISSION_REJECTED_METRIC, attributes: { reason: 'capacity' } },
    ]);
  });
});
