import {
  OpenTelemetryConfigError,
  readOpenTelemetryLimits,
} from './opentelemetry.config';

describe('OpenTelemetry limits configuration', () => {
  it('uses documented safe defaults when nothing is set', () => {
    expect(readOpenTelemetryLimits({})).toEqual({
      spanQueueSize: 2048,
      spanBatchSize: 512,
      spanScheduledDelayMs: 5000,
      exportTimeoutMs: 10000,
      metricExportIntervalMs: 60000,
      metricCardinalityLimit: 2000,
      spanAttributeCountLimit: 32,
      eventAttributeCountLimit: 16,
      linkAttributeCountLimit: 16,
      attributeValueLengthLimit: 128,
      samplingRatio: 0.1,
      shutdownDeadlineMs: 5000,
      shutdownOnSignals: false,
    });
  });

  it('accepts values inside the range, including the bounds', () => {
    const limits = readOpenTelemetryLimits({
      FOUNDATION_OTEL_SPAN_QUEUE_SIZE: '64',
      FOUNDATION_OTEL_SPAN_BATCH_SIZE: '64',
      FOUNDATION_OTEL_SAMPLING_RATIO: '0',
      FOUNDATION_OTEL_SHUTDOWN_ON_SIGNALS: 'true',
    });
    expect(limits.spanQueueSize).toBe(64);
    expect(limits.spanBatchSize).toBe(64);
    expect(limits.samplingRatio).toBe(0);
    expect(limits.shutdownOnSignals).toBe(true);
    expect(
      readOpenTelemetryLimits({ FOUNDATION_OTEL_SAMPLING_RATIO: '1' })
        .samplingRatio,
    ).toBe(1);
    expect(
      readOpenTelemetryLimits({ FOUNDATION_OTEL_SAMPLING_RATIO: '0.25' })
        .samplingRatio,
    ).toBe(0.25);
  });

  it.each([
    ['FOUNDATION_OTEL_SPAN_QUEUE_SIZE', '63'],
    ['FOUNDATION_OTEL_SPAN_QUEUE_SIZE', '16385'],
    ['FOUNDATION_OTEL_EXPORT_TIMEOUT_MS', '499'],
    ['FOUNDATION_OTEL_SHUTDOWN_DEADLINE_MS', '60001'],
    ['FOUNDATION_OTEL_METRIC_CARDINALITY_LIMIT', '9'],
    ['FOUNDATION_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT', '0'],
    ['FOUNDATION_OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT', 'abc'],
    ['FOUNDATION_OTEL_SAMPLING_RATIO', '1.5'],
    ['FOUNDATION_OTEL_SAMPLING_RATIO', '-0.1'],
    ['FOUNDATION_OTEL_SHUTDOWN_ON_SIGNALS', 'yes'],
  ])('rejects %s=%s naming only the variable', (variable, value) => {
    const attempt = () => readOpenTelemetryLimits({ [variable]: value });
    expect(attempt).toThrow(OpenTelemetryConfigError);
    expect(attempt).toThrow(variable);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('rejects a batch larger than the queue, naming the batch variable', () => {
    expect(() =>
      readOpenTelemetryLimits({
        FOUNDATION_OTEL_SPAN_QUEUE_SIZE: '100',
        FOUNDATION_OTEL_SPAN_BATCH_SIZE: '101',
      }),
    ).toThrow('FOUNDATION_OTEL_SPAN_BATCH_SIZE');
  });
});
