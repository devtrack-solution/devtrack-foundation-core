import type { Pool } from 'pg';
import type { Principal } from '../../src/core/domain/security/identity';
import type { IdentityAccessResolver } from '../../src/core/application/security/authentication.ports';
import type {
  JobHandler,
  JobHandlerContext,
} from '../../src/core/application/activities/job-handler';
import {
  RetryableJobError,
  TerminalJobError,
} from '../../src/core/application/execution/job-failure';

/** Identidade de teste: só `subject-ok` do tenant `tenant-a` continua autorizado. */
export const fixtureIdentity: IdentityAccessResolver = {
  bySubject: (subjectId: string): Promise<Principal | null> =>
    Promise.resolve(
      subjectId === 'subject-ok'
        ? { subjectId, tenantId: 'tenant-a', permissions: [] }
        : null,
    ),
  byExternalIdentity: () => Promise.resolve(null),
};

export interface EffectPayload {
  /** Só na primeira execução do job: simula trabalho lento (ponto de kill/drain). */
  readonly sleepFirstRunMs?: number;
  /** Falha recuperável enquanto `attempt` for menor ou igual a este valor. */
  readonly failRetryableUntilAttempt?: number;
  readonly failTerminal?: boolean;
}

export interface HoldPayload {
  readonly holdMs: number;
}

/** Sonda de concorrência, usada apenas por testes in-process. */
export const concurrencyProbe = { active: 0, max: 0 };

export function resetConcurrencyProbe(): void {
  concurrencyProbe.active = 0;
  concurrencyProbe.max = 0;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Handlers de fixture. Efeitos são gravados por `job_id` com ON CONFLICT DO NOTHING:
 * reentrega não duplica o efeito, e o teste confere que ele foi aplicado uma vez.
 */
export function createFixtureHandlers(pool: Pool): JobHandler[] {
  const effect: JobHandler<EffectPayload> = {
    type: 'fixture.effect',
    payloadVersion: 1,
    async handle(payload, context: JobHandlerContext) {
      await pool.query(
        'INSERT INTO worker_fixture_runs (job_id, attempt, pid) VALUES ($1, $2, $3)',
        [context.jobId, context.attempt, process.pid],
      );
      if (payload.failTerminal === true)
        throw new TerminalJobError('job_handler_error');
      if (
        payload.failRetryableUntilAttempt !== undefined &&
        context.attempt <= payload.failRetryableUntilAttempt
      ) {
        throw new RetryableJobError('job_handler_error');
      }
      if (payload.sleepFirstRunMs !== undefined) {
        const runs = await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM worker_fixture_runs WHERE job_id = $1',
          [context.jobId],
        );
        if (Number(runs.rows[0]?.count) === 1) {
          await sleep(payload.sleepFirstRunMs, context.signal);
        }
      }
      await pool.query(
        `INSERT INTO worker_fixture_effects (job_id, applied_by_attempt)
         VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING`,
        [context.jobId, context.attempt],
      );
    },
  };

  const hold: JobHandler<HoldPayload> = {
    type: 'fixture.hold',
    payloadVersion: 1,
    async handle(payload, context) {
      concurrencyProbe.active += 1;
      concurrencyProbe.max = Math.max(
        concurrencyProbe.max,
        concurrencyProbe.active,
      );
      try {
        await sleep(payload.holdMs, context.signal);
      } finally {
        concurrencyProbe.active -= 1;
      }
    },
  };

  return [effect, hold];
}
