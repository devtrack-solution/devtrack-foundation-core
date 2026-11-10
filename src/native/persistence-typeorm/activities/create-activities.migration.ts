import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateActivities1794345600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "activities" (
        "id" varchar(64) PRIMARY KEY,
        "type" varchar(128) NOT NULL,
        "state" varchar(24) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error_code" varchar(64),
        "correlation_id" varchar(128) NOT NULL,
        "subject_id" varchar(128) NOT NULL,
        "tenant_id" varchar(128),
        "created_at_ms" bigint NOT NULL,
        "updated_at_ms" bigint NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "CHK_activities_state" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'cancelled')),
        CONSTRAINT "CHK_activities_attempts" CHECK ("attempts" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_activities_tenant_id" ON "activities" ("tenant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_activities_state_updated" ON "activities" ("state", "updated_at_ms")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "activities"`);
  }
}
