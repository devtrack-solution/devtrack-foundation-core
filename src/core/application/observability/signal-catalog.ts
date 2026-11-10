/**
 * Catálogo de métricas de sinais: nomes estáveis, tipo, unidade e atributos
 * permitidos por métrica. Application pura, sem dependência de OpenTelemetry.
 * Outros módulos devem usar estas constantes, nunca strings literais.
 *
 * Mudar um nome, unidade ou atributo é mudança pública de observabilidade:
 * exige revisão de cardinalidade e atualização da seção 8 de core-contracts.md.
 */

export const ACTIVITY_COUNT_METRIC = 'foundation.activity.count';
/** Nome mantido por compatibilidade com a primeira versão; unidade: milissegundos. */
export const ACTIVITY_DURATION_METRIC = 'foundation.activity.duration_ms';
export const ADMISSION_REJECTED_METRIC = 'foundation.admission.rejected';
export const RATELIMIT_REJECTED_METRIC = 'foundation.ratelimit.rejected';
export const QUEUE_DEPTH_METRIC = 'foundation.queue.depth';
export const EXPORT_FAILED_METRIC = 'foundation.export.failed';
export const EXPORT_DROPPED_METRIC = 'foundation.export.dropped';

export type SignalMetricKind = 'counter' | 'histogram' | 'gauge';

export interface SignalMetricDefinition {
  readonly name: string;
  readonly kind: SignalMetricKind;
  /** Unidade UCUM ou anotação entre chaves (`{activity}`), conforme convenção OTel. */
  readonly unit: string;
  readonly description: string;
  /** Atributos permitidos nesta métrica; qualquer outra chave é descartada. */
  readonly attributes: readonly string[];
}

/** Atividade: desfecho e duração de trabalho assíncrono (seção 8.2). */
const ACTIVITY_METRICS = [
  {
    name: ACTIVITY_COUNT_METRIC,
    kind: 'counter',
    unit: '{activity}',
    description: 'Atividades concluídas, por desfecho.',
    attributes: ['activity.name', 'activity.outcome', 'operation.kind'],
  },
  {
    name: ACTIVITY_DURATION_METRIC,
    kind: 'histogram',
    unit: 'ms',
    description: 'Duração de atividades concluídas, em milissegundos.',
    attributes: ['activity.name', 'activity.outcome'],
  },
] as const satisfies readonly SignalMetricDefinition[];

/**
 * Saturação: contadores de recusa e de perda. Produtores (admissão, rate limit)
 * usam `OperationSignals.recordSaturation`; o adapter publica os de exportação.
 */
const SATURATION_METRICS = [
  {
    name: ADMISSION_REJECTED_METRIC,
    kind: 'counter',
    unit: '{request}',
    description:
      'Requisições ou atividades recusadas pela admissão por capacidade.',
    attributes: ['reason'],
  },
  {
    name: RATELIMIT_REJECTED_METRIC,
    kind: 'counter',
    unit: '{request}',
    description: 'Requisições recusadas pelo limite de taxa.',
    attributes: ['reason'],
  },
  {
    name: QUEUE_DEPTH_METRIC,
    kind: 'gauge',
    unit: '{span}',
    description: 'Itens na fila de exportação, no último instante observado.',
    attributes: ['signal'],
  },
  {
    name: EXPORT_FAILED_METRIC,
    kind: 'counter',
    unit: '{item}',
    description:
      'Falhas de exportação. Para `traces` conta spans; para `metrics` conta lotes de métricas.',
    attributes: ['signal'],
  },
  {
    name: EXPORT_DROPPED_METRIC,
    kind: 'counter',
    unit: '{span}',
    description: 'Spans descartados porque a fila de exportação estava cheia.',
    attributes: ['signal'],
  },
] as const satisfies readonly SignalMetricDefinition[];

export const SIGNAL_METRIC_CATALOG: readonly SignalMetricDefinition[] = [
  ...ACTIVITY_METRICS,
  ...SATURATION_METRICS,
];

/** Nomes de contadores de saturação que `recordSaturation` aceita. */
export type SaturationCounterName =
  typeof ADMISSION_REJECTED_METRIC | typeof RATELIMIT_REJECTED_METRIC;

export function findSignalMetric(
  name: string,
): SignalMetricDefinition | undefined {
  return SIGNAL_METRIC_CATALOG.find((metric) => metric.name === name);
}
