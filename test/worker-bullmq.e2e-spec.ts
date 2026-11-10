import type { INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { JobEnvelope } from '../src/core/application/execution/job-envelope';
import type { ActivityRecord } from '../src/core/application/activities/activity.model';
import type { ActivityStore } from '../src/core/application/activities/activity-store.port';
import type { JobSubmitter } from '../src/core/application/activities/job-submitter';
import { JobSubmitter as JobSubmitterClass } from '../src/core/application/activities/job-submitter';
import { ACTIVITY_STORE, JOB_SUBMITTER } from '../src/native/queue-bullmq';
import { startWorker, type RunningWorker } from '../src/worker';
import {
  concurrencyProbe,
  createFixtureHandlers,
  fixtureIdentity,
  resetConcurrencyProbe,
} from './fixtures/worker-fixtures';
import {
  fixturePool,
  startInfrastructure,
  waitFor,
  workerEnv,
  type Infrastructure,
} from './fixtures/worker-harness';
import type { Pool } from 'pg';

jest.setTimeout(300_000);

let infra: Infrastructure;
let pool: Pool;
let counter = 0;
const running: RunningWorker[] = [];
/** Filas de inspeção abertas pelos testes; todas são fechadas antes do Redis parar. */
const inspectionQueues: Queue[] = [];

beforeAll(async () => {
  infra = await startInfrastructure();
  pool = fixturePool(infra);
});

afterAll(async () => {
  for (const worker of running) {
    await worker.consumer.drain(2000).catch(() => undefined);
    await worker.app.close().catch(() => undefined);
  }
  for (const queue of inspectionQueues) {
    await queue.close().catch(() => undefined);
  }
  await pool?.end();
  await infra?.stop();
});

interface Harness {
  readonly queueName: string;
  readonly submitter: JobSubmitter;
  readonly activities: ActivityStore;
  readonly failedIds: () => Promise<Array<{ id: string; reason: string }>>;
}

/** Sobe um worker in-process com fila própria, usando o mesmo código do processo real. */
async function harness(
  overrides: Record<string, string> = {},
): Promise<Harness> {
  counter += 1;
  const queueName = `bullmq-e2e-${counter}-${Date.now()}`;
  const env = workerEnv(infra, queueName, overrides);
  const worker = await startWorker({
    env,
    handlers: createFixtureHandlers(pool),
    identity: fixtureIdentity,
  });
  running.push(worker);
  const app: INestApplicationContext = worker.app;
  const queue = new Queue(queueName, {
    connection: {
      host: infra.env.FOUNDATION_REDIS_HOST,
      port: Number(infra.env.FOUNDATION_REDIS_PORT),
    },
  });
  inspectionQueues.push(queue);
  return {
    queueName,
    submitter: app.get<JobSubmitterClass>(JOB_SUBMITTER),
    activities: app.get<ActivityStore>(ACTIVITY_STORE),
    failedIds: async () => {
      const failed = await queue.getFailed();
      return failed.map((job) => ({
        id: job.id ?? '',
        reason: job.failedReason,
      }));
    },
  };
}

let jobSeq = 0;
function envelope(
  type: string,
  payload: unknown,
  overrides: Partial<JobEnvelope<unknown>> = {},
): JobEnvelope<unknown> {
  jobSeq += 1;
  return {
    id: `job-${Date.now()}-${jobSeq}`,
    type,
    payloadVersion: 1,
    payload,
    subjectId: 'subject-ok',
    tenantId: 'tenant-a',
    correlationId: `corr-${jobSeq}`,
    deadlineAt: Date.now() + 60_000,
    maxAttempts: 3,
    ...overrides,
  };
}

const finalState = (
  activities: ActivityStore,
  id: string,
  states: ActivityRecord['state'][],
): Promise<ActivityRecord> =>
  waitFor(
    async () => {
      const row = await activities.find(id, 'tenant-a');
      return row !== null && states.includes(row.state) ? row : undefined;
    },
    60_000,
    `${id} in ${states.join('|')}`,
  );

async function runCount(jobId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM worker_fixture_runs WHERE job_id = $1',
    [jobId],
  );
  return Number(result.rows[0]?.count);
}

async function effectCount(jobId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM worker_fixture_effects WHERE job_id = $1',
    [jobId],
  );
  return Number(result.rows[0]?.count);
}

describe('Retries limitados e falha terminal (BullMQ real)', () => {
  it('falha recuperável duas vezes e depois passa: sucesso com attempts=3', async () => {
    const h = await harness();
    const job = envelope('fixture.effect', { failRetryableUntilAttempt: 2 });

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, [
      'succeeded',
      'failed_terminal',
    ]);

    expect(row).toMatchObject({
      state: 'succeeded',
      attempts: 3,
      lastErrorCode: null,
    });
    expect(await runCount(job.id)).toBe(3);
    expect(await effectCount(job.id)).toBe(1);
  });

  it('handler sempre falhando para em maxAttempts, fica failed_terminal e visível na fila de falha', async () => {
    const h = await harness();
    const job = envelope(
      'fixture.effect',
      { failRetryableUntilAttempt: 99 },
      { maxAttempts: 3 },
    );

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, ['failed_terminal']);

    expect(row).toMatchObject({
      state: 'failed_terminal',
      attempts: 3,
      lastErrorCode: 'job_handler_error',
    });
    expect(await runCount(job.id)).toBe(3);
    await waitFor(
      async () => (await h.failedIds()).find((item) => item.id === job.id),
      30_000,
      'job in BullMQ failed set',
    ).then((item) => expect(item.reason).toBe('job_handler_error'));
  });

  it('erro terminal não faz retry: uma tentativa e falha terminal', async () => {
    const h = await harness();
    const job = envelope('fixture.effect', { failTerminal: true });

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, ['failed_terminal']);

    expect(row).toMatchObject({
      attempts: 1,
      lastErrorCode: 'job_handler_error',
    });
    expect(await runCount(job.id)).toBe(1);
  });

  it('teto global limita maxAttempts do envelope', async () => {
    const h = await harness({ FOUNDATION_JOBS_MAX_ATTEMPTS: '2' });
    const job = envelope(
      'fixture.effect',
      { failRetryableUntilAttempt: 99 },
      { maxAttempts: 9 },
    );

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, ['failed_terminal']);

    expect(row.attempts).toBe(2);
    expect(await runCount(job.id)).toBe(2);
  });

  it('type sem handler vira falha terminal job_handler_not_found sem executar', async () => {
    const h = await harness();
    const job = envelope('fixture.unknown', {});

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, ['failed_terminal']);

    expect(row).toMatchObject({
      attempts: 1,
      lastErrorCode: 'job_handler_not_found',
    });
  });

  it('reautorização negada é terminal e o handler não roda', async () => {
    const h = await harness();
    const job = envelope(
      'fixture.effect',
      {},
      { subjectId: 'subject-revoked' },
    );

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, ['failed_terminal']);

    expect(row.lastErrorCode).toBe('job_reauthorization_denied');
    expect(await runCount(job.id)).toBe(0);
  });

  it('prazo do envelope vencido não executa e termina com job_deadline_exceeded', async () => {
    const h = await harness();
    const job = envelope(
      'fixture.effect',
      {},
      { deadlineAt: Date.now() - 1_000 },
    );

    await h.submitter.submit(job);
    const row = await finalState(h.activities, job.id, ['failed_terminal']);

    expect(row.lastErrorCode).toBe('job_deadline_exceeded');
    expect(await runCount(job.id)).toBe(0);
  });

  it('reenvio com o mesmo id é deduplicado pela fila', async () => {
    const h = await harness();
    const job = envelope('fixture.effect', {});

    const first = await h.submitter.submit(job);
    const second = await h.submitter.submit(job);
    await finalState(h.activities, job.id, ['succeeded']);

    expect(first.queue).toBe('accepted');
    expect(second).toMatchObject({
      activityCreated: false,
      queue: 'already_present',
    });
    expect(await runCount(job.id)).toBe(1);
  });
});

describe('Concorrência controlada (BullMQ real)', () => {
  it('nunca executa mais de N jobs ao mesmo tempo', async () => {
    resetConcurrencyProbe();
    const h = await harness({ FOUNDATION_WORKER_CONCURRENCY: '3' });
    const jobs = Array.from({ length: 12 }, () =>
      envelope('fixture.hold', { holdMs: 150 }),
    );

    for (const job of jobs) await h.submitter.submit(job);
    for (const job of jobs)
      await finalState(h.activities, job.id, ['succeeded']);

    expect(concurrencyProbe.max).toBe(3);
  });
});
