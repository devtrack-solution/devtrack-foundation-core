import type { AuthenticationMethod } from '../../../core/domain/security/identity';

/** Lê o retorno de `DataSource.query` tanto para SELECT quanto para UPDATE ... RETURNING. */
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  )
    return result[0] as T[];
  return result as T[];
}

export function encodeMethod(method: AuthenticationMethod): string {
  return method.kind === 'password'
    ? 'password'
    : `federated:${method.providerId}`;
}

export function decodeMethod(value: string): AuthenticationMethod {
  if (value === 'password') return { kind: 'password' };
  const prefix = 'federated:';
  if (value.startsWith(prefix) && value.length > prefix.length)
    return { kind: 'federated', providerId: value.slice(prefix.length) };
  throw new Error('Unknown persisted authentication method');
}

export function epochMs(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}
