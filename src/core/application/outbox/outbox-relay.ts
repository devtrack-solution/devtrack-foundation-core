import type { JobQueue } from '../activities/job-queue.port';
import type { JobEnvelope } from '../execution/job-envelope';
import { validateJobEnvelope } from '../execution/job-envelope.validation';
import type { Clock } from '../security/authentication.ports';
import {
  OUTBOX_LIMITS,
  type ClaimedOutboxMessage,
  type OutboxErrorCode,
  type OutboxSnapshot,
} from './outbox.model';
import type { OutboxStore } from './outbox.ports';

export interface OutboxRelayOptions {
  /** Mensagens reivindicadas por rodada (1 a 500). */
  readonly batchSize: number;
  /** Teto de publicações por segundo deste relay (1 a 10 000). */
  readonly maxPublishPerSecond: number;
  /** Posse da reivindicação; após expirar sem publicação, outro relay retoma (1 s a 10 min). */
  readonly leaseMs: number;
  /** Tentativas de publicação antes de a mensagem virar `failed` (1 a 100). */
  readonly maxAttempts: number;
  /** Backoff exponencial limitado: min(maxMs, baseMs * 2^(tentativas - 1)). */
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  /** Valores do envelope de job gerado para cada mensagem. */
  readonly envelope: {
    readonly deadlineMs: number;
    readonly maxAttempts: number;
  };
}

export interface OutboxRelayDependencies {
  readonly store: OutboxStore;
  readonly queue: JobQueue;
  readonly clock: Clock;
}

export interface OutboxRelayReport {
  readonly claimed: number;
  readonly published: number;
  /** Falhas de broker ou envelope com nova tentativa agendada. */
  readonly retryScheduled: number;
  /** Mensagens que passaram a `failed` nesta rodada. */
  readonly failed: number;
  /** true quando o teto por segundo impediu nova reivindicação. */
  readonly rateLimited: boolean;
}

const WINDOW_MS = 1_000;

/**
 * Relay da outbox. Cada `drainOnce` reivindica um lote (SKIP LOCKED no adapter),
 * publica cada mensagem pela porta JobQueue usando o id da mensagem como
 * `envelope.id` (dedup no broker) e marca `published`.
 *
 * Entrega é at-least-once: crash entre publicar e marcar `published` repete a
 * publicação na próxima reivindicação. O consumidor deve usar o inbox.
 * Falha do broker mantém a mensagem `pending` com backoff e contador de tentativas;
 * a intenção nunca é descartada. Ao esgotar `maxAttempts` ou por envelope inválido,
 * a mensagem vai a `failed` com código técnico, visível para inspeção.
 */
export class OutboxRelay {
  private windowStart = 0;
  private publishedInWindow = 0;

  constructor(
    private readonly deps: OutboxRelayDependencies,
    private readonly options: OutboxRelayOptions,
  ) {
    assertOptions(options);
  }

  async drainOnce(): Promise<OutboxRelayReport> {
    const now = this.deps.clock.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.publishedInWindow = 0;
    }
    const budget = Math.min(
      this.options.batchSize,
      this.options.maxPublishPerSecond - this.publishedInWindow,
    );
    if (budget <= 0) {
      return {
        claimed: 0,
        published: 0,
        retryScheduled: 0,
        failed: 0,
        rateLimited: true,
      };
    }

    const claimed = await this.deps.store.claimDue({
      now,
      limit: budget,
      leaseMs: this.options.leaseMs,
    });
    let published = 0;
    let retryScheduled = 0;
    let failed = 0;

    for (const message of claimed) {
      const envelope = this.envelopeOf(message, now);
      if (envelope === null) {
        await this.fail(message, 'ENVELOPE_INVALID', true);
        failed += 1;
        continue;
      }
      try {
        await this.deps.queue.enqueue(envelope);
      } catch {
        // Erro do broker não é exposto: só o código técnico é persistido.
        const exhausted = message.attempts >= this.options.maxAttempts;
        await this.fail(
          message,
          exhausted ? 'MAX_ATTEMPTS_EXCEEDED' : 'BROKER_UNAVAILABLE',
          exhausted,
        );
        if (exhausted) failed += 1;
        else retryScheduled += 1;
        // Broker indisponível: as demais reivindicações expiram pelo lease e são retomadas.
        break;
      }
      await this.deps.store.markPublished({
        id: message.id,
        now: this.deps.clock.now(),
      });
      published += 1;
      this.publishedInWindow += 1;
    }

    return {
      claimed: claimed.length,
      published,
      retryScheduled,
      failed,
      rateLimited: false,
    };
  }

  /** Foto de pendências e falhas para sinalização operacional. */
  snapshot(): Promise<OutboxSnapshot> {
    return this.deps.store.snapshot(this.deps.clock.now());
  }

  private envelopeOf(
    message: ClaimedOutboxMessage,
    now: number,
  ): JobEnvelope<unknown> | null {
    const envelope: JobEnvelope<unknown> = {
      id: message.id,
      type: message.type,
      payloadVersion: message.payloadVersion,
      payload: message.payload,
      subjectId: message.subjectId,
      ...(message.tenantId === undefined ? {} : { tenantId: message.tenantId }),
      correlationId: message.correlationId,
      deadlineAt: now + this.options.envelope.deadlineMs,
      maxAttempts: this.options.envelope.maxAttempts,
      ...(message.traceContext === undefined
        ? {}
        : { traceContext: message.traceContext }),
    };
    try {
      validateJobEnvelope(envelope, {
        maxPayloadBytes: OUTBOX_LIMITS.maxPayloadBytes,
        maxAttemptsCeiling: OUTBOX_LIMITS.maxAttemptsCeiling,
      });
      return envelope;
    } catch {
      return null;
    }
  }

  private async fail(
    message: ClaimedOutboxMessage,
    errorCode: OutboxErrorCode,
    terminal: boolean,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.store.markFailed({
      id: message.id,
      attempts: message.attempts,
      errorCode,
      nextAttemptAt: now + this.backoffMs(message.attempts),
      terminal,
      now,
    });
  }

  private backoffMs(attempts: number): number {
    const exponent = Math.min(Math.max(attempts, 1) - 1, 30);
    return Math.min(
      this.options.backoff.maxMs,
      this.options.backoff.baseMs * 2 ** exponent,
    );
  }
}

function assertOptions(options: OutboxRelayOptions): void {
  const int = (value: number, min: number, max: number): boolean =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  if (
    !int(options.batchSize, 1, OUTBOX_LIMITS.maxBatchSize) ||
    !int(options.maxPublishPerSecond, 1, OUTBOX_LIMITS.maxPublishPerSecond) ||
    !int(options.leaseMs, OUTBOX_LIMITS.minLeaseMs, OUTBOX_LIMITS.maxLeaseMs) ||
    !int(options.maxAttempts, 1, OUTBOX_LIMITS.maxAttemptsCeiling) ||
    !int(options.backoff.baseMs, 1, OUTBOX_LIMITS.maxBackoffMs) ||
    !int(
      options.backoff.maxMs,
      options.backoff.baseMs,
      OUTBOX_LIMITS.maxBackoffMs,
    ) ||
    !int(options.envelope.deadlineMs, 1, OUTBOX_LIMITS.maxBackoffMs) ||
    !int(options.envelope.maxAttempts, 1, OUTBOX_LIMITS.maxAttemptsCeiling)
  ) {
    throw new OutboxRelayConfigError();
  }
}

export class OutboxRelayConfigError extends Error {
  constructor() {
    super('outbox_relay_config_invalid');
    this.name = 'OutboxRelayConfigError';
  }
}
