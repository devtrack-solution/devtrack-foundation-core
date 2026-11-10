import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../../application/context/operation-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Formato restrito: começa com alfanumérico, até 128 caracteres no total. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface HttpResponseLike {
  readonly headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

const correlationIds = new WeakMap<object, string>();
const operationContexts = new WeakMap<object, OperationContext>();

/** Preserva o header só quando válido; caso contrário gera um UUID. */
export function resolveCorrelationId(
  value: string | string[] | undefined,
): string {
  if (typeof value === 'string' && VALID_CORRELATION_ID.test(value))
    return value;
  return randomUUID();
}

/** Uma única correlação por requisição, compartilhada por guard, interceptor e filter. */
export function ensureCorrelationId(request: HttpRequestLike): string {
  const existing = correlationIds.get(request);
  if (existing !== undefined) return existing;
  const id = resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);
  correlationIds.set(request, id);
  return id;
}

export function bindOperationContext(
  request: HttpRequestLike,
  context: OperationContext,
): void {
  operationContexts.set(request, context);
}

export function operationContextOf(
  request: HttpRequestLike,
): OperationContext | undefined {
  return operationContexts.get(request);
}
