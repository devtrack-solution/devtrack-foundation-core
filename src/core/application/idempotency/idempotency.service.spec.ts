/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import { createHash, randomUUID } from 'node:crypto';
import type { OperationContext } from '../context/operation-context';
import { AuthorizationError } from '../security/operation-authorizer';
import { AuthenticationError } from '../security/authentication.service';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
  IdempotencyOutcomeUnknownError,
  IdempotencyPolicyError,
  IdempotencyResultError,
  IdempotencyTerminalFailureError,
  IdempotentRetryableFailure,
  IdempotentTerminalFailure,
} from './idempotency.errors';
import { IdempotencyService } from './idempotency.service';
import { InMemoryIdempotencyStore } from './in-memory-idempotency.store';
import type {
  IdempotencyCrypto,
  IdempotentOperation,
  JsonValue,
} from './idempotency.types';

const crypto: IdempotencyCrypto = {
  sha256Hex: (input) =>
    createHash('sha256').update(input, 'utf8').digest('hex'),
  randomToken: () => randomUUID(),
};

const RETENTION = 60_000;

function contextOf(subjectId: string, tenantId?: string): OperationContext {
  return {
    correlationId: `corr-${subjectId}`,
    principal: {
      subjectId,
      ...(tenantId === undefined ? {} : { tenantId }),
      permissions: ['contacts:write'],
    },
    deadlineAt: 10_000_000,
  };
}

function harness(startAt = 1_000) {
  let current = startAt;
  const store = new InMemoryIdempotencyStore();
  const clock = {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
  return {
    service: new IdempotencyService({ store, crypto, clock }),
    store,
    clock,
  };
}

function operationWith(
  authorize: jest.Mock<Promise<void>, [OperationContext]> = jest
    .fn<Promise<void>, [OperationContext]>()
    .mockResolvedValue(undefined),
): IdempotentOperation<{ name: string }> {
  return {
    policy: { operationId: 'contacts.create', retentionMs: RETENTION },
    authorize,
  };
}

const PAYLOAD = { name: 'Ana' };

describe('IdempotencyService', () => {
  it('replays an authorized completed intent without running the effect again', async () => {
    const { service } = harness();
    const run = jest.fn(async () => ({ id: 'c-1', created: true }));
    const context = contextOf('subject-a', 'tenant-a');

    const first = await service.execute(
      context,
      operationWith(),
      'req-1',
      PAYLOAD,
      run,
    );
    const second = await service.execute(
      context,
      operationWith(),
      'req-1',
      PAYLOAD,
      run,
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      result: { id: 'c-1', created: true },
      replayed: false,
    });
    expect(second).toEqual({
      result: { id: 'c-1', created: true },
      replayed: true,
    });
  });

  it('re-runs the authorization check on replay and denies a revoked actor', async () => {
    const { service } = harness();
    const run = jest.fn(async () => ({ ok: true }));
    const context = contextOf('subject-a', 'tenant-a');
    await service.execute(context, operationWith(), 'req-1', PAYLOAD, run);

    const revoked = jest
      .fn<Promise<void>, [OperationContext]>()
      .mockRejectedValue(new AuthorizationError());
    await expect(
      service.execute(context, operationWith(revoked), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(AuthorizationError);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not reveal a stored result when authentication fails during replay', async () => {
    const { service } = harness();
    const run = jest.fn(async () => ({ ok: true }));
    const context = contextOf('subject-a', 'tenant-a');
    await service.execute(context, operationWith(), 'req-1', PAYLOAD, run);

    const blocked = jest
      .fn<Promise<void>, [OperationContext]>()
      .mockRejectedValue(new AuthenticationError('invalid_credentials'));
    await expect(
      service.execute(context, operationWith(blocked), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects the same key with a divergent payload without running the effect', async () => {
    const { service } = harness();
    const run = jest.fn(async () => ({ ok: true }));
    const context = contextOf('subject-a', 'tenant-a');
    await service.execute(context, operationWith(), 'req-1', PAYLOAD, run);

    await expect(
      service.execute(context, operationWith(), 'req-1', { name: 'Bia' }, run),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers in-progress while the first intent has not completed', async () => {
    const { service } = harness();
    let release: (value: JsonValue) => void = () => undefined;
    const pending = new Promise<JsonValue>((resolve) => {
      release = resolve;
    });
    const context = contextOf('subject-a', 'tenant-a');
    const slow = service.execute(
      context,
      operationWith(),
      'req-1',
      PAYLOAD,
      () => pending as Promise<never>,
    );

    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, jest.fn()),
    ).rejects.toThrow(IdempotencyInProgressError);

    release({ id: 'c-1' });
    await expect(slow).resolves.toEqual({
      result: { id: 'c-1' },
      replayed: false,
    });
  });

  it('keeps keys of other tenants and subjects separate', async () => {
    const { service } = harness();
    const run = jest.fn(async () => ({ ok: true }));

    await service.execute(
      contextOf('subject-a', 'tenant-a'),
      operationWith(),
      'req-1',
      PAYLOAD,
      run,
    );
    await service.execute(
      contextOf('subject-a', 'tenant-b'),
      operationWith(),
      'req-1',
      PAYLOAD,
      run,
    );
    await service.execute(
      contextOf('subject-b', 'tenant-a'),
      operationWith(),
      'req-1',
      PAYLOAD,
      run,
    );

    expect(run).toHaveBeenCalledTimes(3);
  });

  it('treats a key as a new intent after the retention window (injected clock)', async () => {
    const { service, clock } = harness();
    const run = jest.fn(async () => ({ ok: true }));
    const context = contextOf('subject-a', 'tenant-a');

    await service.execute(context, operationWith(), 'req-1', PAYLOAD, run);
    clock.advance(RETENTION - 1);
    await service.execute(context, operationWith(), 'req-1', PAYLOAD, run);
    expect(run).toHaveBeenCalledTimes(1);

    clock.advance(1);
    const renewed = await service.execute(
      context,
      operationWith(),
      'req-1',
      { name: 'Bia' },
      run,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(renewed.replayed).toBe(false);
  });

  it('retries a retryable failure with the same key', async () => {
    const { service } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    const run = jest
      .fn<Promise<JsonValue>, []>()
      .mockRejectedValueOnce(new IdempotentRetryableFailure())
      .mockResolvedValueOnce({ ok: true });

    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(IdempotentRetryableFailure);
    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).resolves.toEqual({ result: { ok: true }, replayed: false });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('replays a terminal failure without running again', async () => {
    const { service } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    const run = jest.fn(async (): Promise<JsonValue> => {
      throw new IdempotentTerminalFailure();
    });

    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(IdempotentTerminalFailure);
    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(IdempotencyTerminalFailureError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never re-runs an unknown outcome and reports it', async () => {
    const { service } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    const run = jest.fn(async (): Promise<JsonValue> => {
      throw new Error('socket hang up');
    });

    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow('socket hang up');
    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(IdempotencyOutcomeUnknownError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('records a non-replayable result as unknown and does not return it', async () => {
    const { service, store } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    const run = jest.fn(
      async () => ({ at: new Date(0) }) as unknown as JsonValue,
    );

    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(IdempotencyResultError);
    expect(store.size()).toBe(1);
    await expect(
      service.execute(context, operationWith(), 'req-1', PAYLOAD, run),
    ).rejects.toThrow(IdempotencyOutcomeUnknownError);
  });

  it('validates the key before authorizing, and authorizes before claiming', async () => {
    const { service, store } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    const authorize = jest
      .fn<Promise<void>, [OperationContext]>()
      .mockResolvedValue(undefined);

    await expect(
      service.execute(
        context,
        operationWith(authorize),
        undefined,
        PAYLOAD,
        jest.fn(),
      ),
    ).rejects.toThrow(IdempotencyKeyRequiredError);
    await expect(
      service.execute(
        context,
        operationWith(authorize),
        'bad key',
        PAYLOAD,
        jest.fn(),
      ),
    ).rejects.toThrow(IdempotencyKeyInvalidError);
    expect(authorize).not.toHaveBeenCalled();
    expect(store.size()).toBe(0);
  });

  it('rejects an invalid policy', async () => {
    const { service } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    const bad: IdempotentOperation<{ name: string }> = {
      policy: { operationId: 'Contacts Create', retentionMs: RETENTION },
      authorize: jest
        .fn<Promise<void>, [OperationContext]>()
        .mockResolvedValue(undefined),
    };
    await expect(
      service.execute(context, bad, 'req-1', PAYLOAD, jest.fn()),
    ).rejects.toThrow(IdempotencyPolicyError);
  });
});

describe('InMemoryIdempotencyStore purge', () => {
  it('removes expired records in bounded batches', async () => {
    const { service, store, clock } = harness();
    const context = contextOf('subject-a', 'tenant-a');
    for (let index = 0; index < 5; index += 1) {
      await service.execute(
        context,
        operationWith(),
        `req-${index}`,
        PAYLOAD,
        async () => ({ index }),
      );
    }
    clock.advance(RETENTION);

    expect(await store.purgeExpired({ now: clock.now(), limit: 2 })).toBe(2);
    expect(store.size()).toBe(3);
    expect(await store.purgeExpired({ now: clock.now(), limit: 10 })).toBe(3);
    expect(store.size()).toBe(0);
  });

  it('keeps unexpired records', async () => {
    const { service, store, clock } = harness();
    await service.execute(
      contextOf('subject-a', 'tenant-a'),
      operationWith(),
      'req-1',
      PAYLOAD,
      async () => ({}),
    );
    expect(await store.purgeExpired({ now: clock.now(), limit: 10 })).toBe(0);
    expect(store.size()).toBe(1);
  });

  it.each([0, -1, 1.5, 1_001])('rejects batch limit %s', async (limit) => {
    const { store } = harness();
    await expect(store.purgeExpired({ now: 0, limit })).rejects.toThrow(
      RangeError,
    );
  });
});
