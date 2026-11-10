/**
 * Contratos neutros de sinais (métricas, spans e propagação de contexto).
 * Application pura: nenhuma dependência de OpenTelemetry. O adapter nativo
 * implementa estas portas; sem adapter, `createNoopOperationSignals` mantém o
 * mesmo comportamento sem carregar SDK.
 */

import type { SaturationCounterName } from './signal-catalog';

export type SignalAttributeValue = string | number | boolean;

/** Atributos de sinal. Chaves fora de `SIGNAL_ATTRIBUTE_ALLOWLIST` são descartadas. */
export type SignalAttributes = Readonly<Record<string, SignalAttributeValue>>;

export type ActivityOutcome = 'succeeded' | 'failed';

/** Contexto de trace serializado (W3C `traceparent`/`tracestate`). Nunca baggage. */
export type TraceContextCarrier = Readonly<Record<string, string>>;

export interface MetricsRecorder {
  /** Incrementa um contador monotônico por 1. */
  count(name: string, attributes?: SignalAttributes): void;
  /** Registra uma observação em histograma. */
  observe(name: string, value: number, attributes?: SignalAttributes): void;
}

export interface SpanRecorder {
  /**
   * Executa `work` dentro de um span filho do contexto ativo. Falhas de `work`
   * são propagadas sem alterar o erro original.
   */
  runSpan<T>(
    name: string,
    attributes: SignalAttributes,
    work: () => Promise<T>,
  ): Promise<T>;
}

export interface TraceContextPropagator {
  /** Serializa o contexto ativo; vazio quando não há contexto a propagar. */
  inject(): TraceContextCarrier;
  /** Executa `work` com o contexto extraído de `carrier` ativo; sem carrier, executa sem contexto pai. */
  run<T>(
    carrier: TraceContextCarrier | undefined,
    work: () => Promise<T>,
  ): Promise<T>;
}

export interface ActivityRequest {
  /** Nome de baixa cardinalidade, por exemplo `contacts.import`. */
  readonly name: string;
  /** Contexto recebido do envelope de job; ausente cria trace raiz. */
  readonly traceContext?: TraceContextCarrier;
  readonly attributes?: SignalAttributes;
}

export interface OperationSignals {
  /**
   * Incrementa um contador de saturação do catálogo (recusa por capacidade ou
   * limite de taxa). Atributos passam pelo filtro da métrica; no-op sem adapter.
   */
  recordSaturation(
    name: SaturationCounterName,
    attributes?: SignalAttributes,
  ): void;
  /** Registra desfecho e duração de uma atividade sem span. */
  recordActivity(
    name: string,
    outcome: ActivityOutcome,
    durationMs: number,
  ): void;
  /** Executa atividade assíncrona com span, contexto propagado e métricas. */
  runActivity<T>(request: ActivityRequest, work: () => Promise<T>): Promise<T>;
  /** Contexto a gravar em `JobEnvelope.traceContext` no momento do agendamento. */
  injectTraceContext(): TraceContextCarrier;
}
