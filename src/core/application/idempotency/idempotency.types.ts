import type { AuditWriter } from '../audit/audit-writer.port';
import type { OperationContext } from '../context/operation-context';

/** Valor JSON puro: o único tipo aceito para conteúdo semântico e resultado reapresentável. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type IdempotencyState =
  | 'in_progress'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'outcome_unknown';

/** Classe de falha de uma tentativa; define o estado gravado após a falha. */
export type IdempotencyFailureClass = 'retryable' | 'terminal' | 'unknown';

/**
 * Hash e tokens. Application não importa `node:crypto`; a implementação técnica
 * (Node, Web Crypto ou outra) é injetada. `sha256Hex` devolve 64 caracteres hex.
 */
export interface IdempotencyCrypto {
  sha256Hex(input: string): string;
  /** Token de reivindicação não previsível (ex.: UUID v4). */
  randomToken(): string;
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly operationId: string;
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly fingerprint: string;
  readonly state: IdempotencyState;
  /** Token da tentativa que detém a intenção. */
  readonly claimToken: string;
  readonly result?: JsonValue;
  readonly failureClass?: IdempotencyFailureClass;
  /** Fim do lease do executor; `null` fora de `in_progress`. Epoch em ms. */
  readonly leaseExpiresAt: number | null;
  /** Epoch em ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Fim da retenção, contado a partir da reivindicação. Epoch em ms. */
  readonly expiresAt: number;
  /**
   * Fencing token monotônico. Muda a cada reivindicação e a cada transição de
   * estado. Renovação de lease não o altera.
   */
  readonly version: number;
}

/** Identidade de uma reivindicação: quem a detém e em que versão. */
export interface IdempotencyClaimRef {
  readonly key: string;
  readonly claimToken: string;
  readonly version: number;
}

export interface IdempotencyBeginRequest {
  readonly key: string;
  readonly operationId: string;
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly fingerprint: string;
  readonly claimToken: string;
  readonly now: number;
  readonly expiresAt: number;
  readonly leaseExpiresAt: number;
}

export type IdempotencyBeginResult =
  | { readonly outcome: 'claimed'; readonly record: IdempotencyRecord }
  | { readonly outcome: 'existing'; readonly record: IdempotencyRecord };

export interface IdempotencyHeartbeatRequest extends IdempotencyClaimRef {
  readonly now: number;
  readonly leaseExpiresAt: number;
}

export interface IdempotencyCompleteRequest extends IdempotencyClaimRef {
  readonly result: JsonValue;
  readonly now: number;
}

export interface IdempotencyFailRequest extends IdempotencyClaimRef {
  readonly failureClass: IdempotencyFailureClass;
  readonly now: number;
}

/** Resolução de `outcome_unknown` por reconciliação. Exige a versão lida. */
export interface IdempotencyResolveRequest {
  readonly key: string;
  readonly expectedVersion: number;
  readonly state: 'completed' | 'failed_retryable' | 'failed_terminal';
  readonly result?: JsonValue;
  readonly now: number;
}

/**
 * Porta de armazenamento compartilhado. Implementações devem garantir:
 * - `begin` é atômico e só reivindica registros reivindicáveis (ver `isClaimable`);
 *   registros vigentes não são sobrescritos.
 * - `heartbeat`, `complete` e `fail` só alteram o registro `in_progress` cujo
 *   `claimToken` e `version` coincidem. `complete` e `fail` exigem lease vigente
 *   no instante `now`. Caso contrário lançam `IdempotencyStaleClaimError`.
 * - `resolveOutcomeUnknown` só altera `outcome_unknown` com a versão esperada.
 * - `purgeExpired` remove no máximo `limit` registros vencidos.
 */
export interface IdempotencyStore {
  begin(request: IdempotencyBeginRequest): Promise<IdempotencyBeginResult>;
  heartbeat(request: IdempotencyHeartbeatRequest): Promise<void>;
  complete(request: IdempotencyCompleteRequest): Promise<void>;
  fail(request: IdempotencyFailRequest): Promise<void>;
  resolveOutcomeUnknown(request: IdempotencyResolveRequest): Promise<void>;
  find(key: string): Promise<IdempotencyRecord | null>;
  purgeExpired(request: {
    readonly now: number;
    readonly limit: number;
  }): Promise<number>;
}

/**
 * Conclusão do resultado dentro da transação de negócio. Implementada pelo store
 * ligado ao mesmo EntityManager da transação; tem as mesmas garantias de fencing de
 * `IdempotencyStore.complete`.
 */
export type IdempotencyTransactionPort = Pick<IdempotencyStore, 'complete'>;

/** Recursos entregues pelo UnitOfWork ao trabalho idempotente. */
export interface IdempotencyUnitOfWorkResources {
  readonly idempotency: IdempotencyTransactionPort;
  readonly audit: AuditWriter;
}

/** Política declarada pela operação. */
export interface IdempotentOperationPolicy<Payload> {
  /** Identificador estável da operação: minúsculas, dígitos, `.`, `_` ou `-`; até 64. */
  readonly operationId: string;
  /** Retenção a partir da reivindicação, em ms (1 s a 30 dias). */
  readonly retentionMs: number;
  /**
   * Conteúdo semântico que entra no fingerprint. Padrão: o payload inteiro.
   * Deve devolver apenas JSON puro.
   */
  readonly semanticContent?: (payload: Payload) => unknown;
  /** Classifica falhas do `run`. Padrão: `IdempotentRetryableFailure`, `IdempotentTerminalFailure`, senão `unknown`. */
  readonly classifyFailure?: (error: unknown) => IdempotencyFailureClass;
}

/**
 * Operação idempotente. `authorize` é a checagem de acesso atual; é executada em
 * toda chamada, inclusive replays, antes de qualquer resultado ser devolvido.
 * Deve lançar quando o acesso foi negado.
 */
export interface IdempotentOperation<Payload> {
  readonly policy: IdempotentOperationPolicy<Payload>;
  authorize(context: OperationContext): Promise<void>;
}

export interface IdempotentExecution<Result> {
  readonly result: Result;
  /** Verdadeiro quando o resultado veio do registro persistido e `run` não foi chamado. */
  readonly replayed: boolean;
}

/** Renovação de lease do executor. Só tem efeito enquanto o token e a versão batem. */
export interface IdempotentLease {
  renew(): Promise<void>;
}

/** Descrição mínima da auditoria obrigatória de uma execução transacional. */
export interface IdempotencyAuditDescriptor {
  readonly action: string;
  readonly target: string;
}

/** Desfecho que a reconciliação consegue provar para um efeito externo incerto. */
export type ExternalOutcomeDecision =
  | { readonly outcome: 'confirmed'; readonly result: JsonValue }
  | { readonly outcome: 'not_performed' }
  | { readonly outcome: 'unresolved' };

/**
 * Porta opcional de reconciliação de efeitos externos. Consulta o provedor ou o
 * receptor pela chave suportada. Sem esta porta, `outcome_unknown` permanece.
 */
export interface ExternalOutcomeReconciler {
  reconcile(record: IdempotencyRecord): Promise<ExternalOutcomeDecision>;
}

/** Limites da política, usados pelo serviço e pelo decorator de apresentação. */
export const IDEMPOTENCY_LIMITS = Object.freeze({
  minRetentionMs: 1_000,
  maxRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxKeyLength: 128,
  maxOperationIdLength: 64,
  maxPurgeBatch: 1_000,
  defaultLeaseMs: 30_000,
  minLeaseMs: 1_000,
  maxLeaseMs: 10 * 60 * 1_000,
});

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const IDEMPOTENCY_OPERATION_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** Stable across compatible copies of the public contracts package. */
export const IDEMPOTENCY_SERVICE = Symbol.for(
  'foundation.api.v1.idempotency-service',
);
export const IDEMPOTENCY_STORE = Symbol.for(
  'foundation.api.v1.idempotency-store',
);
export const IDEMPOTENCY_CRYPTO = Symbol.for(
  'foundation.api.v1.idempotency-crypto',
);
export const IDEMPOTENCY_RECONCILER = Symbol.for(
  'foundation.api.v1.idempotency-reconciler',
);
