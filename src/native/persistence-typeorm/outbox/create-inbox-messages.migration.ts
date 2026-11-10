import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Entregas já processadas por consumidor. A unicidade é por (consumer_id, message_id). */
export class CreateInboxMessages1794691200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inbox_messages" (
        "consumer_id" varchar(128) NOT NULL,
        "message_id" varchar(128) NOT NULL,
        "received_at_ms" bigint NOT NULL,
        CONSTRAINT "PK_inbox_messages" PRIMARY KEY ("consumer_id", "message_id")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "inbox_messages"`);
  }
}
