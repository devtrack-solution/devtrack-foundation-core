/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import { createHash, randomUUID } from 'node:crypto';
import type { AuditEntry, AuditWriter } from '../audit/audit-writer.port';
import type { OperationContext } from '../context/operation-context';
import type { UnitOfWork } from '../persistence/unit-of-work.port';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyOutcomeUnknownError,
  IdempotencyPolicyError,
  IdempotencyResultError,
  IdempotencyStaleClaimError,
  IdempotentRetryableFailure,
} from './idempotency.errors';
import { contextualKeyOf } from './idempotency.key';
import { IdempotencyService } from './idempotency.service';
import { InMemoryIdempotencyStore } from './in-memory-idempotency.store';
import type {
  IdempotencyCrypto,
  IdempotencyUnitOfWorkResources,
  IdempotentLease,
  IdempotentOperation,
  JsonValue,
} from './idempotency.types';

const crypto: IdempotencyCrypto = {
  sha256Hex: (input) =>
    createHash('sha256').update(input, 'utf8').digest('hex'),
  randomToken: () => randomUUID(),
};

const RETENTION = 60_000;
const LEASE = 5_000;
const PAYLOAD = { name: 'Ana' };

function contextOf(subjectId = 'subject-r', tenantId = 'tenant-r') {
  const context: OperationContext = {
    correlationId: `corr-${subjectId}`,
    principal: { subjectId, tenantId, permissions: ['contacts:write'] },
    deadlineAt: 10_000_000,
  };
  return context;
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
  const service = new IdempotencyService({
    store,
    crypto,
    clock,
    leaseMs: LEASE,
  });
  return { service, store, clock };
}

function operation(): IdempotentOperation<{ name: string }> {
  return {
    policy: { operationId: 'contacts.create', retentionMs: RETENTION },
    authorize: async () => undefined,
  };
}

describe('IdempotencyService lease and fencing', () => {
  it('extends the lease while the token and version still match', async () => {
    const { service, clock } = harness();
    const context = contextOf();
    const other = jest.fn(async (): Promise<JsonValue> => ({ by: 'other' }));

    const result = await service.execute(
      context,
      operation(),
      'hb-valid',
      PAYLOAD,
      async (_context, _payload, lease: IdempotentLease) => {
        clock.advance(4_000);
        await lease.renew();
        clock.advance(4_000);
        // Passou do lease original (5 s), mas o renovado ainda vale.
        await expect(
          service.execute(context, operation(), 'hb-valid', PAYLOAD, other),
        ).rejects.toThrow(IdempotencyInProgressError);
        return { by: 'owner' };
      },
    );

    expect(result).toEqual({ result: { by: 'owner' }, replayed: false });
    expect(other).not.toHaveBeenCalled();
  });

  it('refuses to renew and to commit after another executor re-claimed', async () => {
    const { service, store, clock } = harness();
    const context = contextOf();
    const renewal = { error: undefined as unknown };

    const stale = service.execute(
      context,
      operation(),
      'hb-stale',
      PAYLOAD,
      async (_context, _payload, lease: IdempotentLease) => {
        clock.advance(LEASE + 1_000);
        await service.execute(
          context,
          operation(),
          'hb-stale',
          PAYLOAD,
          async () => ({ by: 'B' }),
        );
        try {
          await lease.renew();
        } catch (error) {
          renewal.error = error;
        }
        return { by: 'A' };
      },
    );

    await expect(stale).rejects.toThrow(IdempotencyStaleClaimError);
    expect(renewal.error).toBeInstanceOf(IdempotencyStaleClaimError);
    const record = await store.find(keyFor(context, 'hb-stale'));
    expect(record?.state).toBe('completed');
    expect(record?.result).toEqual({ by: 'B' });
  });

  it('does not let an executor commit once its lease expired, even without a successor', async () => {
    const { service, store, clock } = harness();
    const context = contextOf();
    const run = jest.fn(async (): Promise<JsonValue> => ({ n: 1 }));

    await expect(
      service.execute(
        context,
        operation(),
        'lease-expired',
        PAYLOAD,
        async () => {
          clock.advance(LEASE + 1);
          return { n: 0 };
        },
      ),
    ).rejects.toThrow(IdempotencyStaleClaimError);

    const key = keyFor(context, 'lease-expired');
    expect((await store.find(key))?.state).toBe('in_progress');
    // O registro segue reivindicável: outro executor recupera após o lease.
    const recovered = await service.execute(
      context,
      operation(),
      'lease-expired',
      PAYLOAD,
      run,
    );
    expect(recovered).toEqual({ result: { n: 1 }, replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('recovers an abandoned in_progress intent with the same fingerprint after the lease', async () => {
    const { service, clock } = harness();
    const context = contextOf();
    // Executor A "cai" no meio: a promessa nunca resolve e nada é gravado.
    void service.execute(
      context,
      operation(),
      'abandoned',
      PAYLOAD,
      () => new Promise<JsonValue>(() => undefined),
    );
    await flush();
    clock.advance(LEASE + 1);

    const run = jest.fn(async (): Promise<JsonValue> => ({ id: 'B' }));
    const result = await service.execute(
      context,
      operation(),
      'abandoned',
      PAYLOAD,
      run,
    );
    expect(result).toEqual({ result: { id: 'B' }, replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps an abandoned intent with a different fingerprint in conflict while retained', async () => {
    const { service, clock } = harness();
    const context = contextOf();
    void service.execute(
      context,
      operation(),
      'abandoned-diff',
      PAYLOAD,
      () => new Promise<JsonValue>(() => undefined),
    );
    await flush();
    clock.advance(LEASE + 1);

    await expect(
      service.execute(
        context,
        operation(),
        'abandoned-diff',
        { name: 'Bia' },
        jest.fn(async () => ({})),
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('rejects a lease outside the allowed range at construction', () => {
    const store = new InMemoryIdempotencyStore();
    const clock = { now: () => 1 };
    expect(
      () => new IdempotencyService({ store, crypto, clock, leaseMs: 999 }),
    ).toThrow(IdempotencyPolicyError);
    expect(
      () => new IdempotencyService({ store, crypto, clock, leaseMs: 600_001 }),
    ).toThrow(IdempotencyPolicyError);
  });
});

describe('outcome_unknown reconciliation', () => {
  it('keeps the state when the reconciler cannot prove the outcome', async () => {
    const { service, store } = harness();
    const context = contextOf();
    const key = await keyAfterUnknown(service, context, 'recon-unresolved');
    const run = jest.fn(async (): Promise<JsonValue> => ({}));

    const status = await service.reconcileOutcomeUnknown(key, {
      reconcile: async () => ({ outcome: 'unresolved' }),
    });

    expect(status).toBe('unresolved');
    expect((await store.find(key))?.state).toBe('outcome_unknown');
    await expect(
      service.execute(context, operation(), 'recon-unresolved', PAYLOAD, run),
    ).rejects.toThrow(IdempotencyOutcomeUnknownError);
    expect(run).not.toHaveBeenCalled();
  });

  it('replays the confirmed result without running the effect again', async () => {
    const { service } = harness();
    const context = contextOf();
    const key = await keyAfterUnknown(service, context, 'recon-confirmed');
    const run = jest.fn(async (): Promise<JsonValue> => ({}));

    const status = await service.reconcileOutcomeUnknown(key, {
      reconcile: async () => ({
        outcome: 'confirmed',
        result: { id: 'ext-1' },
      }),
    });
    const replay = await service.execute(
      context,
      operation(),
      'recon-confirmed',
      PAYLOAD,
      run,
    );

    expect(status).toBe('completed');
    expect(replay).toEqual({ result: { id: 'ext-1' }, replayed: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('allows a new attempt only when the reconciler proves nothing was performed', async () => {
    const { service } = harness();
    const context = contextOf();
    const key = await keyAfterUnknown(service, context, 'recon-not-performed');
    const run = jest.fn(async (): Promise<JsonValue> => ({ id: 'retry' }));

    const status = await service.reconcileOutcomeUnknown(key, {
      reconcile: async () => ({ outcome: 'not_performed' }),
    });
    const result = await service.execute(
      context,
      operation(),
      'recon-not-performed',
      PAYLOAD,
      run,
    );

    expect(status).toBe('failed_retryable');
    expect(result).toEqual({ result: { id: 'retry' }, replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports absent and non-unknown records without calling the reconciler', async () => {
    const { service } = harness();
    const reconcile = jest.fn(async () => ({ outcome: 'unresolved' as const }));
    expect(
      await service.reconcileOutcomeUnknown('missing', { reconcile }),
    ).toBe('absent');

    const context = contextOf();
    await service.execute(
      context,
      operation(),
      'recon-ok',
      PAYLOAD,
      async () => ({}),
    );
    expect(
      await service.reconcileOutcomeUnknown(keyFor(context, 'recon-ok'), {
        reconcile,
      }),
    ).toBe('not_unknown');
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('InMemoryIdempotencyStore heartbeat and purge', () => {
  it('rejects a heartbeat with a stale version', async () => {
    const { store } = harness();
    await store.begin({
      key: 'hb-store',
      operationId: 'contacts.create',
      subjectId: 's',
      fingerprint: 'fp',
      claimToken: 'token',
      now: 1,
      expiresAt: 1 + RETENTION,
      leaseExpiresAt: 1 + LEASE,
    });
    await expect(
      store.heartbeat({
        key: 'hb-store',
        claimToken: 'token',
        version: 99,
        now: 2,
        leaseExpiresAt: 2 + LEASE,
      }),
    ).rejects.toThrow(IdempotencyStaleClaimError);
    await store.heartbeat({
      key: 'hb-store',
      claimToken: 'token',
      version: 1,
      now: 2,
      leaseExpiresAt: 2 + LEASE,
    });
    expect((await store.find('hb-store'))?.version).toBe(1);
  });

  it('never purges an in_progress record, even past its retention', async () => {
    const { store } = harness();
    await store.begin({
      key: 'live-purge',
      operationId: 'contacts.create',
      subjectId: 's',
      fingerprint: 'fp',
      claimToken: 'token',
      now: 1,
      expiresAt: 2,
      leaseExpiresAt: 1 + LEASE,
    });
    expect(await store.purgeExpired({ now: 1_000, limit: 10 })).toBe(0);
    expect((await store.find('live-purge'))?.state).toBe('in_progress');
  });
});

describe('executeInUnitOfWork', () => {
  interface Resources extends IdempotencyUnitOfWorkResources {
    readonly rows: string[];
  }

  /** UnitOfWork de teste sem isolamento: valida contratos de chamada, não rollback. */
  function fakeUnitOfWork(
    store: InMemoryIdempotencyStore,
    audit: AuditEntry[],
  ) {
    const writer: AuditWriter = {
      append: async (entry) => {
        audit.push(entry);
      },
    };
    const rows: string[] = [];
    const unitOfWork: UnitOfWork<Resources> = {
      run: async (work) => work({ idempotency: store, audit: writer, rows }),
    };
    return { unitOfWork, rows };
  }

  it('confirms business write, result and audit once, and replays without auditing again', async () => {
    const { service, store } = harness();
    const audit: AuditEntry[] = [];
    const { unitOfWork, rows } = fakeUnitOfWork(store, audit);
    const context = contextOf();
    const transaction = {
      unitOfWork,
      auditOf: () => ({ action: 'contacts.create', target: 'contact:tx-1' }),
    };
    const run = async (
      _context: OperationContext,
      payload: { name: string },
      resources: Resources,
    ) => {
      resources.rows.push(payload.name);
      return { id: 'c-1' };
    };

    const first = await service.executeInUnitOfWork(
      context,
      operation(),
      'tx-1',
      PAYLOAD,
      transaction,
      run,
    );
    const replay = await service.executeInUnitOfWork(
      context,
      operation(),
      'tx-1',
      PAYLOAD,
      transaction,
      run,
    );

    expect(first).toEqual({ result: { id: 'c-1' }, replayed: false });
    expect(replay).toEqual({ result: { id: 'c-1' }, replayed: true });
    expect(rows).toEqual(['Ana']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'contacts.create',
      target: 'contact:tx-1',
      outcome: 'succeeded',
    });
  });

  it('records a retryable failure and writes no audit entry', async () => {
    const { service, store } = harness();
    const audit: AuditEntry[] = [];
    const { unitOfWork } = fakeUnitOfWork(store, audit);
    const context = contextOf();
    const transaction = {
      unitOfWork,
      auditOf: () => ({ action: 'contacts.create', target: 'contact:tx-2' }),
    };

    await expect(
      service.executeInUnitOfWork(
        context,
        operation(),
        'tx-2',
        PAYLOAD,
        transaction,
        async () => {
          throw new IdempotentRetryableFailure();
        },
      ),
    ).rejects.toThrow(IdempotentRetryableFailure);

    const key = keyFor(contextOf(), 'tx-2');
    expect((await store.find(key))?.state).toBe('failed_retryable');
    expect(audit).toHaveLength(0);
  });

  it('records a terminal failure for a result that is not canonical JSON', async () => {
    const { service, store } = harness();
    const audit: AuditEntry[] = [];
    const { unitOfWork } = fakeUnitOfWork(store, audit);
    const transaction = {
      unitOfWork,
      auditOf: () => ({ action: 'contacts.create', target: 'contact:tx-3' }),
    };

    await expect(
      service.executeInUnitOfWork(
        contextOf(),
        operation(),
        'tx-3',
        PAYLOAD,
        transaction,
        async () =>
          ({
            when: new Date(0),
          }) as unknown as Promise<JsonValue>,
      ),
    ).rejects.toThrow(IdempotencyResultError);

    const key = keyFor(contextOf(), 'tx-3');
    expect((await store.find(key))?.state).toBe('failed_terminal');
    expect(audit).toHaveLength(0);
  });
});

/** Chave contextual que o serviço grava para um cliente, tenant e subject. */
function keyFor(context: OperationContext, clientKey: string): string {
  return contextualKeyOf(crypto, {
    tenantId: context.principal.tenantId,
    subjectId: context.principal.subjectId,
    operationId: 'contacts.create',
    clientKey,
  });
}

/** Executa até `outcome_unknown` por falha não classificada e devolve a chave do registro. */
async function keyAfterUnknown(
  service: IdempotencyService,
  context: OperationContext,
  clientKey: string,
): Promise<string> {
  await expect(
    service.execute(context, operation(), clientKey, PAYLOAD, async () => {
      throw new Error('upstream reset');
    }),
  ).rejects.toThrow('upstream reset');
  return keyFor(context, clientKey);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
