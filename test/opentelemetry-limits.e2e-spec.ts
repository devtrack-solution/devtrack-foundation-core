import fs from 'node:fs';
import {
  allSpans,
  closedPortUrl,
  LOAD_APP,
  post,
  prepareInstrumentationFiles,
  PROBE_APP,
  spawnChild,
  startBlackhole,
  startCollector,
  startProbe,
  TS_NODE,
  type OtlpSpan,
} from './fixtures/otel-harness';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl';
const COOKIE_VALUE = 'session-COOKIE-7c1e';
const QUERY_TOKEN = 'tok-QUERY-9f3a';
const QUERY_EMAIL = 'a@b.com';
const CPF = '123.456.789-09';

const HOST_ENV = {
  FOUNDATION_SERVICE_NAME: 'foundation-limits',
  FOUNDATION_SERVICE_VERSION: '1.0.0-test',
  FOUNDATION_DEPLOYMENT_ENVIRONMENT: 'test',
};

/** Teto de heap usado após GC ao final da carga. Medido na 5.2; ver relatório. */
const HEAP_CEILING_BYTES = 64 * 1024 * 1024;
const LOAD_SPANS = 50_000;

interface LoadResult {
  readonly spans: number;
  readonly heapBefore: number;
  readonly heapAfter: number;
  readonly diagnostics: {
    readonly spansAccepted: number;
    readonly spansDropped: number;
    readonly spansFailed: number;
    readonly spansQueued: number;
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[index] ?? 0;
}

async function waitForFailures(
  port: number,
  timeoutMs: number,
): Promise<{ spansFailed: number }> {
  const started = Date.now();
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/diagnostics`);
    const body = (await response.json()) as { spansFailed: number };
    if (body.spansFailed > 0) return body;
    if (Date.now() - started > timeoutMs)
      throw new Error('no export failure counted');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('OpenTelemetry limits, sampling, filtering and shutdown', () => {
  let files: ReturnType<typeof prepareInstrumentationFiles>;

  beforeAll(() => {
    files = prepareInstrumentationFiles();
  });

  afterAll(() => {
    fs.rmSync(files.tempDir, { recursive: true, force: true });
  });

  it('keeps requests responding with normal latency when the destination is unavailable', async () => {
    const unavailable = await closedPortUrl();
    const probe = await startProbe(PROBE_APP, {
      ...HOST_ENV,
      FOUNDATION_TEST_INSTRUMENTATION: files.on,
      OTEL_EXPORTER_OTLP_ENDPOINT: unavailable,
      FOUNDATION_OTEL_SAMPLING_RATIO: '1',
      FOUNDATION_OTEL_SPAN_SCHEDULED_DELAY_MS: '100',
      FOUNDATION_OTEL_EXPORT_TIMEOUT_MS: '1000',
      FOUNDATION_OTEL_SHUTDOWN_DEADLINE_MS: '2000',
    });
    try {
      const latencies: number[] = [];
      for (let index = 0; index < 50; index += 1) {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${probe.port}/ping`);
        latencies.push(performance.now() - started);
        expect(response.status).toBe(200);
      }
      await post(probe.port, '/probe');
      // A falha só é contada quando a tentativa de exportação termina (timeout de 1 s).
      const diagnostics = await waitForFailures(probe.port, 20_000);
      await post(probe.port, '/finish');

      const p95 = percentile(latencies, 0.95);
      // Latência de requisição local com exportação falhando: limite folgado para CI.
      expect(p95).toBeLessThan(500);
      expect(diagnostics.spansFailed).toBeGreaterThan(0);
      console.info(
        `[otel] unavailable destination: p95=${p95.toFixed(1)}ms spansFailed=${diagnostics.spansFailed}`,
      );
    } finally {
      probe.child.kill('SIGTERM');
      await probe.exited;
    }
  }, 120_000);

  it('bounds memory with an unreachable collector: queue never exceeds its limit and drops are counted', async () => {
    const unavailable = await closedPortUrl();
    const handle = spawnChild(['--expose-gc', '-r', TS_NODE, LOAD_APP], {
      ...HOST_ENV,
      FOUNDATION_TEST_INSTRUMENTATION: files.on,
      FOUNDATION_TEST_MODE: 'memory',
      FOUNDATION_TEST_SPANS: String(LOAD_SPANS),
      OTEL_EXPORTER_OTLP_ENDPOINT: unavailable,
      FOUNDATION_OTEL_SAMPLING_RATIO: '1',
      FOUNDATION_OTEL_SPAN_QUEUE_SIZE: '2048',
      FOUNDATION_OTEL_SPAN_BATCH_SIZE: '512',
      FOUNDATION_OTEL_SPAN_SCHEDULED_DELAY_MS: '100',
      FOUNDATION_OTEL_EXPORT_TIMEOUT_MS: '1000',
    });
    const code = await handle.exited;
    expect(code).toBe(0);
    const line = handle
      .output()
      .split('\n')
      .find((item) => item.startsWith('RESULT '));
    expect(line).toBeDefined();
    const result = JSON.parse(
      (line ?? '').slice('RESULT '.length),
    ) as LoadResult;

    expect(result.diagnostics.spansDropped).toBeGreaterThan(0);
    expect(
      result.diagnostics.spansAccepted + result.diagnostics.spansDropped,
    ).toBe(LOAD_SPANS);
    expect(result.diagnostics.spansQueued).toBeLessThanOrEqual(2048);
    expect(result.diagnostics.spansFailed).toBeGreaterThan(0);
    expect(result.heapAfter).toBeLessThan(HEAP_CEILING_BYTES);
    console.info(
      `[otel] memory: spans=${result.spans} dropped=${result.diagnostics.spansDropped} ` +
        `failed=${result.diagnostics.spansFailed} heapBeforeMB=${(result.heapBefore / 1048576).toFixed(1)} ` +
        `heapAfterMB=${(result.heapAfter / 1048576).toFixed(1)}`,
    );
  }, 240_000);

  it('exits within the shutdown deadline with exit code 0 when the collector accepts and never responds', async () => {
    const blackhole = await startBlackhole();
    const deadlineMs = 1000;
    const margin = 1500;
    try {
      const probe = await startProbe(LOAD_APP, {
        ...HOST_ENV,
        FOUNDATION_TEST_INSTRUMENTATION: files.on,
        FOUNDATION_TEST_MODE: 'idle',
        FOUNDATION_TEST_SPANS: '50',
        OTEL_EXPORTER_OTLP_ENDPOINT: blackhole.url,
        FOUNDATION_OTEL_SAMPLING_RATIO: '1',
        FOUNDATION_OTEL_SPAN_SCHEDULED_DELAY_MS: '100',
        FOUNDATION_OTEL_EXPORT_TIMEOUT_MS: '30000',
        FOUNDATION_OTEL_SHUTDOWN_DEADLINE_MS: String(deadlineMs),
        FOUNDATION_OTEL_SHUTDOWN_ON_SIGNALS: 'true',
      });
      await waitFor(() => blackhole.requests() > 0, 15_000);
      const started = Date.now();
      probe.child.kill('SIGTERM');
      const code = await probe.exited;
      const elapsed = Date.now() - started;

      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(deadlineMs + margin);
      console.info(
        `[otel] shutdown with blackhole collector: elapsedMs=${elapsed} deadlineMs=${deadlineMs}`,
      );
    } finally {
      await blackhole.close();
    }
  }, 120_000);

  it('never sends bearer tokens, cookies, query values, emails or CPF to the collector', async () => {
    const collector = await startCollector();
    try {
      const probe = await startProbe(PROBE_APP, {
        ...HOST_ENV,
        FOUNDATION_TEST_INSTRUMENTATION: files.on,
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        FOUNDATION_OTEL_SAMPLING_RATIO: '1',
      });
      const accepted = await post(
        probe.port,
        `/probe?email=${QUERY_EMAIL}&token=${QUERY_TOKEN}`,
        {
          authorization: `Bearer ${JWT}`,
          cookie: `session=${COOKIE_VALUE}`,
        },
        { cpf: CPF, name: 'Maria' },
      );
      expect(accepted.status).toBe(201);
      await post(probe.port, '/finish');
      probe.child.kill('SIGTERM');
      await probe.exited;

      const spans = allSpans(collector.received);
      expect(spans.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(
        collector.received.map((item) => item.body),
      );
      for (const forbidden of [
        JWT,
        COOKIE_VALUE,
        QUERY_EMAIL,
        QUERY_TOKEN,
        CPF,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await collector.close();
    }
  }, 120_000);

  it('samples with ParentBased(TraceIdRatioBased): ratio 0 exports nothing for roots and respects a sampled parent', async () => {
    const collector = await startCollector();
    try {
      const sampledTrace = '4bf92f3577b34da6a3ce929d0e0e4736';
      const sampledParent = `00-${sampledTrace}-00f067aa0ba902b7-01`;
      const probeZero = await startProbe(PROBE_APP, {
        ...HOST_ENV,
        FOUNDATION_TEST_INSTRUMENTATION: files.on,
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        FOUNDATION_OTEL_SAMPLING_RATIO: '0',
      });
      await post(probeZero.port, '/probe');
      await post(probeZero.port, '/probe', { traceparent: sampledParent });
      await post(probeZero.port, '/finish');
      probeZero.child.kill('SIGTERM');
      await probeZero.exited;

      const afterZero = allSpans(collector.received);
      expect(afterZero.length).toBeGreaterThan(0);
      expect(afterZero.every((span) => span.traceId === sampledTrace)).toBe(
        true,
      );

      const unsampledTrace = '0af7651916cd43dd8448eb211c80319c';
      const probeOne = await startProbe(PROBE_APP, {
        ...HOST_ENV,
        FOUNDATION_TEST_INSTRUMENTATION: files.on,
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        FOUNDATION_OTEL_SAMPLING_RATIO: '1',
      });
      await post(probeOne.port, '/probe', {
        traceparent: `00-${unsampledTrace}-00f067aa0ba902b7-00`,
      });
      await post(probeOne.port, '/probe');
      await post(probeOne.port, '/finish');
      probeOne.child.kill('SIGTERM');
      await probeOne.exited;

      const all: OtlpSpan[] = allSpans(collector.received);
      expect(all.some((span) => span.traceId === unsampledTrace)).toBe(false);
      expect(all.some((span) => span.traceId !== sampledTrace)).toBe(true);
    } finally {
      await collector.close();
    }
  }, 120_000);

  it('fails the boot with the variable name only when a limit is outside its range', async () => {
    const script = "require('./src/native/opentelemetry/bootstrap');";
    const invalid = 'valor-invalido-123';
    const child = spawnChild(['-r', TS_NODE, '-e', script], {
      ...HOST_ENV,
      FOUNDATION_OTEL_SAMPLING_RATIO: invalid,
    });
    expect(await child.exited).not.toBe(0);
    expect(child.output()).toContain('FOUNDATION_OTEL_SAMPLING_RATIO');
    expect(child.output()).not.toContain(invalid);

    const tooSmall = spawnChild(['-r', TS_NODE, '-e', script], {
      ...HOST_ENV,
      FOUNDATION_OTEL_SPAN_QUEUE_SIZE: '1',
    });
    expect(await tooSmall.exited).not.toBe(0);
    expect(tooSmall.output()).toContain('FOUNDATION_OTEL_SPAN_QUEUE_SIZE');
  }, 120_000);
});
