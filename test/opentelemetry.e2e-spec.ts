import fs from 'node:fs';
import {
  allMetrics,
  allSpans,
  attribute,
  post,
  prepareInstrumentationFiles,
  ROOT,
  spawnChild,
  startCollector,
  startProbe,
  PROBE_APP,
  TS_NODE,
} from './fixtures/otel-harness';

const SECRET = 'secret-token-value';
const EMAIL = 'maria@example.test';

describe('native OpenTelemetry', () => {
  let files: ReturnType<typeof prepareInstrumentationFiles>;

  beforeAll(() => {
    files = prepareInstrumentationFiles();
  });

  afterAll(() => {
    fs.rmSync(files.tempDir, { recursive: true, force: true });
  });

  it('exports the request span, the async activity in the same trace, and the activity metric', async () => {
    const collector = await startCollector();
    try {
      const probe = await startProbe(PROBE_APP, {
        FOUNDATION_TEST_INSTRUMENTATION: files.on,
        FOUNDATION_SERVICE_NAME: 'foundation-probe',
        FOUNDATION_SERVICE_VERSION: '1.2.3-test',
        FOUNDATION_DEPLOYMENT_ENVIRONMENT: 'test',
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        FOUNDATION_OTEL_SAMPLING_RATIO: '1',
      });

      const accepted = await post(probe.port, '/probe', {
        authorization: `Bearer ${SECRET}`,
        'x-user-email': EMAIL,
      });
      expect(accepted).toEqual({ status: 201, body: { accepted: true } });

      const finished = await post(probe.port, '/finish');
      expect(finished.status).toBe(201);
      expect((finished.body as { flushed: boolean }).flushed).toBe(true);
      probe.child.kill('SIGTERM');
      await probe.exited;

      const resource = collector.received
        .flatMap((item) => item.body.resourceSpans ?? [])
        .map((rs) => rs.resource.attributes);
      expect(resource.length).toBeGreaterThan(0);
      for (const attributes of resource) {
        expect(attribute(attributes, 'service.name')).toBe('foundation-probe');
        expect(attribute(attributes, 'service.version')).toBe('1.2.3-test');
        expect(attribute(attributes, 'deployment.environment')).toBe('test');
      }

      expect(collector.received.map((item) => item.path)).toEqual(
        expect.arrayContaining(['/v1/traces', '/v1/metrics']),
      );
      expect(
        collector.received.every((item) =>
          item.contentType.startsWith('application/json'),
        ),
      ).toBe(true);

      const spans = allSpans(collector.received);
      const request = spans.find(
        (span) => span.kind === 2 && span.name.includes('/probe'),
      );
      const activity = spans.find((span) => span.name === 'probe.activity');
      expect(request).toBeDefined();
      expect(activity).toBeDefined();
      expect(activity?.traceId).toBe(request?.traceId);
      const byId = new Map(spans.map((span) => [span.spanId, span]));
      let cursor = activity?.parentSpanId;
      let depth = 0;
      while (cursor !== undefined && cursor !== request?.spanId && depth < 8) {
        cursor = byId.get(cursor)?.parentSpanId;
        depth += 1;
      }
      expect(cursor).toBe(request?.spanId);

      const metrics = allMetrics(collector.received);
      const count = metrics.find(
        (metric) => metric.name === 'foundation.activity.count',
      );
      const point = count?.sum?.dataPoints.find(
        (dp) => attribute(dp.attributes, 'activity.outcome') === 'succeeded',
      );
      expect(Number(point?.asInt ?? point?.asDouble)).toBe(1);
      expect(attribute(point?.attributes, 'activity.name')).toBe(
        'probe.activity',
      );
      expect(
        metrics.some(
          (metric) => metric.name === 'foundation.activity.duration_ms',
        ),
      ).toBe(true);

      const serialized = JSON.stringify(
        collector.received.map((item) => item.body),
      );
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(EMAIL);
      expect(attribute(activity?.attributes, 'user.email')).toBeUndefined();
      expect(attribute(activity?.attributes, 'auth.token')).toBeUndefined();
    } finally {
      await collector.close();
    }
  }, 120_000);

  it('keeps the disabled path free of OpenTelemetry modules and no-op signals working', async () => {
    const generated = fs.readFileSync(files.off, 'utf8');
    expect(generated).not.toMatch(/import\s|require\(|opentelemetry/i);

    const script = `
      require('./src/composition/instrumentation.generated');
      require('./src/app.module');
      const { createNoopOperationSignals } = require('./src/core/application/observability/operation-signals');
      const signals = createNoopOperationSignals();
      signals.runActivity({ name: 'noop.activity' }, async () => 42).then((value) => {
        const otel = Object.keys(require.cache).filter((file) => /[\\\\/]@opentelemetry[\\\\/]/.test(file));
        console.log(JSON.stringify({ value, context: signals.injectTraceContext(), otel }));
      });
    `;
    const child = spawnChild(['-r', TS_NODE, '-e', script], {
      FOUNDATION_TEST_INSTRUMENTATION: '',
    });
    const code = await child.exited;
    expect(code).toBe(0);
    expect(JSON.parse(child.output().trim().split('\n').pop() ?? '{}')).toEqual(
      {
        value: 42,
        context: {},
        otel: [],
      },
    );
    void ROOT;
  }, 120_000);
});
