import type {
  ReadableSpan,
  SpanProcessor,
  SpanExporter,
} from '@opentelemetry/sdk-trace';
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { redactSpan, type RedactableSpan } from './opentelemetry.redaction';

/** Código de resultado de sucesso do OpenTelemetry (`ExportResultCode.SUCCESS`). */
const EXPORT_SUCCESS = 0;

export interface OpenTelemetryDiagnostics {
  /** Spans aceitos na fila de exportação desde o início do processo. */
  readonly spansAccepted: number;
  /** Spans descartados porque a fila estava cheia. */
  readonly spansDropped: number;
  /** Spans de lotes cuja exportação falhou (destino indisponível, timeout, recusa). */
  readonly spansFailed: number;
  /** Lotes de métricas cuja exportação falhou. */
  readonly metricExportsFailed: number;
  /** Spans ainda na fila ou em exportação. Nunca passa do limite configurado. */
  readonly spansQueued: number;
}

/** Contadores mutáveis do processo; expostos apenas como cópia em `diagnostics()`. */
export class TelemetryCounters {
  spansAccepted = 0;
  spansDropped = 0;
  spansFailed = 0;
  metricExportsFailed = 0;
  queued = 0;
  private loggedDrop = false;
  private loggedSpanFailure = false;
  private loggedMetricFailure = false;

  constructor(private readonly capacity: number) {}

  /** Reserva uma posição na fila; falso quando a fila está cheia. */
  tryReserve(): boolean {
    if (this.queued >= this.capacity) {
      this.spansDropped += 1;
      if (!this.loggedDrop) {
        this.loggedDrop = true;
        logOnce('span queue full; further drops are counted only');
      }
      return false;
    }
    this.queued += 1;
    this.spansAccepted += 1;
    return true;
  }

  release(count: number): void {
    this.queued = Math.max(0, this.queued - count);
  }

  spanBatchFailed(count: number): void {
    this.spansFailed += count;
    if (!this.loggedSpanFailure) {
      this.loggedSpanFailure = true;
      logOnce('span export failed; failures are counted in diagnostics');
    }
  }

  metricBatchFailed(): void {
    this.metricExportsFailed += 1;
    if (!this.loggedMetricFailure) {
      this.loggedMetricFailure = true;
      logOnce('metric export failed; failures are counted in diagnostics');
    }
  }

  snapshot(): OpenTelemetryDiagnostics {
    return {
      spansAccepted: this.spansAccepted,
      spansDropped: this.spansDropped,
      spansFailed: this.spansFailed,
      metricExportsFailed: this.metricExportsFailed,
      spansQueued: this.queued,
    };
  }
}

/** Mensagens de diagnóstico sem dados de sinal: apenas o evento, nunca o conteúdo. */
function logOnce(message: string): void {
  process.stderr.write(`[foundation-otel] ${message}\n`);
}

/**
 * Processador que aplica a filtragem de dados e limita a fila antes do
 * `BatchSpanProcessor`. Spans além da capacidade são descartados e contados.
 */
export class BoundedRedactingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly counters: TelemetryCounters,
  ) {}

  onStart(
    span: Parameters<SpanProcessor['onStart']>[0],
    parentContext: Parameters<SpanProcessor['onStart']>[1],
  ): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (!this.counters.tryReserve()) return;
    redactSpan(span as unknown as RedactableSpan);
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Resultado de exportação, só o código; `ExportResultCode.SUCCESS` vale 0. */
interface ExportResultLike {
  readonly code: number;
}

type ExportFunction<T> = (
  items: T,
  resultCallback: (result: ExportResultLike) => void,
) => void;

/**
 * Envolve `export` de uma instância, preservando o exportador original. O
 * observador roda antes do callback original, com os itens e o resultado.
 */
function wrapExport<T>(
  target: { export: ExportFunction<T> },
  observe: (items: T, result: ExportResultLike) => void,
): void {
  const original: ExportFunction<T> = target.export;
  target.export = (items, resultCallback): void => {
    original.call(target, items, (result: ExportResultLike): void => {
      observe(items, result);
      resultCallback(result);
    });
  };
}

/** Conta falhas e libera posições da fila quando a exportação de spans termina. */
export function observeSpanExporter(
  exporter: SpanExporter,
  counters: TelemetryCounters,
): void {
  wrapExport<ReadableSpan[]>(exporter, (spans, result) => {
    counters.release(spans.length);
    if (result.code !== EXPORT_SUCCESS) counters.spanBatchFailed(spans.length);
  });
}

/** Conta lotes de métricas que falharam na exportação. */
export function observeMetricExporter(
  exporter: PushMetricExporter,
  counters: TelemetryCounters,
): void {
  wrapExport<ResourceMetrics>(exporter, (_metrics, result) => {
    if (result.code !== EXPORT_SUCCESS) counters.metricBatchFailed();
  });
}
