import type { EntityManager } from 'typeorm';
import type { InboxStore } from '../../../core/application/outbox/outbox.ports';

/** InboxStore sobre a transação do consumidor. Deve ser criado pela fábrica de recursos. */
export class TypeOrmInboxStore implements InboxStore {
  constructor(private readonly manager: EntityManager) {}

  async register(input: {
    readonly consumerId: string;
    readonly messageId: string;
    readonly now: number;
  }): Promise<boolean> {
    const rows: unknown[] = await this.manager.query(
      `INSERT INTO "inbox_messages" ("consumer_id", "message_id", "received_at_ms")
       VALUES ($1, $2, $3)
       ON CONFLICT ("consumer_id", "message_id") DO NOTHING
       RETURNING "message_id"`,
      [input.consumerId, input.messageId, input.now],
    );
    return rows.length > 0;
  }
}
