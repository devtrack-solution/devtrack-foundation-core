/* eslint-disable @typescript-eslint/no-require-imports */
// Processo filho dos testes de carga e encerramento. A primeira instrucao carrega
// o instrumentation gerado (caminho em env), antes de qualquer outro modulo.
require(process.env.FOUNDATION_TEST_INSTRUMENTATION as string);

const { createOpenTelemetryOperationSignals } =
  require('../../src/native/opentelemetry') as typeof import('../../src/native/opentelemetry');
const { openTelemetryRuntime } =
  require('../../src/native/opentelemetry/bootstrap') as typeof import('../../src/native/opentelemetry/bootstrap');

const signals = createOpenTelemetryOperationSignals();
const mode = process.env.FOUNDATION_TEST_MODE;

async function memory(count: number): Promise<void> {
  const gc = (global as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('run with --expose-gc');
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let index = 0; index < count; index += 1) {
    await signals.runActivity({ name: 'load.activity' }, () =>
      Promise.resolve(index),
    );
  }
  await openTelemetryRuntime.forceFlush();
  gc();
  gc();
  const heapAfter = process.memoryUsage().heapUsed;
  process.stdout.write(
    `RESULT ${JSON.stringify({
      spans: count,
      heapBefore,
      heapAfter,
      diagnostics: openTelemetryRuntime.diagnostics(),
    })}\n`,
  );
  await openTelemetryRuntime.shutdown();
  process.exit(0);
}

async function idle(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await signals.runActivity({ name: 'idle.activity' }, () =>
      Promise.resolve(index),
    );
  }
  process.stdout.write('READY 0\n');
  // Mantém o processo vivo até o SIGTERM; o handler opt-in encerra com código 0.
  setInterval(() => undefined, 1000);
}

const count = Number(process.env.FOUNDATION_TEST_SPANS ?? '50');
void (mode === 'memory' ? memory(count) : idle(count));
