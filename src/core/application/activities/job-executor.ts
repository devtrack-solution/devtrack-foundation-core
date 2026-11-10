import type { Principal } from '../../domain/security/identity';
import type { IdentityAccessResolver } from '../security/authentication.ports';
import type { JobEnvelope } from '../execution/job-envelope';
import {
  classifyJobFailure,
  RetryableJobError,
  TerminalJobError,
  type JobErrorCode,
} from '../execution/job-failure';
import { activityFromEnvelope } from './activity.model';
import type { ActivityStore } from './activity-store.port';
import type { JobHandlerRegistry } from './job-handler';
import type { JobRetryPolicy } from './job-retry-policy';

export interface JobClock {
  now(): number;
}

/**
 * Resultado de uma tentativa, já classificado. O adapter traduz `retry` em falha
 * recuperável (BullMQ aplica backoff) e `terminal` em falha sem nova tentativa.
 */
export type JobOutcome =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'retry'; readonly code: JobErrorCode }
  | { readonly kind: 'terminal'; readonly code: JobErrorCode };

export interface JobExecutorDependencies {
  readonly registry: JobHandlerRegistry;
  readonly activities: ActivityStore;
  /** Autorização atual do subject. Nunca se usa bearer token do produtor. */
  readonly identities: IdentityAccessResolver;
  readonly clock: JobClock;
  readonly retry: JobRetryPolicy;
}

class TimedOut extends Error {
  constructor(readonly code: JobErrorCode) {
    super(code);
    this.name = 'TimedOut';
  }
}

/**
 * Executa uma tentativa de job: prazo, resolução de handler, reautorização,
 * timeout e gravação do estado da atividade. Não reexecuta: o orçamento de
 * tentativas pertence ao adapter de fila (uma única camada de retry).
 */
export class JobExecutor {
  constructor(private readonly deps: JobExecutorDependencies) {}

  async execute(
    envelope: JobEnvelope<unknown>,
    attempt: number,
    maxAttempts: number,
  ): Promise<JobOutcome> {
    const { activities, clock } = this.deps;
    const startedAt = clock.now();

    if (startedAt >= envelope.deadlineAt) {
      return this.finish(envelope, attempt, maxAttempts, startedAt, {
        kind: 'failure',
        failureClass: 'terminal',
        code: 'job_deadline_exceeded',
      });
    }

    await activities.save(
      activityFromEnvelope(envelope, {
        state: 'running',
        attempts: attempt,
        lastErrorCode: null,
        now: startedAt,
      }),
    );

    const lookup = this.deps.registry.lookup(envelope);
    if (lookup.kind === 'unknown_type') {
      return this.failTerminal(
        envelope,
        attempt,
        maxAttempts,
        'job_handler_not_found',
      );
    }
    if (lookup.kind === 'unsupported_version') {
      return this.failTerminal(
        envelope,
        attempt,
        maxAttempts,
        'job_payload_version_unsupported',
      );
    }

    let principal: Principal | null;
    try {
      principal = await this.deps.identities.bySubject(envelope.subjectId);
    } catch (error) {
      return this.handleFailure(envelope, attempt, maxAttempts, error);
    }
    const tenantMatches =
      envelope.tenantId === undefined ||
      principal?.tenantId === envelope.tenantId;
    if (principal === null || !tenantMatches) {
      return this.failTerminal(
        envelope,
        attempt,
        maxAttempts,
        'job_reauthorization_denied',
      );
    }

    const remainingMs = envelope.deadlineAt - clock.now();
    const timeoutMs = Math.min(this.deps.retry.timeoutMs, remainingMs);
    const deadlineBound = remainingMs < this.deps.retry.timeoutMs;
    const controller = new AbortController();
    let timedOut: JobErrorCode | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Marca antes de abortar: um handler que resolva ao receber abort não
        // pode ser contado como sucesso depois do prazo.
        timedOut = deadlineBound ? 'job_deadline_exceeded' : 'job_timeout';
        reject(new TimedOut(timedOut));
        controller.abort();
      }, timeoutMs);
    });

    try {
      await Promise.race([
        lookup.handler.handle(envelope.payload, {
          jobId: envelope.id,
          type: envelope.type,
          attempt,
          correlationId: envelope.correlationId,
          deadlineAt: envelope.deadlineAt,
          principal,
          ...(envelope.traceContext === undefined
            ? {}
            : { traceContext: envelope.traceContext }),
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (timedOut !== undefined) throw new TimedOut(timedOut);
      return await this.finish(envelope, attempt, maxAttempts, clock.now(), {
        kind: 'success',
      });
    } catch (error) {
      if (error instanceof TimedOut) {
        return this.handleFailure(
          envelope,
          attempt,
          maxAttempts,
          error.code === 'job_deadline_exceeded'
            ? new TerminalJobError(error.code)
            : new RetryableJobError(error.code),
        );
      }
      return this.handleFailure(envelope, attempt, maxAttempts, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async handleFailure(
    envelope: JobEnvelope<unknown>,
    attempt: number,
    maxAttempts: number,
    error: unknown,
  ): Promise<JobOutcome> {
    const classified = classifyJobFailure(error);
    return this.finish(envelope, attempt, maxAttempts, this.deps.clock.now(), {
      kind: 'failure',
      failureClass: classified.failureClass,
      code: classified.code,
    });
  }

  private failTerminal(
    envelope: JobEnvelope<unknown>,
    attempt: number,
    maxAttempts: number,
    code: JobErrorCode,
  ): Promise<JobOutcome> {
    return this.finish(envelope, attempt, maxAttempts, this.deps.clock.now(), {
      kind: 'failure',
      failureClass: 'terminal',
      code,
    });
  }

  private async finish(
    envelope: JobEnvelope<unknown>,
    attempt: number,
    maxAttempts: number,
    now: number,
    result:
      | { readonly kind: 'success' }
      | {
          readonly kind: 'failure';
          readonly failureClass: 'retryable' | 'terminal';
          readonly code: JobErrorCode;
        },
  ): Promise<JobOutcome> {
    if (result.kind === 'success') {
      await this.deps.activities.save(
        activityFromEnvelope(envelope, {
          state: 'succeeded',
          attempts: attempt,
          lastErrorCode: null,
          now,
        }),
      );
      return { kind: 'succeeded' };
    }

    const retryable =
      result.failureClass === 'retryable' && attempt < maxAttempts;
    await this.deps.activities.save(
      activityFromEnvelope(envelope, {
        state: retryable ? 'failed_retryable' : 'failed_terminal',
        attempts: attempt,
        lastErrorCode: result.code,
        now,
      }),
    );
    return retryable
      ? { kind: 'retry', code: result.code }
      : { kind: 'terminal', code: result.code };
  }
}
