import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tabela append-only. O trigger rejeita UPDATE e DELETE, exceto DELETE dentro de
 * transação que ativa `foundation.audit.purge` (somente `purgeExpired`). Papéis e
 * privilégios do banco continuam sendo responsabilidade do operador.
 */
export class CreateAuditEntries1794345600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_entries" (
        "id" varchar(64) PRIMARY KEY,
        "occurred_at" bigint NOT NULL,
        "subject_id" varchar(128) NOT NULL,
        "tenant_id" varchar(128),
        "correlation_id" varchar(128) NOT NULL,
        "action" varchar(64) NOT NULL,
        "target" varchar(128) NOT NULL,
        "outcome" varchar(16) NOT NULL,
        CONSTRAINT "CHK_audit_entries_outcome" CHECK ("outcome" IN ('succeeded', 'denied', 'failed')),
        CONSTRAINT "CHK_audit_entries_occurred_at" CHECK ("occurred_at" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_entries_tenant_time" ON "audit_entries" ("tenant_id", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_entries_occurred_at" ON "audit_entries" ("occurred_at")`,
    );
    await queryRunner.query(`
      CREATE FUNCTION "audit_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('foundation.audit.purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_entries is append-only' USING ERRCODE = 'insufficient_privilege';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_audit_entries_append_only"
      BEFORE UPDATE OR DELETE ON "audit_entries"
      FOR EACH ROW EXECUTE FUNCTION "audit_entries_append_only"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "TRG_audit_entries_append_only" ON "audit_entries"`,
    );
    await queryRunner.query(`DROP FUNCTION "audit_entries_append_only"()`);
    await queryRunner.query(`DROP TABLE "audit_entries"`);
  }
}
