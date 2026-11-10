import type { EntityManager } from 'typeorm';
import type { Clock } from '../../../core/application/security/authentication.ports';
import type { OutboxIntent } from '../../../core/application/outbox/outbox.model';
import { validateOutboxIntent } from '../../../core/application/outbox/outbox.validation';
import type { OutboxWriter } from '../../../core/application/outbox/outbox.ports';

/**
 * OutboxWriter sobre o EntityManager da transação do UnitOfWork. Deve ser criado
 * pela fábrica de recursos; grava apenas na transação em curso.
 */
export class TypeOrmOutboxWriter implements OutboxWriter {
  constructor(
    private readonly manager: EntityManager,
    private readonly clock: Clock,
  ) {}

  async append(intent: OutboxIntent): Promise<void> {
    validateOutboxIntent(intent);
    const now = this.clock.now();
    await this.manager.query(
      `INSERT INTO "outbox_messages"
         ("id", "type", "payload_version", "payload", "subject_id", "tenant_id",
          "correlation_id", "trace_context", "state", "attempts",
          "next_attempt_at_ms", "created_at_ms", "updated_at_ms")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, 'pending', 0, $9, $9, $9)`,
      [
        intent.id,
        intent.type,
        intent.payloadVersion,
        JSON.stringify(intent.payload),
        intent.subjectId,
        intent.tenantId ?? null,
        intent.correlationId,
        intent.traceContext === undefined
          ? null
          : JSON.stringify(intent.traceContext),
        now,
      ],
    );
  }
}
