import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { Idempotent } from '../src/core/presentation/http/idempotency';
import {
  createFixtureState,
  createIdempotencyFixtureApp,
  type FixtureState,
} from './fixtures/idempotency-app';

describe('Idempotency HTTP interceptor (e2e)', () => {
  let app: INestApplication;
  let state: FixtureState;

  const server = (): Server => app.getHttpServer() as Server;

  beforeEach(async () => {
    ({ app, state } = await createIdempotencyFixtureApp(createFixtureState()));
  });

  afterEach(async () => {
    state.openGate();
    await app.close();
  });

  const create = (token: string, key: string | undefined, body: unknown) => {
    const req = request(server())
      .post('/fixture/contacts')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
    return key === undefined ? req : req.set('Idempotency-Key', key);
  };

  it('executes the first intent and replays the identical response without re-running', async () => {
    const first = await create('token-a', 'req-1', { name: 'Ana' });
    const second = await create('token-a', 'req-1', { name: 'Ana' });

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(state.executions).toBe(1);
  });

  it('answers 409 when the same key arrives with a different body', async () => {
    await create('token-a', 'req-2', { name: 'Ana' });
    const conflict = await create('token-a', 'req-2', { name: 'Bia' });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      statusCode: 409,
      error: 'idempotency_conflict',
    });
    expect(conflict.headers['x-correlation-id']).toBeDefined();
    expect(state.executions).toBe(1);
  });

  it('answers 400 when the Idempotency-Key header is missing', async () => {
    const missing = await create('token-a', undefined, { name: 'Ana' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: 'idempotency_key_required' });
    expect(state.executions).toBe(0);
  });

  it('answers 400 for an invalid key', async () => {
    const invalid = await create('token-a', 'has space', { name: 'Ana' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: 'idempotency_key_invalid' });
    expect(state.executions).toBe(0);
  });

  it('denies unauthenticated requests before reading the key', async () => {
    const response = await request(server())
      .post('/fixture/contacts')
      .set('Idempotency-Key', 'req-anon')
      .send({ name: 'Ana' });
    expect(response.status).toBe(401);
    expect(state.executions).toBe(0);
  });

  it('keeps the same key separate between subjects and tenants', async () => {
    const a = await create('token-a', 'shared-key', { name: 'Ana' });
    const b = await create('token-b', 'shared-key', { name: 'Ana' });
    const x = await create('token-x', 'shared-key', { name: 'Ana' });

    expect([a.status, b.status, x.status]).toEqual([201, 201, 201]);
    expect(state.executions).toBe(3);
  });

  it('denies a replay when the actor lost the permission, without leaking the stored result', async () => {
    await create('token-a', 'req-revoked', { name: 'Ana' });
    state.principals.set('subject-a', { tenantId: 't1', permissions: [] });

    const denied = await create('token-a', 'req-revoked', { name: 'Ana' });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('id');
    expect(JSON.stringify(denied.body)).not.toContain('c-1');
    expect(state.executions).toBe(1);
  });

  it('keeps the declared status on replay for non-default codes', async () => {
    const first = await request(server())
      .post('/fixture/accepted')
      .set('Authorization', 'Bearer token-a')
      .set('Idempotency-Key', 'acc-1')
      .send({ name: 'Ana' });
    const second = await request(server())
      .post('/fixture/accepted')
      .set('Authorization', 'Bearer token-a')
      .set('Idempotency-Key', 'acc-1')
      .send({ name: 'Ana' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('lets a client retry after a 400 caused before any effect, with the same key', async () => {
    const rejected = await create('token-a', 'req-fix', {});
    expect(rejected.status).toBe(400);

    const corrected = await create('token-a', 'req-fix', { name: 'Ana' });
    expect(corrected.status).toBe(201);
    expect(corrected.body).toMatchObject({ name: 'Ana' });
    expect(state.executions).toBe(1);
  });

  it('reports an unknown outcome and never re-runs the effect', async () => {
    const first = await request(server())
      .post('/fixture/flaky')
      .set('Authorization', 'Bearer token-a')
      .set('Idempotency-Key', 'flaky-1');
    expect(first.status).toBe(500);

    const again = await request(server())
      .post('/fixture/flaky')
      .set('Authorization', 'Bearer token-a')
      .set('Idempotency-Key', 'flaky-1');
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'idempotency_outcome_unknown' });
    expect(state.executions).toBe(1);
  });

  it('answers 409 with Retry-After while the first intent is in progress', async () => {
    // supertest só envia ao ser "thenado"; then() dispara a requisição agora.
    const running = request(server())
      .post('/fixture/slow')
      .set('Authorization', 'Bearer token-a')
      .set('Idempotency-Key', 'slow-1')
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const concurrent = await request(server())
      .post('/fixture/slow')
      .set('Authorization', 'Bearer token-a')
      .set('Idempotency-Key', 'slow-1');
    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toMatchObject({ error: 'idempotency_in_progress' });
    expect(concurrent.headers['retry-after']).toBe('1');

    state.openGate();
    const finished = await running;
    expect(finished.status).toBe(201);
    expect(state.executions).toBe(1);
  });

  it('rejects an invalid policy at declaration time', () => {
    expect(() =>
      Idempotent({ operationId: 'Bad Operation', retentionMs: 60_000 }),
    ).toThrow('idempotency_policy_invalid');
    expect(() =>
      Idempotent({ operationId: 'contacts.create', retentionMs: 10 }),
    ).toThrow('idempotency_policy_invalid');
  });
});
