import {
  readOpenTelemetryConfig,
  readOpenTelemetryLimits,
} from './opentelemetry.config';
import {
  registerSignalShutdown,
  startOpenTelemetry,
} from './opentelemetry.runtime';

/*
 * Inicialização antecipada. Este módulo é importado pelo arquivo gerado
 * `src/composition/instrumentation.generated.ts` somente quando
 * `native/opentelemetry` está no perfil, e esse arquivo é importado na primeira
 * linha de `src/main.ts`, antes de http, express e Nest. Não importar em outro lugar.
 */
const limits = readOpenTelemetryLimits(process.env);
export const openTelemetryRuntime = startOpenTelemetry(
  readOpenTelemetryConfig(process.env),
  limits,
);
if (limits.shutdownOnSignals) registerSignalShutdown(openTelemetryRuntime);
