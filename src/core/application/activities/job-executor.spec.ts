/* Fakes assincronos sem await: a porta e async, a implementacao de teste e sincrona. */
/* eslint-disable @typescript-eslint/require-await */
import type { Principal } from '../../domain/security/identity';
import type { IdentityAccessResolver } from '../security/authentication.ports';
import type { JobEnvelope } from '../execution/job-envelope';
import { RetryableJobError, TerminalJobError } from '../execution/job-failure';
import type { ActivityRecord } from './activity.model';
import type { ActivityStore } from './activity-store.port';
import { JobExecutor } from './job-executor';
import {
  JobHandlerRegistry,
  type JobHandler,
  type JobHandlerContext,
} from './job-handler';
import { createJobRetryPolicy } from './job-retry-policy';

class MemoryActivities implements ActivityStore {
  readonly rows = new Map<string, ActivityRecord>();
  async insertIfAbsent(record: ActivityRecord): Promise<boolean> {
    if (this.rows.has(record.id)) return false;
    this.rows.set(record.id, record);
    return true;
  }
  async save(record: ActivityRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async find(
    id: string,
    tenantId: string | null,
  ): Promise<ActivityRecord | null> {
    const row = this.rows.get(id);
    return row !== undefined && row.tenantId === tenantId ? row : null;
  }
}

const principal: Principal = {
  subjectId: 'subject-1',
  tenantId: 'tenant-1',
  permissions: [],
};

function identities(result: Principal | null | Error): IdentityAccessResolver {
  return {
    bySubject: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    byExternalIdentity: async () => null,
  };
}

const envelope = (
  overrides: Partial<JobEnvelope<unknown>> = {},
): JobEnvelope<unknown> => ({
  id: 'job-1',
  type: 'contacts.sync',
  payloadVersion: 1,
  payload: { contactId: 'c-1' },
  subjectId: 'subject-1',
  tenantId: 'tenant-1',
  correlationId: 'corr-1',
  deadlineAt: Date.now() + 60_000,
  maxAttempts: 3,
  ...overrides,
});

function handlerOf(
  run: (context: JobHandlerContext) => Promise<void>,
  payloadVersion = 1,
): JobHandler {
  return {
    type: 'contacts.sync',
    payloadVersion,
    handle: (_payload, context) => run(context),
  };
}

function build(
  handler: JobHandler | null,
  identity: IdentityAccessResolver = identities(principal),
  timeoutMs = 5000,
) {
  const activities = new MemoryActivities();
  const registry = new JobHandlerRegistry(handler === null ? [] : [handler]);
  const executor = new JobExecutor({
    registry,
    activities,
    identities: identity,
    clock: { now: () => Date.now() },
    retry: createJobRetryPolicy({
      globalMaxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      timeoutMs,
    }),
  });
  return { executor, activities };
}

describe('JobExecutor', () => {
  it('marca succeeded quando o handler conclui na primeira tentativa', async () => {
    const { executor, activities } = build(handlerOf(async () => undefined));

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(activities.rows.get('job-1')).toMatchObject({
      state: 'succeeded',
      attempts: 1,
    });
  });

  it('devolve retry e failed_retryable para falha recuperável dentro do orçamento', async () => {
    const { executor, activities } = build(
      handlerOf(async () => {
        throw new RetryableJobError('job_handler_error');
      }),
    );

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({ kind: 'retry', code: 'job_handler_error' });
    expect(activities.rows.get('job-1')).toMatchObject({
      state: 'failed_retryable',
      lastErrorCode: 'job_handler_error',
    });
  });

  it('torna terminal a falha recuperável quando a tentativa é a última do orçamento', async () => {
    const { executor, activities } = build(
      handlerOf(async () => {
        throw new RetryableJobError();
      }),
    );

    const outcome = await executor.execute(envelope(), 3, 3);

    expect(outcome).toEqual({ kind: 'terminal', code: 'job_handler_error' });
    expect(activities.rows.get('job-1')).toMatchObject({
      state: 'failed_terminal',
      attempts: 3,
    });
  });

  it('não faz retry de erro terminal', async () => {
    const { executor, activities } = build(
      handlerOf(async () => {
        throw new TerminalJobError('job_handler_error');
      }),
    );

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome.kind).toBe('terminal');
    expect(activities.rows.get('job-1')?.state).toBe('failed_terminal');
  });

  it('grava só o código de erro, nunca a mensagem bruta', async () => {
    const { executor, activities } = build(
      handlerOf(async () => {
        throw new Error('connection string postgres://user:secret@host failed');
      }),
    );

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({ kind: 'retry', code: 'job_handler_error' });
    expect(JSON.stringify(activities.rows.get('job-1'))).not.toContain(
      'secret',
    );
  });

  it('falha terminal quando o type não tem handler registrado', async () => {
    const { executor, activities } = build(null);

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({
      kind: 'terminal',
      code: 'job_handler_not_found',
    });
    expect(activities.rows.get('job-1')?.state).toBe('failed_terminal');
  });

  it('falha terminal quando a versão de payload é desconhecida', async () => {
    let called = false;
    const { executor } = build(
      handlerOf(async () => {
        called = true;
      }, 2),
    );

    const outcome = await executor.execute(
      envelope({ payloadVersion: 1 }),
      1,
      3,
    );

    expect(outcome).toEqual({
      kind: 'terminal',
      code: 'job_payload_version_unsupported',
    });
    expect(called).toBe(false);
  });

  it('reautorização negada é terminal e o handler não roda', async () => {
    let called = false;
    const { executor, activities } = build(
      handlerOf(async () => {
        called = true;
      }),
      identities(null),
    );

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({
      kind: 'terminal',
      code: 'job_reauthorization_denied',
    });
    expect(called).toBe(false);
    expect(activities.rows.get('job-1')?.lastErrorCode).toBe(
      'job_reauthorization_denied',
    );
  });

  it('nega quando o tenant atual da identidade difere do tenant do envelope', async () => {
    const { executor } = build(
      handlerOf(async () => undefined),
      identities({
        subjectId: 'subject-1',
        tenantId: 'tenant-2',
        permissions: [],
      }),
    );

    const outcome = await executor.execute(
      envelope({ tenantId: 'tenant-1' }),
      1,
      3,
    );

    expect(outcome).toEqual({
      kind: 'terminal',
      code: 'job_reauthorization_denied',
    });
  });

  it('erro do provedor de identidade segue a classificação de falha (recuperável)', async () => {
    const { executor } = build(
      handlerOf(async () => undefined),
      identities(new Error('identity store down')),
    );

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({ kind: 'retry', code: 'job_handler_error' });
  });

  it('não executa job com prazo vencido e falha com job_deadline_exceeded', async () => {
    let called = false;
    const { executor, activities } = build(
      handlerOf(async () => {
        called = true;
      }),
    );

    const outcome = await executor.execute(
      envelope({ deadlineAt: Date.now() - 1 }),
      1,
      3,
    );

    expect(outcome).toEqual({
      kind: 'terminal',
      code: 'job_deadline_exceeded',
    });
    expect(called).toBe(false);
    expect(activities.rows.get('job-1')?.state).toBe('failed_terminal');
  });

  it('timeout do handler é recuperável (job_timeout) e sinaliza abort', async () => {
    let aborted = false;
    const { executor } = build(
      handlerOf(
        (context) =>
          new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          }),
      ),
      identities(principal),
      20,
    );

    const outcome = await executor.execute(envelope(), 1, 3);

    expect(outcome).toEqual({ kind: 'retry', code: 'job_timeout' });
    expect(aborted).toBe(true);
  });

  it('timeout causado pelo prazo do envelope é terminal com job_deadline_exceeded', async () => {
    const { executor } = build(
      handlerOf(() => new Promise<void>(() => undefined)),
      identities(principal),
      5000,
    );

    const outcome = await executor.execute(
      envelope({ deadlineAt: Date.now() + 30 }),
      1,
      3,
    );

    expect(outcome).toEqual({
      kind: 'terminal',
      code: 'job_deadline_exceeded',
    });
  });
});
