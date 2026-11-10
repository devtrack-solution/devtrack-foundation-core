import { Entity, PrimaryColumn } from 'typeorm';
import type { MigrationInterface } from 'typeorm';
import { buildPersistenceCatalog } from './persistence-catalog';
import type { PersistenceModuleContribution } from './persistence-catalog';

@Entity({ name: 'unit_alpha' })
class UnitAlpha {
  @PrimaryColumn() id!: string;
}

@Entity({ name: 'unit_beta' })
class UnitBeta {
  @PrimaryColumn() id!: string;
}

@Entity({ name: 'unit_alpha' })
class UnitAlphaSameTable {
  @PrimaryColumn() id!: string;
}

class NotDecorated {
  id!: string;
}

class AddAlpha1700000000001 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

class AddBeta1700000000002 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

class SharedNameOne implements MigrationInterface {
  name = 'Shared1700000000003';
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

class SharedNameTwo implements MigrationInterface {
  name = 'Shared1700000000003';
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

class NoTimestamp implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

const alpha: PersistenceModuleContribution = {
  moduleId: 'unit-alpha',
  entities: [UnitAlpha],
  migrations: [AddAlpha1700000000001],
};

const beta: PersistenceModuleContribution = {
  moduleId: 'unit-beta',
  entities: [UnitBeta],
  migrations: [AddBeta1700000000002],
};

function codeOf(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('buildPersistenceCatalog', () => {
  it('aggregates modules in declaration order and freezes the result', () => {
    const catalog = buildPersistenceCatalog([alpha, beta]);

    expect(catalog.modules).toEqual(['unit-alpha', 'unit-beta']);
    expect(catalog.entities).toEqual([UnitAlpha, UnitBeta]);
    expect(catalog.migrations).toEqual([
      AddAlpha1700000000001,
      AddBeta1700000000002,
    ]);
    expect(catalog.tables).toEqual(['unit_alpha', 'unit_beta']);
    expect(catalog.migrationNames).toEqual([
      'AddAlpha1700000000001',
      'AddBeta1700000000002',
    ]);
    expect(Object.isFrozen(catalog.entities)).toBe(true);
  });

  it('accepts a module without entities or migrations', () => {
    const catalog = buildPersistenceCatalog([
      { moduleId: 'empty', entities: [], migrations: [] },
    ]);
    expect(catalog.tables).toEqual([]);
  });

  it('rejects a duplicated moduleId', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          alpha,
          { ...alpha, entities: [], migrations: [] },
        ]),
      ),
    ).toBe('PERSISTENCE_DUPLICATE_MODULE_ID');
  });

  it('rejects the same table declared by two modules', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          alpha,
          {
            moduleId: 'other',
            entities: [UnitAlphaSameTable],
            migrations: [],
          },
        ]),
      ),
    ).toBe('PERSISTENCE_DUPLICATE_TABLE');
  });

  it('rejects the same entity class registered twice', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          alpha,
          { moduleId: 'again', entities: [UnitAlpha], migrations: [] },
        ]),
      ),
    ).toBe('PERSISTENCE_DUPLICATE_ENTITY');
  });

  it('rejects the same migration class registered twice', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          alpha,
          {
            moduleId: 'again',
            entities: [],
            migrations: [AddAlpha1700000000001],
          },
        ]),
      ),
    ).toBe('PERSISTENCE_DUPLICATE_MIGRATION');
  });

  it('rejects two different migration classes with the same name', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          { moduleId: 'one', entities: [], migrations: [SharedNameOne] },
          { moduleId: 'two', entities: [], migrations: [SharedNameTwo] },
        ]),
      ),
    ).toBe('PERSISTENCE_DUPLICATE_MIGRATION_NAME');
  });

  it('rejects a migration whose name does not end with a 13-digit timestamp', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          { moduleId: 'bad', entities: [], migrations: [NoTimestamp] },
        ]),
      ),
    ).toBe('PERSISTENCE_INVALID_MIGRATION');
  });

  it('rejects a class that is not decorated with @Entity', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          { moduleId: 'plain', entities: [NotDecorated], migrations: [] },
        ]),
      ),
    ).toBe('PERSISTENCE_INVALID_ENTITY');
  });

  it('rejects a blank moduleId', () => {
    expect(
      codeOf(() =>
        buildPersistenceCatalog([
          { moduleId: '  ', entities: [], migrations: [] },
        ]),
      ),
    ).toBe('PERSISTENCE_INVALID_CONTRIBUTION');
  });
});
