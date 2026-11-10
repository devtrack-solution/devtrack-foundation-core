import { IdempotencyContentError } from './idempotency.errors';

/**
 * JSON canônico: chaves de objeto em ordem lexical, sem espaços. Propriedades
 * `undefined` em objetos são omitidas (como no JSON); `undefined` em arrays,
 * funções, símbolos, `NaN`, `Infinity`, instâncias não planas (Date, Map...) e
 * ciclos lançam `IdempotencyContentError`.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new IdempotencyContentError();
      return JSON.stringify(value);
    case 'object':
      return serializeObject(value, ancestors);
    default:
      throw new IdempotencyContentError();
  }
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new IdempotencyContentError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item: unknown) => {
        if (item === undefined) throw new IdempotencyContentError();
        return serialize(item, ancestors);
      });
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new IdempotencyContentError();
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
