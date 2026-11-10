import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthSessions1794345600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" varchar(64) PRIMARY KEY,
        "subject_id" varchar(128) NOT NULL,
        "tenant_id" varchar(128),
        "state" varchar(16) NOT NULL,
        "method" varchar(160) NOT NULL,
        "created_at" bigint NOT NULL,
        "expires_at" bigint NOT NULL,
        "revoked_at" bigint,
        CONSTRAINT "CHK_auth_sessions_state" CHECK ("state" IN ('pending', 'active', 'revoked', 'expired')),
        CONSTRAINT "CHK_auth_sessions_revoked_at" CHECK (("state" = 'revoked') = ("revoked_at" IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "auth_refresh_tokens" (
        "id" SERIAL PRIMARY KEY,
        "digest" varchar(64) NOT NULL,
        "session_id" varchar(64) NOT NULL REFERENCES "auth_sessions" ("id") ON DELETE CASCADE,
        "state" varchar(16) NOT NULL,
        "successor_digest" varchar(64),
        "consumed_at" bigint,
        "client_binding_digest" varchar(64) NOT NULL,
        "idle_expires_at" bigint NOT NULL,
        "created_at" bigint NOT NULL,
        CONSTRAINT "UQ_auth_refresh_tokens_digest" UNIQUE ("digest"),
        CONSTRAINT "CHK_auth_refresh_tokens_state" CHECK ("state" IN ('active', 'consumed', 'revoked')),
        CONSTRAINT "CHK_auth_refresh_tokens_consumed" CHECK ("state" <> 'consumed' OR ("consumed_at" IS NOT NULL AND "successor_digest" IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_refresh_tokens_session_id" ON "auth_refresh_tokens" ("session_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "auth_refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
  }
}
