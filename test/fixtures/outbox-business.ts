import type { MigrationInterface, QueryRunner } from 'typeorm';
import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';

export const OUTBOX_FIXTURE_ORDERS_TABLE = 'outbox_fixture_orders';

/** Tabela de negócio de teste: uma linha por escrita confirmada. */
export class CreateOutboxFixtureOrders1794777600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "${OUTBOX_FIXTURE_ORDERS_TABLE}" (
        "id" SERIAL PRIMARY KEY,
        "name" varchar(128) NOT NULL,
        "created_at_ms" bigint NOT NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "${OUTBOX_FIXTURE_ORDERS_TABLE}"`);
  }
}

export const OUTBOX_FIXTURE_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'test/outbox-fixture',
  entities: [],
  migrations: [CreateOutboxFixtureOrders1794777600000],
};
