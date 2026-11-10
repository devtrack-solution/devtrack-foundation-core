import type { OperationContext } from '../context/operation-context';
import { contextualKeyOf } from '../idempotency/idempotency.key';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import type {
  ExternalOutcomeReconciler,
  IdempotencyCrypto,
  IdempotentOperation,
  IdempotentExecution,
  JsonValue,
} from '../idempotency/idempotency.types';
import type { ReconciliationStatus } from '../idempotency/idempotency.service';

/** Argumentos entregues ao efeito externo. */
export interface ExternalEffectCall<Payload> {
  /** Chave repassada ao provedor (ex.: `Idempotency-Key`). É a chave do cliente. */
  readonly providerIdempotencyKey: string;
  readonly payload: Payload;
}

/**
 * Efeito externo (ex.: chamada a provedor) sob o contrato de idempotência.
 *
 * - A intenção é gravada antes da chamada (`in_progress`, com lease e fencing).
 * - A chave do cliente é repassada ao provedor para deduplicação do lado dele.
 * - Falha classificada como `retryable` ou `terminal` (ex.: `IdempotentRetryableFailure`
 *   quando o provedor garante que não processou) grava o desfecho correspondente.
 * - Falha ambígua (padrão, sem classificação) grava `outcome_unknown`: nenhuma nova
 *   chamada automática é feita. Novas tentativas caem em `IdempotencyOutcomeUnknownError`
 *   até a reconciliação decidir.
 *
 * Não há exactly-once externo: a garantia depende da deduplicação do provedor ou da reconciliação.
 */
export class ExternalEffectRunner {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly crypto: IdempotencyCrypto,
  ) {}

  run<Payload, Result extends JsonValue>(
    context: OperationContext,
    operation: IdempotentOperation<Payload>,
    clientKey: string,
    payload: Payload,
    call: (effect: ExternalEffectCall<Payload>) => Promise<Result>,
  ): Promise<IdempotentExecution<Result>> {
    return this.idempotency.execute<Payload, Result>(
      context,
      operation,
      clientKey,
      payload,
      (_ctx, value) =>
        call({ providerIdempotencyKey: clientKey, payload: value }),
    );
  }

  /**
   * Decide um `outcome_unknown` pela prova do reconciliador (consulta ao provedor).
   * A chave contextual é derivada do mesmo contexto e chave do cliente usados em `run`.
   */
  reconcile(
    context: OperationContext,
    operation: IdempotentOperation<unknown>,
    clientKey: string,
    reconciler: ExternalOutcomeReconciler,
  ): Promise<ReconciliationStatus> {
    const tenantId = context.principal.tenantId;
    const key = contextualKeyOf(this.crypto, {
      ...(tenantId === undefined ? {} : { tenantId }),
      subjectId: context.principal.subjectId,
      operationId: operation.policy.operationId,
      clientKey,
    });
    return this.idempotency.reconcileOutcomeUnknown(key, reconciler);
  }
}
