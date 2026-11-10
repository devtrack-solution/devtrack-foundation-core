/* eslint-disable @typescript-eslint/no-require-imports */
// Processo filho dos testes de telemetria. A primeira instrucao carrega o
// instrumentation gerado (caminho em env), antes de qualquer modulo HTTP ou Nest.
require(process.env.FOUNDATION_TEST_INSTRUMENTATION as string);

const { Body, Controller, Get, Module, Post } =
  require('@nestjs/common') as typeof import('@nestjs/common');
const { NestFactory } =
  require('@nestjs/core') as typeof import('@nestjs/core');
const { createOpenTelemetryOperationSignals } =
  require('../../src/native/opentelemetry') as typeof import('../../src/native/opentelemetry');
const { openTelemetryRuntime } =
  require('../../src/native/opentelemetry/bootstrap') as typeof import('../../src/native/opentelemetry/bootstrap');
import type { JobEnvelope } from '../../src/core/application/execution/job-envelope';

const signals = createOpenTelemetryOperationSignals();
const pending: Promise<unknown>[] = [];
const PROBE_BODY = 'probe-body-must-not-leak';

/** Agenda trabalho assíncrono com o contexto no envelope e o executa depois, extraindo o contexto. */
function enqueueProbeJob(): void {
  // Recusa com atributos proibidos: só `reason` pode chegar ao Collector.
  signals.recordSaturation('foundation.admission.rejected', {
    reason: 'capacity',
    'user.email': 'maria@example.test',
    'auth.token': 'secret-token-value',
    'http.target': PROBE_BODY,
  });
  const job: JobEnvelope<{ value: number }> = {
    id: 'job-probe-1',
    type: 'probe.activity',
    payloadVersion: 1,
    payload: { value: 7 },
    subjectId: 'subject-probe',
    correlationId: 'corr-probe-1',
    deadlineAt: Date.now() + 60_000,
    maxAttempts: 1,
    traceContext: signals.injectTraceContext(),
  };
  setImmediate(() => {
    pending.push(
      signals
        .runActivity({ name: 'probe.failing' }, () =>
          Promise.reject(new Error(PROBE_BODY)),
        )
        .catch(() => undefined),
    );
    pending.push(
      signals.runActivity(
        {
          name: job.type,
          traceContext: job.traceContext,
          attributes: {
            'user.email': 'maria@example.test',
            'auth.token': 'secret-token-value',
            'operation.kind': 'probe',
          },
        },
        () => Promise.resolve(job.payload.value),
      ),
    );
  });
}

@Controller()
class ProbeController {
  @Get('ping')
  ping(): { ok: boolean } {
    return { ok: true };
  }

  @Post('probe')
  probe(@Body() _body: unknown): { accepted: boolean } {
    void _body;
    enqueueProbeJob();
    return { accepted: true };
  }

  @Get('diagnostics')
  diagnostics(): unknown {
    return openTelemetryRuntime.diagnostics();
  }

  @Post('finish')
  async finish(): Promise<{ flushed: boolean; diagnostics: unknown }> {
    await Promise.all(pending);
    const flushed = await openTelemetryRuntime.shutdown();
    return { flushed, diagnostics: openTelemetryRuntime.diagnostics() };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as import('node:http').Server;
  const address = server.address() as { port: number };
  process.stdout.write(`READY ${address.port}\n`);
}

void main();
