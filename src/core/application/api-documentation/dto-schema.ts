/**
 * Contrato neutro de documentação de DTOs. Application pura: não importa Nest,
 * decorators nem a biblioteca de Swagger. Módulos de negócio descrevem seus DTOs
 * aqui; o módulo oficial `@devtrack/swagger-adapter` (`ext/swagger-adapter`) traduz o registro para OpenAPI
 * somente quando a capacidade é selecionada. Sem o adapter, o registro existe e
 * nada é carregado de biblioteca externa.
 */

export type DtoPropertyType = 'string' | 'number' | 'boolean';

export interface DtoPropertySchema {
  readonly type: DtoPropertyType;
  /** Padrão: opcional. */
  readonly required?: boolean;
  readonly description?: string;
  /** Somente para `string`. */
  readonly minLength?: number;
  /** Somente para `string`. */
  readonly maxLength?: number;
  /** Somente para `number`. */
  readonly minimum?: number;
  /** Somente para `number`. */
  readonly maximum?: number;
}

export interface DtoSchemaDefinition {
  readonly description?: string;
  readonly properties: Readonly<Record<string, DtoPropertySchema>>;
}

/** Classe de DTO. Não exige decorators nem reflect-metadata. */
export type DtoType<T extends object = object> = new (...args: never[]) => T;

/** Entrada tipada: as chaves de `properties` são as propriedades reais da classe. */
export interface DtoSchemaInput<T extends object> {
  readonly description?: string;
  readonly properties: { readonly [K in keyof T]?: DtoPropertySchema };
}

export type DtoSchemaErrorCode = 'INVALID_DTO_SCHEMA' | 'DUPLICATE_DTO_SCHEMA';

/** A mensagem cita apenas o caminho do campo, nunca valores. */
export class DtoSchemaError extends Error {
  constructor(
    readonly code: DtoSchemaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DtoSchemaError';
  }
}

const PROPERTY_TYPES: readonly string[] = ['string', 'number', 'boolean'];
const registry = new Map<DtoType, DtoSchemaDefinition>();

function invalid(field: string): DtoSchemaError {
  return new DtoSchemaError(
    'INVALID_DTO_SCHEMA',
    `Invalid DTO schema: ${field}`,
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateProperty(field: string, value: unknown): DtoPropertySchema {
  if (typeof value !== 'object' || value === null) throw invalid(field);
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== 'string' || !PROPERTY_TYPES.includes(raw.type))
    throw invalid(`${field}.type`);
  const type = raw.type as DtoPropertyType;
  if (raw.required !== undefined && typeof raw.required !== 'boolean')
    throw invalid(`${field}.required`);
  if (raw.description !== undefined && typeof raw.description !== 'string')
    throw invalid(`${field}.description`);

  const lengths = ['minLength', 'maxLength'] as const;
  for (const key of lengths) {
    if (raw[key] === undefined) continue;
    if (type !== 'string' || !isSafeNonNegativeInteger(raw[key]))
      throw invalid(`${field}.${key}`);
  }
  if (
    raw.minLength !== undefined &&
    raw.maxLength !== undefined &&
    (raw.minLength as number) > (raw.maxLength as number)
  )
    throw invalid(`${field}.minLength`);

  const bounds = ['minimum', 'maximum'] as const;
  for (const key of bounds) {
    if (raw[key] === undefined) continue;
    if (type !== 'number' || !Number.isFinite(raw[key]))
      throw invalid(`${field}.${key}`);
  }
  if (
    raw.minimum !== undefined &&
    raw.maximum !== undefined &&
    (raw.minimum as number) > (raw.maximum as number)
  )
    throw invalid(`${field}.minimum`);

  return Object.freeze({
    type,
    ...(raw.required === undefined ? {} : { required: raw.required }),
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.minLength === undefined ? {} : { minLength: raw.minLength }),
    ...(raw.maxLength === undefined ? {} : { maxLength: raw.maxLength }),
    ...(raw.minimum === undefined ? {} : { minimum: raw.minimum }),
    ...(raw.maximum === undefined ? {} : { maximum: raw.maximum }),
  } as DtoPropertySchema);
}

/**
 * Registra a descrição neutra de um DTO. Falha de validação ou segundo registro
 * da mesma classe lançam DtoSchemaError; nada é registrado parcialmente.
 */
export function defineDtoSchema<T extends object>(
  type: DtoType<T>,
  input: DtoSchemaInput<T>,
): DtoType<T> {
  if (registry.has(type))
    throw new DtoSchemaError(
      'DUPLICATE_DTO_SCHEMA',
      `DTO schema already defined: ${type.name}`,
    );
  const owner = type.name || 'anonymous';
  if (typeof input !== 'object' || input === null) throw invalid(owner);
  if (input.description !== undefined && typeof input.description !== 'string')
    throw invalid(`${owner}.description`);
  const entries = Object.entries(input.properties as Record<string, unknown>);
  if (entries.length === 0) throw invalid(`${owner}.properties`);

  const properties: Record<string, DtoPropertySchema> = {};
  for (const [name, value] of entries) {
    if (name.trim() === '') throw invalid(`${owner}.properties`);
    properties[name] = validateProperty(`${owner}.${name}`, value);
  }

  registry.set(
    type,
    Object.freeze({
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      properties: Object.freeze(properties),
    }),
  );
  return type;
}

/** Descrição registrada para a classe, ou undefined. */
export function getDtoSchema(type: DtoType): DtoSchemaDefinition | undefined {
  return registry.get(type);
}

/** Todas as descrições registradas, na ordem de registro. */
export function listDtoSchemas(): readonly {
  readonly type: DtoType;
  readonly definition: DtoSchemaDefinition;
}[] {
  return [...registry].map(([type, definition]) => ({ type, definition }));
}
