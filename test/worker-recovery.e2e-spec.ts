import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { Pool } from 'pg';
import type { JobEnvelope } from '../src/core/application/execution/job-envelope';
import type { ActivityRecord } from '../src/core/application/activities/activity.model';
import type { ActivityStore } from '../src/core/application/activities/activity-store.port';
import type { JobSubmitter } from '../src/core/application/activities/job-submitter';
import { ACTIVITY_STORE, JOB_SUBMITTER } from '../src/native/queue-bullmq';
import { fixtureIdentity } from './fixtures/worker-fixtures';
import {
  fixturePool,
  startInfrastructure,
  startProducer,
  waitFor,
  workerEnv,
  type Infrastructure,
} from './fixtures/worker-harness';

jest.setTimeout(400_000);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CHILD = path.join(PROJECT_ROOT, 'test/fixtures/worker-child.ts');

let infra: Infrastructure;
let pool: Pool;
let producer: INestApplicationContext;
let submitter: JobSubmitter;
let activities: ActivityStore;
let counter = 0;
const children: ChildProcess[] = [];

beforeAll(async () => {
  infra = await startInfrastructure();
  pool = fixturePool(infra);
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
        }),
    ),
  );
  await producer?.close();
  await pool?.end();
  await infra?.stop();
});

interface Spawned {
  readonly child: ChildProcess;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  readonly logs: () => string;
}

/** Processo worker real (`src/worker.ts` via ts-node), com logs capturados para diagnóstico. */
function spawnWorker(env: Record<string, string>): Spawned {
  let output = '';
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', CHILD],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, logs: () => output.slice(-4000) };
}

function setup(
  queueName: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return workerEnv(infra, queueName, {
    FOUNDATION_WORKER_LOCK_MS: '1000',
    FOUNDATION_WORKER_STALLED_INTERVAL_MS: '500',
    ...extra,
  });
}

async function startProducerFor(env: Record<string, string>): Promise<void> {
  await producer?.close();
  producer = await startProducer(env, fixtureIdentity);
  submitter = producer.get<JobSubmitter>(JOB_SUBMITTER);
  activities = producer.get<ActivityStore>(ACTIVITY_STORE);
}

function job(payload: unknown): JobEnvelope<unknown> {
  counter += 1;
  return {
    id: `recovery-${Date.now()}-${counter}`,
    type: 'fixture.effect',
    payloadVersion: 1,
    payload,
    subjectId: 'subject-ok',
    tenantId: 'tenant-a',
    correlationId: `corr-recovery-${counter}`,
    deadlineAt: Date.now() + 300_000,
    maxAttempts: 5,
  };
}

const runsOf = async (jobId: string): Promise<number> =>
  Number(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM worker_fixture_runs WHERE job_id = $1',
        [jobId],
      )
    ).rows[0]?.count,
  );

const effectsOf = async (jobId: string): Promise<number> =>
  Number(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM worker_fixture_effects WHERE job_id = $1',
        [jobId],
      )
    ).rows[0]?.count,
  );

const waitState = (
  id: string,
  states: ActivityRecord['state'][],
  timeoutMs = 90_000,
) =>
  waitFor(
    async () => {
      const row = await activities.find(id, 'tenant-a');
      return row !== null && states.includes(row.state) ? row : undefined;
    },
    timeoutMs,
    `${id} in ${states.join('|')}`,
  );

describe('Reentrega após kill de worker (processo real)', () => {
  it('SIGKILL no meio do job: outro worker retoma, conclui e o efeito é aplicado uma vez', async () => {
    const queue = `kill-${Date.now()}`;
    const env = setup(queue);
    await startProducerFor(env);
    const item = job({ sleepFirstRunMs: 60_000 });

    const first = spawnWorker(env);
    await submitter.submit(item);
    await waitState(item.id, ['running']);
    await waitFor(
      async () => (await runsOf(item.id)) >= 1,
      30_000,
      'first run started',
    );

    first.child.kill('SIGKILL');
    await first.exited;

    const second = spawnWorker(env);
    const row = await waitState(item.id, ['succeeded'], 120_000);

    expect(row.state).toBe('succeeded');
    expect(await runsOf(item.id)).toBe(2);
    expect(await effectsOf(item.id)).toBe(1);
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(await activities.find(item.id, 'tenant-a')).not.toBeNull();

    second.child.kill('SIGTERM');
    await second.exited;
  });
});

describe('Drenagem com prazo (SIGTERM)', () => {
  it('job curto conclui dentro do prazo e o processo sai com código 0', async () => {
    const queue = `drain-short-${Date.now()}`;
    const env = setup(queue, { FOUNDATION_WORKER_DRAIN_DEADLINE_MS: '10000' });
    await startProducerFor(env);
    const item = job({ sleepFirstRunMs: 1500 });

    const worker = spawnWorker(env);
    await submitter.submit(item);
    await waitFor(
      async () => (await runsOf(item.id)) >= 1,
      60_000,
      'short job started',
    );

    const sigtermAt = Date.now();
    worker.child.kill('SIGTERM');
    const exit = await worker.exited;
    const elapsedMs = Date.now() - sigtermAt;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(elapsedMs).toBeLessThan(10_000);
    expect(worker.logs()).toContain('completed=true abandoned=0');
    expect(await effectsOf(item.id)).toBe(1);
    expect(await activities.find(item.id, 'tenant-a')).toMatchObject({
      state: 'succeeded',
      attempts: 1,
    });
    console.info(`drain.short elapsedMs=${elapsedMs}`);
  });

  it('job longo que passa do prazo: processo sai no prazo com código 0; job volta à fila e outro worker conclui', async () => {
    const queue = `drain-long-${Date.now()}`;
    const deadlineMs = 1500;
    const env = setup(queue, {
      FOUNDATION_WORKER_DRAIN_DEADLINE_MS: String(deadlineMs),
    });
    await startProducerFor(env);
    const item = job({ sleepFirstRunMs: 60_000 });

    const first = spawnWorker(env);
    await submitter.submit(item);
    await waitFor(
      async () => (await runsOf(item.id)) >= 1,
      60_000,
      'long job started',
    );

    const sigtermAt = Date.now();
    first.child.kill('SIGTERM');
    const exit = await first.exited;
    const elapsedMs = Date.now() - sigtermAt;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(elapsedMs).toBeGreaterThanOrEqual(deadlineMs - 100);
    expect(elapsedMs).toBeLessThan(deadlineMs + 8_000);
    expect(first.logs()).toContain('completed=false abandoned=1');

    const second = spawnWorker(env);
    const row = await waitState(item.id, ['succeeded'], 120_000);

    expect(row.state).toBe('succeeded');
    expect(await runsOf(item.id)).toBe(2);
    expect(await effectsOf(item.id)).toBe(1);

    second.child.kill('SIGTERM');
    await second.exited;
    console.info(`drain.long deadlineMs=${deadlineMs} elapsedMs=${elapsedMs}`);
  });
});
