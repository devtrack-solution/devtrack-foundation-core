import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lease do executor (etapa 4.2). Registros `in_progress` anteriores recebem o fim da
 * retenção como lease, para que possam ser recuperados sem ficar presos.
 */
export class AddIdempotencyLease1794432000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "idempotency_records" ADD COLUMN "lease_expires_at_ms" bigint
    `);
    await queryRunner.query(`
      UPDATE "idempotency_records" SET "lease_expires_at_ms" = "expires_at_ms"
      WHERE "state" = 'in_progress'
    `);
    await queryRunner.query(`
      ALTER TABLE "idempotency_records" ADD CONSTRAINT "CHK_idempotency_records_lease"
      CHECK ("state" <> 'in_progress' OR "lease_expires_at_ms" IS NOT NULL)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "idempotency_records" DROP CONSTRAINT "CHK_idempotency_records_lease"
    `);
    await queryRunner.query(`
      ALTER TABLE "idempotency_records" DROP COLUMN "lease_expires_at_ms"
    `);
  }
}
