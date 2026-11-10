import fs from 'node:fs';
import path from 'node:path';
import {
  DtoSchemaError,
  defineDtoSchema,
  getDtoSchema,
  listDtoSchemas,
} from './dto-schema';

class ContactFixtureDto {
  name!: string;
  nickname?: string;
  score?: number;
}

class OtherFixtureDto {
  value!: boolean;
}

function codeOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error instanceof DtoSchemaError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('dto schema contract', () => {
  it('registers a neutral description and returns the same class', () => {
    const returned = defineDtoSchema(ContactFixtureDto, {
      properties: {
        name: { type: 'string', required: true, maxLength: 120 },
        nickname: { type: 'string', minLength: 1 },
        score: { type: 'number', minimum: 0, maximum: 10 },
      },
    });
    expect(returned).toBe(ContactFixtureDto);
    expect(getDtoSchema(ContactFixtureDto)).toEqual({
      properties: {
        name: { type: 'string', required: true, maxLength: 120 },
        nickname: { type: 'string', minLength: 1 },
        score: { type: 'number', minimum: 0, maximum: 10 },
      },
    });
    expect(listDtoSchemas().map((entry) => entry.type)).toContain(
      ContactFixtureDto,
    );
  });

  it('keeps the registered definition frozen', () => {
    defineDtoSchema(OtherFixtureDto, {
      properties: { value: { type: 'boolean' } },
    });
    const definition = getDtoSchema(OtherFixtureDto);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.properties)).toBe(true);
  });

  it('rejects a second registration of the same class', () => {
    expect(
      codeOf(() =>
        defineDtoSchema(ContactFixtureDto, {
          properties: { name: { type: 'string' } },
        }),
      ),
    ).toBe('DUPLICATE_DTO_SCHEMA');
  });

  it('rejects inconsistent constraints without registering the class', () => {
    class BrokenDto {
      label!: string;
      count!: number;
    }
    expect(
      codeOf(() =>
        defineDtoSchema(BrokenDto, {
          properties: { label: { type: 'string', minimum: 1 } },
        }),
      ),
    ).toBe('INVALID_DTO_SCHEMA');
    expect(
      codeOf(() =>
        defineDtoSchema(BrokenDto, {
          properties: { label: { type: 'string', minLength: 5, maxLength: 2 } },
        }),
      ),
    ).toBe('INVALID_DTO_SCHEMA');
    expect(
      codeOf(() =>
        defineDtoSchema(BrokenDto, {
          properties: { count: { type: 'number', maxLength: -1 } },
        }),
      ),
    ).toBe('INVALID_DTO_SCHEMA');
    expect(
      codeOf(() =>
        defineDtoSchema(BrokenDto, {
          properties: { count: { type: 'integer' as 'number' } },
        }),
      ),
    ).toBe('INVALID_DTO_SCHEMA');
    expect(getDtoSchema(BrokenDto)).toBeUndefined();
  });

  it('rejects a DTO without properties', () => {
    class EmptyDto {}
    expect(codeOf(() => defineDtoSchema(EmptyDto, { properties: {} }))).toBe(
      'INVALID_DTO_SCHEMA',
    );
  });

  it('does not import Nest, Swagger or reflect-metadata', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'dto-schema.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"][^.]/);
    const imports = source.match(/^import[^;]*;/gm) ?? [];
    expect(imports).toEqual([]);
  });
});
