import {
  assertPutRequest,
  assertTenantObjectKey,
  ObjectStorageError,
} from '../../../src/core/application/storage';
import type {
  ObjectPutRequest,
  ObjectStorage,
  StoredObject,
} from '../../../src/core/application/storage';
import { AWS_S3_DEFAULT_CONTENT_TYPES } from '../../../src/native/aws-s3/aws-s3.options';

/**
 * Duplo de teste da porta ObjectStorage. Não é adapter de produção: guarda bytes
 * em Map e aplica as mesmas validações da porta, para que a suíte de contrato
 * rode igual contra ele e contra o adapter S3.
 */
export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  constructor(
    private readonly allowedContentTypes: readonly string[] = AWS_S3_DEFAULT_CONTENT_TYPES,
  ) {}

  put(request: ObjectPutRequest): Promise<void> {
    return settle(() => {
      assertPutRequest(request, this.allowedContentTypes);
      this.objects.set(request.key, {
        body: new Uint8Array(request.body),
        contentType: request.contentType,
      });
    });
  }

  get(key: string): Promise<StoredObject> {
    return settle(() => {
      assertTenantObjectKey(key);
      const stored = this.objects.get(key);
      if (stored === undefined)
        throw new ObjectStorageError('object_not_found');
      return {
        body: new Uint8Array(stored.body),
        contentType: stored.contentType,
      };
    });
  }

  delete(key: string): Promise<void> {
    return settle(() => {
      assertTenantObjectKey(key);
      this.objects.delete(key);
    });
  }
}

/** Executa de forma síncrona e devolve o resultado como Promise, sem `async` vazio. */
function settle<Result>(action: () => Result): Promise<Result> {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
