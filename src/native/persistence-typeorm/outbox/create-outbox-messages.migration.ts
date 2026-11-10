import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboxMessages1794604800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbox_messages" (
        "id" varchar(128) PRIMARY KEY,
        "type" varchar(128) NOT NULL,
        "payload_version" integer NOT NULL,
        "payload" jsonb NOT NULL,
        "subject_id" varchar(128) NOT NULL,
        "tenant_id" varchar(128),
        "correlation_id" varchar(128) NOT NULL,
        "trace_context" jsonb,
        "state" varchar(16) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at_ms" bigint NOT NULL,
        "last_error_code" varchar(64),
        "created_at_ms" bigint NOT NULL,
        "published_at_ms" bigint,
        "updated_at_ms" bigint NOT NULL,
        CONSTRAINT "CHK_outbox_messages_state" CHECK ("state" IN ('pending', 'published', 'failed')),
        CONSTRAINT "CHK_outbox_messages_attempts" CHECK ("attempts" >= 0),
        CONSTRAINT "CHK_outbox_messages_payload_version" CHECK ("payload_version" >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_messages_due" ON "outbox_messages" ("state", "next_attempt_at_ms")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "outbox_messages"`);
  }
}
