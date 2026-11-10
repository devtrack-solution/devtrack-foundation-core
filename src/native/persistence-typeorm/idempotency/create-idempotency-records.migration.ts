import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyRecords1794259200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "idempotency_records" (
        "id" SERIAL PRIMARY KEY,
        "idempotency_key" varchar(64) NOT NULL,
        "operation_id" varchar(64) NOT NULL,
        "subject_id" varchar(128) NOT NULL,
        "tenant_id" varchar(128),
        "fingerprint" varchar(64) NOT NULL,
        "state" varchar(24) NOT NULL,
        "claim_token" varchar(64) NOT NULL,
        "result" jsonb,
        "failure_class" varchar(16),
        "created_at_ms" bigint NOT NULL,
        "updated_at_ms" bigint NOT NULL,
        "expires_at_ms" bigint NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "UQ_idempotency_records_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_idempotency_records_state" CHECK ("state" IN ('in_progress', 'completed', 'failed_retryable', 'failed_terminal', 'outcome_unknown')),
        CONSTRAINT "CHK_idempotency_records_failure_class" CHECK ("failure_class" IS NULL OR "failure_class" IN ('retryable', 'terminal', 'unknown')),
        CONSTRAINT "CHK_idempotency_records_completed_result" CHECK ("state" <> 'completed' OR "result" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_idempotency_records_expires_at_ms" ON "idempotency_records" ("expires_at_ms")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "idempotency_records"`);
  }
}
