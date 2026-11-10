import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { PersistenceModuleContribution } from '../../src/native/persistence-typeorm';

/** Entidade de negócio de teste: serve para provar a atomicidade com a auditoria. */
@Entity({ name: 'audit_fixture_notes' })
export class AuditFixtureNoteOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 64 })
  id!: string;

  @Column({ name: 'body', type: 'varchar', length: 200 })
  body!: string;
}

export class CreateAuditFixtureNotes1794432000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_fixture_notes" (
        "id" varchar(64) PRIMARY KEY,
        "body" varchar(200) NOT NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_fixture_notes"`);
  }
}

/** Contribuição de negócio fictícia do teste. Não faz parte da Foundation. */
export const AUDIT_FIXTURE_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'fixture/audit-notes',
  entities: [AuditFixtureNoteOrmEntity],
  migrations: [CreateAuditFixtureNotes1794432000000],
};
