import type { MigrationInterface, QueryRunner } from 'typeorm';
import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';

export const IDEMPOTENCY_FIXTURE_CONTACTS_TABLE =
  'idempotency_fixture_contacts';

/** Tabela de negócio de teste: uma linha por efeito interno confirmado. */
export class CreateIdempotencyFixtureContacts1794518400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "${IDEMPOTENCY_FIXTURE_CONTACTS_TABLE}" (
        "id" SERIAL PRIMARY KEY,
        "intent_key" varchar(128) NOT NULL,
        "name" varchar(128) NOT NULL,
        "created_at_ms" bigint NOT NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE "${IDEMPOTENCY_FIXTURE_CONTACTS_TABLE}"`,
    );
  }
}

export const IDEMPOTENCY_FIXTURE_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'test/idempotency-fixture',
  entities: [],
  migrations: [CreateIdempotencyFixtureContacts1794518400000],
};
