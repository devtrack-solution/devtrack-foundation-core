import { NestFactory } from '@nestjs/core';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import type { INestApplicationContext } from '@nestjs/common';
import type { IdentityAccessResolver } from '../../src/core/application/security/authentication.ports';
import {
  ACTIVITY_STORE,
  JOB_IDENTITY_RESOLVER,
  QueueBullmqModule,
} from '../../src/native/queue-bullmq';
import { queueBullmqOptionsFromEnv } from '../../src/worker';
import {
  PERSISTENCE_DATA_SOURCE,
  PersistenceTypeOrmModule,
  persistenceConfigFromEnv,
} from '../../src/native/persistence-typeorm';
import { PERSISTENCE_CONTRIBUTIONS } from '../../src/native/persistence-typeorm/persistence-contributions';
import {
  ACTIVITIES_PERSISTENCE,
  TypeOrmActivityStore,
} from '../../src/native/persistence-typeorm/activities';
import type { DataSource } from 'typeorm';

export const PG_PASSWORD = 'foundation-test-only';
export const PG_DATABASE = 'foundation_worker';

export interface Infrastructure {
  readonly redis: StartedRedisContainer;
  readonly postgres: StartedPostgreSqlContainer;
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS worker_fixture_runs (
    id bigserial PRIMARY KEY,
    job_id text NOT NULL,
    attempt integer NOT NULL,
    pid integer NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS worker_fixture_effects (
    job_id text PRIMARY KEY,
    applied_by_attempt integer NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  );
`;

/** Sobe Redis e PostgreSQL reais. Falhas de Docker geram mensagem explícita. */
export async function startInfrastructure(): Promise<Infrastructure> {
  try {
    const [redis, postgres] = await Promise.all([
      new RedisContainer('redis:7-alpine').start(),
      new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase(PG_DATABASE)
        .withUsername('foundation')
        .withPassword(PG_PASSWORD)
        .start(),
    ]);
    const env: Record<string, string> = {
      FOUNDATION_REDIS_HOST: redis.getHost(),
      FOUNDATION_REDIS_PORT: String(redis.getPort()),
      FOUNDATION_DB_HOST: postgres.getHost(),
      FOUNDATION_DB_PORT: String(postgres.getPort()),
      FOUNDATION_DB_NAME: PG_DATABASE,
      FOUNDATION_DB_USER: postgres.getUsername(),
      FOUNDATION_DB_PASSWORD: PG_PASSWORD,
      FOUNDATION_DB_APPLICATION_NAME: 'worker-test',
      FOUNDATION_DB_POOL_MAX: '5',
      FOUNDATION_DB_MIGRATIONS_RUN: 'true',
    };
    const client = new Client({
      host: env.FOUNDATION_DB_HOST,
      port: postgres.getPort(),
      database: PG_DATABASE,
      user: env.FOUNDATION_DB_USER,
      password: PG_PASSWORD,
    });
    await client.connect();
    await client.query(LEDGER_SQL);
    await client.end();
    return {
      redis,
      postgres,
      env,
      async stop() {
        await Promise.all([redis.stop(), postgres.stop()]);
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (Redis + PostgreSQL). Cause: ${cause}`,
    );
  }
}

/** Ambiente de um worker/produtor com fila isolada por teste. */
export function workerEnv(
  infra: Infrastructure,
  queueName: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...infra.env,
    FOUNDATION_JOBS_QUEUE: queueName,
    FOUNDATION_JOBS_BACKOFF_BASE_MS: '200',
    FOUNDATION_JOBS_BACKOFF_MAX_MS: '400',
    FOUNDATION_JOBS_TIMEOUT_MS: '30000',
    FOUNDATION_JOBS_MAX_ATTEMPTS: '5',
    FOUNDATION_WORKER_LOCK_MS: '1000',
    FOUNDATION_WORKER_STALLED_INTERVAL_MS: '500',
    FOUNDATION_WORKER_MAX_STALLED: '5',
    FOUNDATION_WORKER_DRAIN_DEADLINE_MS: '10000',
    ...overrides,
  };
}

const contributions = [
  ACTIVITIES_PERSISTENCE,
  ...PERSISTENCE_CONTRIBUTIONS.filter(
    (c) => c.moduleId !== ACTIVITIES_PERSISTENCE.moduleId,
  ),
];

class ProducerRootModule {}

/** Produtor sem consumo: enfileira com o mesmo JobSubmitter usado pela API. */
export async function startProducer(
  env: Record<string, string>,
  identity: IdentityAccessResolver,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(
    {
      module: ProducerRootModule,
      imports: [
        QueueBullmqModule.register({
          options: queueBullmqOptionsFromEnv(env),
          consume: false,
          imports: [
            PersistenceTypeOrmModule.register({
              contributions,
              config: persistenceConfigFromEnv(env),
            }),
          ],
          ports: [
            {
              provide: ACTIVITY_STORE,
              useFactory: (dataSource: DataSource) =>
                new TypeOrmActivityStore(dataSource),
              inject: [PERSISTENCE_DATA_SOURCE],
            },
            { provide: JOB_IDENTITY_RESOLVER, useValue: identity },
          ],
        }),
      ],
    },
    { logger: false },
  );
}

export function fixturePool(infra: Infrastructure): Pool {
  return new Pool({
    host: infra.env.FOUNDATION_DB_HOST,
    port: Number(infra.env.FOUNDATION_DB_PORT),
    database: PG_DATABASE,
    user: infra.env.FOUNDATION_DB_USER,
    password: PG_PASSWORD,
    max: 3,
  });
}

export async function waitFor<T>(
  read: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
