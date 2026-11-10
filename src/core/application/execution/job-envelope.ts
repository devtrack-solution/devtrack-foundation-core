/** Durable identity references, not bearer tokens. Reauthorize at execution. */
export interface JobEnvelope<Payload> {
  readonly id: string;
  readonly type: string;
  readonly payloadVersion: number;
  readonly payload: Payload;
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
  readonly deadlineAt: number;
  readonly maxAttempts: number;
  /** Contexto W3C (`traceparent`/`tracestate`) para correlacionar a execução assíncrona. Opcional e sem baggage. */
  readonly traceContext?: Readonly<Record<string, string>>;
}
