import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  assertPutRequest,
  assertTenantObjectKey,
  ObjectStorageError,
} from '../../core/application/storage';
import type {
  ObjectPutRequest,
  ObjectStorage,
  StoredObject,
} from '../../core/application/storage';
import { resolveAwsS3Options } from './aws-s3.options';
import type { AwsS3Options, ResolvedAwsS3Options } from './aws-s3.options';

/** Subconjunto do cliente usado pelo adapter. Permite substituir o transporte em testes unitários. */
export type AwsS3Transport = Pick<S3Client, 'send'>;

/**
 * Adapter nativo de ObjectStorage sobre `@aws-sdk/client-s3`. Único lugar do
 * projeto que importa o SDK de S3. Falhas do SDK viram ObjectStorageError neutro.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: AwsS3Transport;

  constructor(
    private readonly config: ResolvedAwsS3Options,
    client?: AwsS3Transport,
  ) {
    this.client =
      client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        forcePathStyle: config.forcePathStyle,
        maxAttempts: config.maxAttempts,
        retryMode: 'standard',
        requestHandler: {
          requestTimeout: config.timeoutMs,
          connectionTimeout: config.timeoutMs,
        },
      });
  }

  async put(request: ObjectPutRequest): Promise<void> {
    assertPutRequest(request, this.config.contentTypeAllowlist);
    if (request.maxBytes > this.config.maxObjectBytes)
      throw new ObjectStorageError('object_too_large');
    const encryption = this.config.serverSideEncryption;
    await this.call(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: request.key,
        Body: request.body,
        ContentType: request.contentType,
        ServerSideEncryption: encryption.mode,
        ...(encryption.mode === 'aws:kms'
          ? { SSEKMSKeyId: encryption.kmsKeyId }
          : {}),
      }),
    );
  }

  async get(key: string): Promise<StoredObject> {
    assertTenantObjectKey(key);
    const response = await this.call<GetObjectCommandOutput>(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    const length = response.ContentLength;
    if (length !== undefined && length > this.config.maxObjectBytes)
      throw new ObjectStorageError('object_too_large');
    if (response.Body === undefined)
      throw new ObjectStorageError('storage_unavailable');
    const body = await readBody(response.Body);
    if (body.byteLength > this.config.maxObjectBytes)
      throw new ObjectStorageError('object_too_large');
    return {
      body,
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    assertTenantObjectKey(key);
    await this.call(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  private async call<Output>(command: {
    readonly input: unknown;
  }): Promise<Output> {
    try {
      return (await this.client.send(command as never)) as Output;
    } catch (error) {
      throw mapFailure(error);
    }
  }
}

/** Cria o adapter validando a configuração antes de qualquer uso. */
export function createS3ObjectStorage(
  options: AwsS3Options,
  client?: AwsS3Transport,
): S3ObjectStorage {
  return new S3ObjectStorage(resolveAwsS3Options(options), client);
}

function mapFailure(error: unknown): ObjectStorageError {
  if (error instanceof ObjectStorageError) return error;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.$metadata?.httpStatusCode === 404
  )
    return new ObjectStorageError('object_not_found');
  if (candidate?.name === 'EntityTooLarge')
    return new ObjectStorageError('object_too_large');
  return new ObjectStorageError('storage_unavailable');
}

async function readBody(body: unknown): Promise<Uint8Array> {
  const mixin = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof mixin?.transformToByteArray !== 'function')
    throw new ObjectStorageError('storage_unavailable');
  try {
    return await mixin.transformToByteArray();
  } catch {
    throw new ObjectStorageError('storage_unavailable');
  }
}
