import fs from 'node:fs';
import { SIGNAL_METRIC_CATALOG } from '../src/core/application/observability/signal-catalog';
import {
  allMetrics,
  attribute,
  PROBE_APP,
  post,
  prepareInstrumentationFiles,
  spawnChild,
  startCollector,
  startProbe,
  TS_NODE,
  type OtlpMetric,
} from './fixtures/otel-harness';

const SECRET = 'secret-token-value';
const EMAIL = 'maria@example.test';
const PROBE_BODY = 'probe-body-must-not-leak';

const catalogByName = new Map(
  SIGNAL_METRIC_CATALOG.map((definition) => [definition.name, definition]),
);

describe('OpenTelemetry profiles: catalog and absent capability', () => {
  let files: ReturnType<typeof prepareInstrumentationFiles>;

  beforeAll(() => {
    files = prepareInstrumentationFiles();
  });

  afterAll(() => {
    fs.rmSync(files.tempDir, { recursive: true, force: true });
  });

  it('exports catalog metrics with catalog units and only allowed attributes', async () => {
    const collector = await startCollector();
    try {
      const probe = await startProbe(PROBE_APP, {
        FOUNDATION_TEST_INSTRUMENTATION: files.on,
        FOUNDATION_SERVICE_NAME: 'foundation-profiles',
        FOUNDATION_SERVICE_VERSION: '1.0.0-test',
        FOUNDATION_DEPLOYMENT_ENVIRONMENT: 'test',
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        FOUNDATION_OTEL_SAMPLING_RATIO: '1',
        FOUNDATION_OTEL_METRIC_EXPORT_INTERVAL_MS: '1000',
        FOUNDATION_OTEL_EXPORT_TIMEOUT_MS: '500',
      });

      expect(
        await post(probe.port, '/probe', { authorization: `Bearer ${SECRET}` }),
      ).toEqual({ status: 201, body: { accepted: true } });
      const finished = await post(probe.port, '/finish');
      expect((finished.body as { flushed: boolean }).flushed).toBe(true);
      probe.child.kill('SIGTERM');
      await probe.exited;

      const metrics = allMetrics(collector.received);
      const byName = new Map<string, OtlpMetric>(
        metrics.map((metric) => [metric.name, metric]),
      );

      // Nomes e unidades do catálogo chegam ao Collector sem alteração.
      const expectedNames = [
        'foundation.activity.count',
        'foundation.activity.duration_ms',
        'foundation.admission.rejected',
        'foundation.queue.depth',
        'foundation.export.failed',
        'foundation.export.dropped',
      ];
      for (const name of expectedNames) {
        const definition = catalogByName.get(name);
        expect(definition).toBeDefined();
        const received = byName.get(name);
        expect(received).toBeDefined();
        expect(received?.unit).toBe(definition?.unit);
      }

      // Cada ponto usa só os atributos declarados para a sua métrica.
      for (const metric of metrics) {
        const definition = catalogByName.get(metric.name);
        if (definition === undefined) continue;
        const points = [
          ...(metric.sum?.dataPoints ?? []),
          ...(metric.gauge?.dataPoints ?? []),
          ...(metric.histogram?.dataPoints ?? []),
        ];
        expect(points.length).toBeGreaterThan(0);
        for (const point of points) {
          for (const item of point.attributes ?? []) {
            expect(definition.attributes).toContain(item.key);
          }
        }
      }

      const activityOutcomes = (
        byName.get('foundation.activity.count')?.sum?.dataPoints ?? []
      ).map((point) => attribute(point.attributes, 'activity.outcome'));
      expect(activityOutcomes).toEqual(
        expect.arrayContaining(['succeeded', 'failed']),
      );

      const rejected = byName.get('foundation.admission.rejected');
      const rejectedPoint = rejected?.sum?.dataPoints.find(
        (point) => attribute(point.attributes, 'reason') === 'capacity',
      );
      expect(Number(rejectedPoint?.asInt ?? rejectedPoint?.asDouble)).toBe(1);

      // Saúde do exportador: sem falhas nem descartes neste cenário saudável.
      for (const name of [
        'foundation.export.failed',
        'foundation.export.dropped',
      ]) {
        const point = byName
          .get(name)
          ?.sum?.dataPoints.find(
            (item) => attribute(item.attributes, 'signal') === 'traces',
          );
        expect(Number(point?.asInt ?? point?.asDouble)).toBe(0);
      }

      const serialized = JSON.stringify(
        collector.received.map((item) => item.body),
      );
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain(PROBE_BODY);
    } finally {
      await collector.close();
    }
  }, 120_000);

  it('with the capability absent from the artifact, signals run as no-op and send nothing', async () => {
    const collector = await startCollector();
    try {
      const script = `
        require(process.env.FOUNDATION_TEST_INSTRUMENTATION);
        require('./src/app.module');
        const { createNoopOperationSignals } = require('./src/core/application/observability/operation-signals');
        const signals = createNoopOperationSignals();
        const failure = signals
          .runActivity({ name: 'off.activity' }, async () => { throw new Error('off-failure'); })
          .then(() => 'unexpected', (error) => error.message);
        const success = signals.runActivity({ name: 'off.activity' }, async () => 42);
        signals.recordSaturation('foundation.admission.rejected', { reason: 'capacity' });
        Promise.all([success, failure]).then(([value, message]) => {
          const otel = Object.keys(require.cache).filter((file) => /[\\\\/]@opentelemetry[\\\\/]/.test(file));
          console.log(JSON.stringify({ value, message, context: signals.injectTraceContext(), otel }));
        });
      `;
      const child = spawnChild(['-r', TS_NODE, '-e', script], {
        FOUNDATION_TEST_INSTRUMENTATION: files.off,
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        FOUNDATION_SERVICE_NAME: 'foundation-off',
        FOUNDATION_SERVICE_VERSION: '1.0.0-test',
        FOUNDATION_DEPLOYMENT_ENVIRONMENT: 'test',
        FOUNDATION_OTEL_SAMPLING_RATIO: '1',
        FOUNDATION_OTEL_METRIC_EXPORT_INTERVAL_MS: '1000',
        FOUNDATION_OTEL_EXPORT_TIMEOUT_MS: '500',
      });
      expect(await child.exited).toBe(0);
      expect(
        JSON.parse(child.output().trim().split('\n').pop() ?? '{}'),
      ).toEqual({
        value: 42,
        message: 'off-failure',
        context: {},
        otel: [],
      });
      // Nenhuma tentativa de OTLP: o Collector de teste não recebe requisição.
      expect(collector.received).toEqual([]);
    } finally {
      await collector.close();
    }
  }, 120_000);
});
