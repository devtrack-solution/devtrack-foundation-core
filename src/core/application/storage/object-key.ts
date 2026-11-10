import { ObjectStorageError } from './object-storage.port';
import type { ObjectPutRequest } from './object-storage.port';

/** Limite total da chave. Acima disso a chave é recusada antes de qualquer I/O. */
export const OBJECT_KEY_MAX_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Exige `tenants/<tenant>/<caminho>`: prefixo de tenant obrigatório, segmentos
 * seguros e sem traversal (`.`, `..`, vazio, barra inicial ou final).
 */
export function assertTenantObjectKey(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > OBJECT_KEY_MAX_LENGTH
  )
    throw new ObjectStorageError('invalid_object_key');
  const segments = key.split('/');
  if (segments.length < 4 || segments[0] !== 'tenants')
    throw new ObjectStorageError('invalid_object_key');
  for (const segment of segments.slice(1)) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..')
      throw new ObjectStorageError('invalid_object_key');
  }
}

/**
 * Valida uma requisição de gravação para qualquer adapter: chave, limites e
 * allowlist de Content-Type. Retorna sem alterar a entrada.
 */
export function assertPutRequest(
  request: ObjectPutRequest,
  allowedContentTypes: readonly string[],
): void {
  assertTenantObjectKey(request?.key);
  if (!(request.body instanceof Uint8Array))
    throw new ObjectStorageError('invalid_object_body');
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1)
    throw new ObjectStorageError('object_too_large');
  if (!allowedContentTypes.includes(request.contentType))
    throw new ObjectStorageError('invalid_content_type');
  if (request.body.byteLength > request.maxBytes)
    throw new ObjectStorageError('object_too_large');
}
