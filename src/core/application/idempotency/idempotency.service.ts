import type { AuditEntry } from '../audit/audit-writer.port';
import { createAuditContext } from '../audit/audit-context';
import type { OperationContext } from '../context/operation-context';
import type { Clock } from '../security/authentication.ports';
import type { UnitOfWork } from '../persistence/unit-of-work.port';
import { canonicalJson } from './canonical-json';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyOutcomeUnknownError,
  IdempotencyPolicyError,
  IdempotencyResultError,
  IdempotencyTerminalFailureError,
  IdempotentRetryableFailure,
  IdempotentTerminalFailure,
} from './idempotency.errors';
import {
  contextualKeyOf,
  fingerprintOf,
  validateClientKey,
} from './idempotency.key';
import {
  IDEMPOTENCY_LIMITS,
  IDEMPOTENCY_OPERATION_ID_PATTERN,
  type ExternalOutcomeReconciler,
  type IdempotencyAuditDescriptor,
  type IdempotencyClaimRef,
  type IdempotencyCrypto,
  type IdempotencyFailureClass,
  type IdempotencyStore,
  type IdempotencyUnitOfWorkResources,
  type IdempotentExecution,
  type IdempotentLease,
  type IdempotentOperation,
  type IdempotentOperationPolicy,
  type JsonValue,
} from './idempotency.types';

export interface IdempotencyServiceDependencies {
  readonly store: IdempotencyStore;
  readonly crypto: IdempotencyCrypto;
  readonly clock: Clock;
  /** Duração do lease do executor em ms (1 s a 10 min). Padrão: 30 s. */
  readonly leaseMs?: number;
}

/** Transação do UnitOfWork usada pela execução: recursos, auditoria e conclusão. */
export interface IdempotentTransactionalExecution<
  Result,
  Resources extends IdempotencyUnitOfWorkResources,
> {
  readonly unitOfWork: UnitOfWork<Resources>;
  /** Auditoria obrigatória do efeito confirmado. Gravada na mesma transação. */
  readonly auditOf: (result: Result) => IdempotencyAuditDescriptor;
}

/** Desfecho de `reconcileOutcomeUnknown`. */
export type ReconciliationStatus =
  'absent' | 'not_unknown' | 'unresolved' | 'completed' | 'failed_retryable';

type Admission<Result> =
  | {
      readonly kind: 'replayed';
      readonly execution: IdempotentExecution<Result>;
    }
  | {
      readonly kind: 'claimed';
      readonly ref: IdempotencyClaimRef;
      readonly policy: IdempotentOperationPolicy<unknown>;
    };

/**
 * Executa uma operação idempotente. Ordem: validar a chave, revalidar a
 * autorização atual, calcular chave e fingerprint, reivindicar a intenção com lease,
 * executar e registrar o resultado sob fencing (token e versão).
 *
 * Autenticação e validação de entrada já ocorreram antes da chamada (transporte e
 * casos de uso). Nenhum resultado persistido é devolvido sem `authorize` ter passado.
 */
export class IdempotencyService {
  private readonly leaseMs: number;

  constructor(private readonly dependencies: IdempotencyServiceDependencies) {
    this.leaseMs = assertLeaseMs(dependencies.leaseMs);
  }

  /**
   * Execução sem transação de negócio. `run` recebe `lease.renew()` para estender o
   * lease durante trabalho longo. Efeitos externos ficam sob responsabilidade da
   * operação: falha não classificada registra `outcome_unknown`.
   */
  async execute<Payload, Result extends JsonValue>(
    context: OperationContext,
    operation: IdempotentOperation<Payload>,
    clientKey: unknown,
    payload: Payload,
    run: (
      context: OperationContext,
      payload: Payload,
      lease: IdempotentLease,
    ) => Promise<Result>,
  ): Promise<IdempotentExecution<Result>> {
    const admission = await this.admit<Payload, Result>(
      context,
      operation,
      clientKey,
      payload,
    );
    if (admission.kind === 'replayed') return admission.execution;
    const { ref, policy } = admission;

    const lease: IdempotentLease = { renew: () => this.renew(ref) };
    let result: Result;
    try {
      result = await run(context, payload, lease);
    } catch (error) {
      await this.recordFailure(ref, classifyOf(policy, error));
      throw error;
    }

    const stored = storedResultOf(result);
    if (stored === null) {
      await this.recordFailure(ref, 'unknown');
      throw new IdempotencyResultError();
    }
    await this.dependencies.store.complete({
      ...ref,
      result: stored,
      now: this.now(),
    });
    return { result, replayed: false };
  }

  /**
   * Execução com efeito interno em transação. `run` recebe os recursos do UnitOfWork;
   * a escrita de negócio, o resultado idempotente e a auditoria são confirmados
   * juntos. A conclusão exige token, versão e lease vigentes no commit: executor
   * obsoleto tem a transação desfeita e não confirma nada.
   *
   * Não faça chamadas de rede dentro de `run`: a transação fica aberta durante o
   * trabalho. Falha sem classificação (`unknown`) deixa o registro `in_progress`,
   * que é recuperável após o lease, porque a transação desfeita não produziu efeito.
   */
  async executeInUnitOfWork<
    Payload,
    Result extends JsonValue,
    Resources extends IdempotencyUnitOfWorkResources,
  >(
    context: OperationContext,
    operation: IdempotentOperation<Payload>,
    clientKey: unknown,
    payload: Payload,
    transaction: IdempotentTransactionalExecution<Result, Resources>,
    run: (
      context: OperationContext,
      payload: Payload,
      resources: Resources,
    ) => Promise<Result>,
  ): Promise<IdempotentExecution<Result>> {
    const admission = await this.admit<Payload, Result>(
      context,
      operation,
      clientKey,
      payload,
    );
    if (admission.kind === 'replayed') return admission.execution;
    const { ref, policy } = admission;

    let result: Result;
    try {
      result = await transaction.unitOfWork.run(async (resources) => {
        const value = await run(context, payload, resources);
        const stored = storedResultOf(value);
        if (stored === null) throw new IdempotencyResultError();
        await resources.audit.append(
          this.auditEntry(context, transaction.auditOf(value)),
        );
        await resources.idempotency.complete({
          ...ref,
          result: stored,
          now: this.now(),
        });
        return value;
      });
    } catch (error) {
      // A transação já foi desfeita: nenhuma escrita de negócio persistiu.
      if (error instanceof IdempotencyResultError) {
        await this.recordFailure(ref, 'terminal');
      } else {
        const failureClass = classifyOf(policy, error);
        if (failureClass !== 'unknown') {
          await this.recordFailure(ref, failureClass);
        }
      }
      throw error;
    }
    return { result, replayed: false };
  }

  /**
   * Reconciliação de `outcome_unknown` pela porta opcional. Só resolve com prova do
   * reconciliador: `confirmed` grava o resultado; `not_performed` libera nova
   * tentativa; `unresolved` mantém o estado.
   */
  async reconcileOutcomeUnknown(
    key: string,
    reconciler: ExternalOutcomeReconciler,
  ): Promise<ReconciliationStatus> {
    const record = await this.dependencies.store.find(key);
    if (record === null) return 'absent';
    if (record.state !== 'outcome_unknown') return 'not_unknown';

    const decision = await reconciler.reconcile(record);
    if (decision.outcome === 'unresolved') return 'unresolved';
    const now = this.now();
    if (decision.outcome === 'confirmed') {
      await this.dependencies.store.resolveOutcomeUnknown({
        key,
        expectedVersion: record.version,
        state: 'completed',
        result: decision.result,
        now,
      });
      return 'completed';
    }
    await this.dependencies.store.resolveOutcomeUnknown({
      key,
      expectedVersion: record.version,
      state: 'failed_retryable',
      now,
    });
    return 'failed_retryable';
  }

  /** Validação, autorização, chave, fingerprint e reivindicação. */
  private async admit<Payload, Result extends JsonValue>(
    context: OperationContext,
    operation: IdempotentOperation<Payload>,
    clientKey: unknown,
    payload: Payload,
  ): Promise<Admission<Result>> {
    const policy = assertPolicy(operation.policy);
    const key = validateClientKey(clientKey);

    await operation.authorize(context);

    const semantic = policy.semanticContent
      ? policy.semanticContent(payload)
      : payload;
    const fingerprint = fingerprintOf(this.dependencies.crypto, semantic);
    const subjectId = context.principal.subjectId;
    const tenantId = context.principal.tenantId;
    const contextualKey = contextualKeyOf(this.dependencies.crypto, {
      ...(tenantId === undefined ? {} : { tenantId }),
      subjectId,
      operationId: policy.operationId,
      clientKey: key,
    });

    const now = this.now();
    const begun = await this.dependencies.store.begin({
      key: contextualKey,
      operationId: policy.operationId,
      subjectId,
      ...(tenantId === undefined ? {} : { tenantId }),
      fingerprint,
      claimToken: this.dependencies.crypto.randomToken(),
      now,
      expiresAt: now + policy.retentionMs,
      leaseExpiresAt: now + this.leaseMs,
    });

    if (begun.outcome === 'existing') {
      return {
        kind: 'replayed',
        execution: this.answerExisting<Result>(begun.record, fingerprint),
      };
    }
    return {
      kind: 'claimed',
      policy,
      ref: {
        key: contextualKey,
        claimToken: begun.record.claimToken,
        version: begun.record.version,
      },
    };
  }

  private answerExisting<Result extends JsonValue>(
    record: {
      readonly fingerprint: string;
      readonly state: string;
      readonly result?: JsonValue;
    },
    fingerprint: string,
  ): IdempotentExecution<Result> {
    if (record.fingerprint !== fingerprint)
      throw new IdempotencyConflictError();
    switch (record.state) {
      case 'completed':
        if (record.result === undefined) throw new IdempotencyResultError();
        return { result: record.result as Result, replayed: true };
      case 'failed_terminal':
        throw new IdempotencyTerminalFailureError();
      case 'outcome_unknown':
        throw new IdempotencyOutcomeUnknownError();
      default:
        throw new IdempotencyInProgressError();
    }
  }

  private async renew(ref: IdempotencyClaimRef): Promise<void> {
    const now = this.now();
    await this.dependencies.store.heartbeat({
      ...ref,
      now,
      leaseExpiresAt: now + this.leaseMs,
    });
  }

  private auditEntry(
    context: OperationContext,
    descriptor: IdempotencyAuditDescriptor,
  ): AuditEntry {
    return {
      id: this.dependencies.crypto.randomToken(),
      occurredAt: this.now(),
      context: createAuditContext(context),
      action: descriptor.action,
      target: descriptor.target,
      outcome: 'succeeded',
    };
  }

  /**
   * Falha ao gravar a falha não substitui o erro original. Se o lease já não for
   * do executor, a gravação é recusada e o registro segue o dono atual.
   */
  private async recordFailure(
    ref: IdempotencyClaimRef,
    failureClass: IdempotencyFailureClass,
  ): Promise<void> {
    try {
      await this.dependencies.store.fail({
        ...ref,
        failureClass,
        now: this.now(),
      });
    } catch {
      // Erro original prevalece; registro já não pertence a este executor.
    }
  }

  private now(): number {
    const now = this.dependencies.clock.now();
    if (!Number.isSafeInteger(now)) throw new IdempotencyPolicyError();
    return now;
  }
}

function classifyOf<Payload>(
  policy: IdempotentOperationPolicy<Payload>,
  error: unknown,
): IdempotencyFailureClass {
  if (policy.classifyFailure) return policy.classifyFailure(error);
  if (error instanceof IdempotentRetryableFailure) return 'retryable';
  if (error instanceof IdempotentTerminalFailure) return 'terminal';
  return 'unknown';
}

/** Resultado em JSON canônico, ou `null` quando não é JSON reapresentável. */
function storedResultOf(result: unknown): JsonValue | null {
  try {
    return JSON.parse(canonicalJson(result)) as JsonValue;
  } catch {
    return null;
  }
}

function assertLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? IDEMPOTENCY_LIMITS.defaultLeaseMs;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < IDEMPOTENCY_LIMITS.minLeaseMs ||
    leaseMs > IDEMPOTENCY_LIMITS.maxLeaseMs
  )
    throw new IdempotencyPolicyError();
  return leaseMs;
}

function assertPolicy<Payload>(
  policy: IdempotentOperationPolicy<Payload>,
): IdempotentOperationPolicy<Payload> {
  if (typeof policy !== 'object' || policy === null)
    throw new IdempotencyPolicyError();
  const { operationId, retentionMs } = policy;
  if (
    typeof operationId !== 'string' ||
    operationId.length > IDEMPOTENCY_LIMITS.maxOperationIdLength ||
    !IDEMPOTENCY_OPERATION_ID_PATTERN.test(operationId) ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < IDEMPOTENCY_LIMITS.minRetentionMs ||
    retentionMs > IDEMPOTENCY_LIMITS.maxRetentionMs
  )
    throw new IdempotencyPolicyError();
  return policy;
}
