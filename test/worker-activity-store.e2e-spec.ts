import type { INestApplicationContext } from '@nestjs/common';
import { ACTIVITY_STORE } from '../src/native/queue-bullmq';
import type { ActivityStore } from '../src/core/application/activities/activity-store.port';
import type { ActivityRecord } from '../src/core/application/activities/activity.model';
import { fixtureIdentity } from './fixtures/worker-fixtures';
import {
  startInfrastructure,
  startProducer,
  workerEnv,
  type Infrastructure,
} from './fixtures/worker-harness';

jest.setTimeout(300_000);

let infra: Infrastructure;
let app: INestApplicationContext;
let store: ActivityStore;

const record = (overrides: Partial<ActivityRecord> = {}): ActivityRecord => ({
  id: 'activity-store-1',
  type: 'fixture.effect',
  state: 'queued',
  attempts: 0,
  lastErrorCode: null,
  correlationId: 'corr-1',
  subjectId: 'subject-ok',
  tenantId: 'tenant-a',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

beforeAll(async () => {
  infra = await startInfrastructure();
  app = await startProducer(workerEnv(infra, 'store-test'), fixtureIdentity);
  store = app.get<ActivityStore>(ACTIVITY_STORE);
});

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

describe('TypeOrmActivityStore (PostgreSQL real)', () => {
  it('insere uma vez e não sobrescreve em duplicata', async () => {
    await expect(store.insertIfAbsent(record())).resolves.toBe(true);
    await expect(
      store.insertIfAbsent(record({ state: 'failed_terminal' })),
    ).resolves.toBe(false);

    await expect(
      store.find('activity-store-1', 'tenant-a'),
    ).resolves.toMatchObject({
      state: 'queued',
      attempts: 0,
    });
  });

  it('avança o estado e ignora escrita com tentativa menor (executor obsoleto)', async () => {
    await store.save(
      record({
        id: 'activity-store-2',
        state: 'running',
        attempts: 2,
        updatedAt: 2_000,
      }),
    );
    await store.save(
      record({
        id: 'activity-store-2',
        state: 'running',
        attempts: 1,
        updatedAt: 3_000,
      }),
    );

    await expect(
      store.find('activity-store-2', 'tenant-a'),
    ).resolves.toMatchObject({
      state: 'running',
      attempts: 2,
      updatedAt: 2_000,
    });
  });

  it('consulta por tenant sem cruzar tenants e distingue ausência de tenant', async () => {
    await store.save(
      record({
        id: 'activity-store-3',
        tenantId: null,
        state: 'succeeded',
        attempts: 1,
        updatedAt: 4_000,
      }),
    );

    await expect(
      store.find('activity-store-1', 'tenant-b'),
    ).resolves.toBeNull();
    await expect(store.find('activity-store-1', null)).resolves.toBeNull();
    await expect(store.find('activity-store-3', null)).resolves.toMatchObject({
      state: 'succeeded',
      tenantId: null,
    });
    await expect(
      store.find('activity-store-3', 'tenant-a'),
    ).resolves.toBeNull();
  });

  it('persiste o código de erro, nunca mensagem bruta', async () => {
    await store.save(
      record({
        id: 'activity-store-4',
        state: 'failed_terminal',
        attempts: 3,
        lastErrorCode: 'job_timeout',
        updatedAt: 5_000,
      }),
    );

    await expect(
      store.find('activity-store-4', 'tenant-a'),
    ).resolves.toMatchObject({
      state: 'failed_terminal',
      attempts: 3,
      lastErrorCode: 'job_timeout',
    });
  });
});
