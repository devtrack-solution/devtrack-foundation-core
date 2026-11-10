import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace';
import {
  BoundedRedactingSpanProcessor,
  observeSpanExporter,
  TelemetryCounters,
} from './opentelemetry.pipeline';

function fakeSpan(attributes: Record<string, string>): ReadableSpan {
  return { name: 'span', attributes } as unknown as ReadableSpan;
}

function recordingProcessor(): SpanProcessor & { ended: ReadableSpan[] } {
  const ended: ReadableSpan[] = [];
  return {
    ended,
    onStart: () => undefined,
    onEnd: (span: ReadableSpan) => {
      ended.push(span);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

describe('bounded span pipeline', () => {
  it('drops spans beyond the queue capacity and counts each drop', () => {
    const counters = new TelemetryCounters(3);
    const inner = recordingProcessor();
    const processor = new BoundedRedactingSpanProcessor(inner, counters);

    for (let index = 0; index < 10; index += 1) processor.onEnd(fakeSpan({}));

    expect(inner.ended).toHaveLength(3);
    expect(counters.snapshot()).toMatchObject({
      spansAccepted: 3,
      spansDropped: 7,
      spansQueued: 3,
    });
  });

  it('releases queue positions when an export completes, successful or not', () => {
    const counters = new TelemetryCounters(2);
    const codes = [0, 1];
    const exporter: SpanExporter = {
      export(_spans, resultCallback) {
        resultCallback({ code: codes.shift() ?? 0 });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    observeSpanExporter(exporter, counters);
    counters.tryReserve();
    counters.tryReserve();
    exporter.export([fakeSpan({}), fakeSpan({})], () => undefined);
    expect(counters.snapshot()).toMatchObject({
      spansQueued: 0,
      spansFailed: 0,
    });

    counters.tryReserve();
    counters.tryReserve();
    exporter.export([fakeSpan({}), fakeSpan({})], () => undefined);
    expect(counters.snapshot()).toMatchObject({
      spansQueued: 0,
      spansFailed: 2,
    });
  });

  it('redacts attributes before spans reach the inner processor', () => {
    const counters = new TelemetryCounters(5);
    const inner = recordingProcessor();
    new BoundedRedactingSpanProcessor(inner, counters).onEnd(
      fakeSpan({ authorization: 'Bearer abc', route: '/a?token=1' }),
    );
    expect(inner.ended[0]?.attributes).toEqual({ route: '/a' });
  });
});
