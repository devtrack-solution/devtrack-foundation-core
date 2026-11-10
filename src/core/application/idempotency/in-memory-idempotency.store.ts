import { isClaimable } from './idempotency.claim-rules';
import { IdempotencyStaleClaimError } from './idempotency.errors';
import {
  IDEMPOTENCY_LIMITS,
  type IdempotencyBeginRequest,
  type IdempotencyBeginResult,
  type IdempotencyClaimRef,
  type IdempotencyCompleteRequest,
  type IdempotencyFailRequest,
  type IdempotencyFailureClass,
  type IdempotencyHeartbeatRequest,
  type IdempotencyRecord,
  type IdempotencyResolveRequest,
  type IdempotencyStore,
  type IdempotencyState,
  type JsonValue,
} from './idempotency.types';

const FAILURE_STATE: Record<IdempotencyFailureClass, IdempotencyState> = {
  retryable: 'failed_retryable',
  terminal: 'failed_terminal',
  unknown: 'outcome_unknown',
};

interface Transition {
  readonly state: IdempotencyState;
  readonly now: number;
  readonly leaseExpiresAt: number | null;
  readonly version: number;
  readonly result?: JsonValue;
  readonly failureClass?: IdempotencyFailureClass;
}

/**
 * Store em memória para testes unitários e composições sem banco. Um único
 * processo; não coordena réplicas. Aplica as mesmas regras de `isClaimable`,
 * lease e fencing que o store TypeORM.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  begin(request: IdempotencyBeginRequest): Promise<IdempotencyBeginResult> {
    return settled(() => this.claim(request));
  }

  private claim(request: IdempotencyBeginRequest): IdempotencyBeginResult {
    const existing = this.records.get(request.key);
    if (
      existing !== undefined &&
      !isClaimable(existing, request.now, request.fingerprint)
    ) {
      return { outcome: 'existing', record: copy(existing) };
    }
    const record: IdempotencyRecord = {
      key: request.key,
      operationId: request.operationId,
      subjectId: request.subjectId,
      ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
      fingerprint: request.fingerprint,
      state: 'in_progress',
      claimToken: request.claimToken,
      leaseExpiresAt: request.leaseExpiresAt,
      createdAt: request.now,
      updatedAt: request.now,
      expiresAt: request.expiresAt,
      version: (existing?.version ?? 0) + 1,
    };
    this.records.set(request.key, record);
    return { outcome: 'claimed', record: copy(record) };
  }

  heartbeat(request: IdempotencyHeartbeatRequest): Promise<void> {
    return settled(() => {
      const record = this.owned(request, request.now, false);
      this.records.set(request.key, {
        ...record,
        leaseExpiresAt: request.leaseExpiresAt,
        updatedAt: request.now,
      });
    });
  }

  complete(request: IdempotencyCompleteRequest): Promise<void> {
    return settled(() =>
      this.transition(request, {
        state: 'completed',
        now: request.now,
        leaseExpiresAt: null,
        version: request.version + 1,
        result: clone(request.result),
      }),
    );
  }

  fail(request: IdempotencyFailRequest): Promise<void> {
    return settled(() =>
      this.transition(request, {
        state: FAILURE_STATE[request.failureClass],
        now: request.now,
        leaseExpiresAt: null,
        version: request.version + 1,
        failureClass: request.failureClass,
      }),
    );
  }

  resolveOutcomeUnknown(request: IdempotencyResolveRequest): Promise<void> {
    return settled(() => {
      const record = this.records.get(request.key);
      if (
        record === undefined ||
        record.state !== 'outcome_unknown' ||
        record.version !== request.expectedVersion
      )
        throw new IdempotencyStaleClaimError();
      this.records.set(
        request.key,
        buildRecord(record, {
          state: request.state,
          now: request.now,
          leaseExpiresAt: null,
          version: record.version + 1,
          ...(request.result === undefined
            ? {}
            : { result: clone(request.result) }),
          ...(request.state === 'failed_retryable'
            ? { failureClass: 'retryable' as const }
            : request.state === 'failed_terminal'
              ? { failureClass: 'terminal' as const }
              : {}),
        }),
      );
    });
  }

  find(key: string): Promise<IdempotencyRecord | null> {
    const record = this.records.get(key);
    return Promise.resolve(record === undefined ? null : copy(record));
  }

  purgeExpired(request: {
    readonly now: number;
    readonly limit: number;
  }): Promise<number> {
    return settled(() => this.purge(request));
  }

  private purge(request: {
    readonly now: number;
    readonly limit: number;
  }): number {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > IDEMPOTENCY_LIMITS.maxPurgeBatch
    )
      throw new RangeError('idempotency_purge_limit_invalid');
    let removed = 0;
    for (const [key, record] of this.records) {
      if (removed >= request.limit) break;
      if (record.expiresAt <= request.now && record.state !== 'in_progress') {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Quantidade de registros presentes, inclusive vencidos ainda não purgados. */
  size(): number {
    return this.records.size;
  }

  /**
   * Registro `in_progress` do próprio executor. Com `checkLease`, exige lease
   * vigente em `now`. Qualquer divergência lança `IdempotencyStaleClaimError`.
   */
  private owned(
    ref: IdempotencyClaimRef,
    now: number,
    checkLease: boolean,
  ): IdempotencyRecord {
    const record = this.records.get(ref.key);
    if (
      record === undefined ||
      record.state !== 'in_progress' ||
      record.claimToken !== ref.claimToken ||
      record.version !== ref.version ||
      record.leaseExpiresAt === null ||
      (checkLease && record.leaseExpiresAt <= now)
    )
      throw new IdempotencyStaleClaimError();
    return record;
  }

  private transition(
    request: IdempotencyClaimRef & { readonly now: number },
    change: Transition,
  ): void {
    const record = this.owned(request, request.now, true);
    this.records.set(request.key, buildRecord(record, change));
  }
}

function buildRecord(
  base: IdempotencyRecord,
  next: Transition,
): IdempotencyRecord {
  return {
    key: base.key,
    operationId: base.operationId,
    subjectId: base.subjectId,
    ...(base.tenantId === undefined ? {} : { tenantId: base.tenantId }),
    fingerprint: base.fingerprint,
    state: next.state,
    claimToken: base.claimToken,
    ...(next.result === undefined ? {} : { result: next.result }),
    ...(next.failureClass === undefined
      ? {}
      : { failureClass: next.failureClass }),
    leaseExpiresAt: next.leaseExpiresAt,
    createdAt: base.createdAt,
    updatedAt: next.now,
    expiresAt: base.expiresAt,
    version: next.version,
  };
}

/** Executa trabalho síncrono e entrega o desfecho como Promise, rejeitando em caso de erro. */
function settled<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error as Error);
  }
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function copy(record: IdempotencyRecord): IdempotencyRecord {
  return {
    ...record,
    ...(record.result === undefined ? {} : { result: clone(record.result) }),
  };
}
