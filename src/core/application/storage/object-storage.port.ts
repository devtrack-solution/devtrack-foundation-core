/**
 * Porta pura de object storage. Sem SDK, sem Nest: adapters técnicos (ex.:
 * native/aws-s3) implementam esta interface e traduzem falhas para os códigos
 * neutros abaixo. Mensagens nunca carregam a chave nem o conteúdo.
 */
export type ObjectStorageErrorCode =
  | 'object_not_found'
  | 'storage_unavailable'
  | 'object_too_large'
  | 'invalid_object_key'
  | 'invalid_content_type'
  | 'invalid_object_body';

const MESSAGES: Readonly<Record<ObjectStorageErrorCode, string>> = {
  object_not_found: 'Object not found',
  storage_unavailable: 'Object storage is unavailable',
  object_too_large: 'Object exceeds the allowed size',
  invalid_object_key: 'Object key does not follow the tenant-scoped format',
  invalid_content_type: 'Content type is not allowed for this storage',
  invalid_object_body: 'Object body must be a byte array',
};

/** Erro neutro de storage. O código é estável; a mensagem é fixa. */
export class ObjectStorageError extends Error {
  constructor(readonly code: ObjectStorageErrorCode) {
    super(MESSAGES[code]);
    this.name = 'ObjectStorageError';
  }
}

export interface ObjectPutRequest {
  /** Chave com prefixo `tenants/<tenant>/` (ver assertTenantObjectKey). */
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  /** Tamanho máximo aceito para este objeto. body acima deste limite falha. */
  readonly maxBytes: number;
}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * Garantias exigidas de quem implementa:
 * - put sobrescreve a chave; falha com `object_too_large` antes de gravar qualquer byte.
 * - get e delete validam a chave; get ausente falha com `object_not_found`.
 * - delete de chave ausente é idempotente (resolve).
 * - Nenhum objeto é público; leitura de outro tenant nunca é possível por chave válida de outro prefixo.
 */
export interface ObjectStorage {
  put(request: ObjectPutRequest): Promise<void>;
  get(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  /** Opcional: URL de leitura temporária. Adapters que não suportam não a implementam. */
  signedReadUrl?(key: string, ttlMs: number): Promise<string>;
}
