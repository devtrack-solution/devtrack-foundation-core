import type { Principal } from '../../domain/security/identity';
import type { JobEnvelope } from '../execution/job-envelope';

/** Contexto reconstruído pelo executor após reautorização. Nunca contém bearer token. */
export interface JobHandlerContext {
  readonly jobId: string;
  readonly type: string;
  readonly attempt: number;
  readonly correlationId: string;
  readonly deadlineAt: number;
  readonly principal: Principal;
  readonly traceContext?: Readonly<Record<string, string>>;
  /** Disparado em timeout, prazo vencido ou drenagem forçada. */
  readonly signal: AbortSignal;
}

/** Handler de negócio: deve ser idempotente, pois a entrega é at-least-once. */
export interface JobHandler<Payload = unknown> {
  readonly type: string;
  readonly payloadVersion: number;
  handle(payload: Payload, context: JobHandlerContext): Promise<void>;
}

export type JobHandlerRegistrationCode =
  'job_handler_invalid' | 'job_handler_duplicate_type';

export class JobHandlerRegistrationError extends Error {
  constructor(readonly code: JobHandlerRegistrationCode) {
    super(code);
    this.name = 'JobHandlerRegistrationError';
  }
}

export type JobHandlerLookup =
  | { readonly kind: 'found'; readonly handler: JobHandler }
  | { readonly kind: 'unknown_type' }
  | { readonly kind: 'unsupported_version' };

const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

/** Um handler por `type`; a versão de payload declarada por ele é a única aceita. */
export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(handlers: readonly JobHandler[] = []) {
    for (const handler of handlers) this.register(handler);
  }

  register(handler: JobHandler): void {
    if (
      typeof handler.type !== 'string' ||
      !TYPE_PATTERN.test(handler.type) ||
      !Number.isSafeInteger(handler.payloadVersion) ||
      handler.payloadVersion < 1
    ) {
      throw new JobHandlerRegistrationError('job_handler_invalid');
    }
    if (this.handlers.has(handler.type)) {
      throw new JobHandlerRegistrationError('job_handler_duplicate_type');
    }
    this.handlers.set(handler.type, handler);
  }

  lookup(
    envelope: Pick<JobEnvelope<unknown>, 'type' | 'payloadVersion'>,
  ): JobHandlerLookup {
    const handler = this.handlers.get(envelope.type);
    if (!handler) return { kind: 'unknown_type' };
    if (handler.payloadVersion !== envelope.payloadVersion) {
      return { kind: 'unsupported_version' };
    }
    return { kind: 'found', handler };
  }
}
