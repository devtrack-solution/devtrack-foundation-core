import { ObjectStorageError } from '../../core/application/storage';
import { S3ObjectStorage } from './aws-s3.adapter';
import type { AwsS3Transport } from './aws-s3.adapter';
import { resolveAwsS3Options } from './aws-s3.options';

const PNG = 'image/png';

type Recorded = { name: string; input: Record<string, unknown> };

function fakeTransport(respond: (command: Recorded) => unknown): {
  transport: AwsS3Transport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport = {
    send: (command: unknown) => {
      const typed = command as {
        constructor: { name: string };
        input: Record<string, unknown>;
      };
      const recorded = { name: typed.constructor.name, input: typed.input };
      calls.push(recorded);
      return Promise.resolve(respond(recorded));
    },
  };
  return { transport, calls };
}

const config = resolveAwsS3Options({ region: 'us-east-1', bucket: 'media' });
const key = 'tenants/t1/contacts/c1/avatar';

function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe('S3ObjectStorage (transporte substituído)', () => {
  it('put envia SSE-S3 por padrão, sem ACL e com Content-Type controlado', async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    await new S3ObjectStorage(config, transport).put({
      key,
      body: Uint8Array.from([1, 2]),
      contentType: PNG,
      maxBytes: 10,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('PutObjectCommand');
    expect(calls[0]?.input).toMatchObject({
      Bucket: 'media',
      Key: key,
      ContentType: PNG,
      ServerSideEncryption: 'AES256',
    });
    expect(calls[0]?.input).not.toHaveProperty('ACL');
    expect(calls[0]?.input).not.toHaveProperty('SSEKMSKeyId');
  });

  it('put com KMS envia a chave informada', async () => {
    const kms = resolveAwsS3Options({
      region: 'us-east-1',
      bucket: 'media',
      serverSideEncryption: { mode: 'aws:kms', kmsKeyId: 'alias/foundation' },
    });
    const { transport, calls } = fakeTransport(() => ({}));
    await new S3ObjectStorage(kms, transport).put({
      key,
      body: Uint8Array.from([1]),
      contentType: PNG,
      maxBytes: 10,
    });
    expect(calls[0]?.input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'alias/foundation',
    });
  });

  it('recusa put acima do limite antes de chamar o SDK', async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    const error = await errorOf(
      new S3ObjectStorage(config, transport).put({
        key,
        body: new Uint8Array(11),
        contentType: PNG,
        maxBytes: 10,
      }),
    );
    expect(error).toMatchObject({ code: 'object_too_large' });
    expect(calls).toHaveLength(0);
  });

  it('recusa Content-Type fora da allowlist antes de chamar o SDK', async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    const error = await errorOf(
      new S3ObjectStorage(config, transport).put({
        key,
        body: Uint8Array.from([1]),
        contentType: 'application/x-msdownload',
        maxBytes: 10,
      }),
    );
    expect(error).toMatchObject({ code: 'invalid_content_type' });
    expect(calls).toHaveLength(0);
  });

  it('get traduz NoSuchKey para object_not_found', async () => {
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error('The specified key does not exist.'), {
        name: 'NoSuchKey',
      });
    });
    expect(
      await errorOf(new S3ObjectStorage(config, transport).get(key)),
    ).toMatchObject({
      code: 'object_not_found',
    });
  });

  it('get traduz 404 HTTP sem nome conhecido para object_not_found', async () => {
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error('not found'), {
        $metadata: { httpStatusCode: 404 },
      });
    });
    expect(
      await errorOf(new S3ObjectStorage(config, transport).get(key)),
    ).toMatchObject({
      code: 'object_not_found',
    });
  });

  it('falhas genéricas do SDK viram storage_unavailable sem vazar a mensagem original', async () => {
    const { transport } = fakeTransport(() => {
      throw new Error('socket hang up secret-detail');
    });
    const error = await errorOf(
      new S3ObjectStorage(config, transport).get(key),
    );
    expect(error).toBeInstanceOf(ObjectStorageError);
    expect(error).toMatchObject({ code: 'storage_unavailable' });
    expect((error as Error).message).not.toContain('secret-detail');
  });

  it('get recusa objeto acima do teto antes de ler o corpo', async () => {
    const { transport } = fakeTransport(() => ({
      ContentLength: config.maxObjectBytes + 1,
      ContentType: PNG,
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(0)) },
    }));
    expect(
      await errorOf(new S3ObjectStorage(config, transport).get(key)),
    ).toMatchObject({
      code: 'object_too_large',
    });
  });

  it('get devolve bytes e Content-Type da resposta', async () => {
    const { transport } = fakeTransport(() => ({
      ContentLength: 2,
      ContentType: PNG,
      Body: {
        transformToByteArray: () => Promise.resolve(Uint8Array.from([7, 8])),
      },
    }));
    const stored = await new S3ObjectStorage(config, transport).get(key);
    expect(Array.from(stored.body)).toEqual([7, 8]);
    expect(stored.contentType).toBe(PNG);
  });

  it('chave inválida é recusada antes de qualquer chamada', async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    const storage = new S3ObjectStorage(config, transport);
    await expect(storage.get('tenants/t1/../x')).rejects.toMatchObject({
      code: 'invalid_object_key',
    });
    await expect(storage.delete('/tenants/t1/a')).rejects.toMatchObject({
      code: 'invalid_object_key',
    });
    expect(calls).toHaveLength(0);
  });
});
