import type {
  OutboxIntent,
  ClaimedOutboxMessage,
  OutboxErrorCode,
  OutboxSnapshot,
} from './outbox.model';

/**
 * Recurso transacional do UnitOfWork: grava a intenção na mesma transação da
 * escrita de negócio. Não publica nada; a publicação é feita pelo relay depois do commit.
 */
export interface OutboxWriter {
  append(intent: OutboxIntent): Promise<void>;
}

/** Recurso transacional do consumidor: registra a entrega antes de aplicar o efeito. */
export interface InboxStore {
  /** true quando a mensagem é nova para este consumidor; false quando já foi processada. */
  register(input: {
    readonly consumerId: string;
    readonly messageId: string;
    readonly now: number;
  }): Promise<boolean>;
}

export interface ClaimInput {
  readonly now: number;
  readonly limit: number;
  /** Tempo de posse da reivindicação; após expirar, outro relay pode retomar. */
  readonly leaseMs: number;
}

export interface MarkPublishedInput {
  readonly id: string;
  readonly now: number;
}

export interface MarkFailedInput {
  readonly id: string;
  /** Número da tentativa que falhou; a escrita só vale se ainda for a vigente. */
  readonly attempts: number;
  readonly errorCode: OutboxErrorCode;
  readonly nextAttemptAt: number;
  /** true move a mensagem para `failed`, sem novas reivindicações. */
  readonly terminal: boolean;
  readonly now: number;
}

/** Armazenamento de entrega do relay. Reivindicação concorrente-segura é responsabilidade do adapter. */
export interface OutboxStore {
  claimDue(input: ClaimInput): Promise<readonly ClaimedOutboxMessage[]>;
  markPublished(input: MarkPublishedInput): Promise<void>;
  markFailed(input: MarkFailedInput): Promise<void>;
  snapshot(now: number): Promise<OutboxSnapshot>;
}
