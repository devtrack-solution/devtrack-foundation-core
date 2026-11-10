import { AwsS3ConfigError, resolveAwsS3Options } from './aws-s3.options';
import type { AwsS3Options } from './aws-s3.options';

const BASE = { region: 'us-east-1', bucket: 'foundation-media' };

describe('resolveAwsS3Options', () => {
  it('aplica padrões seguros: SSE-S3, path-style desligado, allowlist completa', () => {
    const resolved = resolveAwsS3Options(BASE);
    expect(resolved).toMatchObject({
      region: 'us-east-1',
      bucket: 'foundation-media',
      endpoint: undefined,
      forcePathStyle: false,
      timeoutMs: 5000,
      maxAttempts: 3,
      contentTypeAllowlist: ['image/png', 'image/jpeg', 'image/webp'],
      serverSideEncryption: { mode: 'AES256' },
    });
  });

  it('aceita endpoint http local (LocalStack) e normaliza para origem', () => {
    const resolved = resolveAwsS3Options({
      ...BASE,
      endpoint: 'http://127.0.0.1:4566/',
      forcePathStyle: true,
    });
    expect(resolved.endpoint).toBe('http://127.0.0.1:4566');
    expect(resolved.forcePathStyle).toBe(true);
  });

  it.each([
    ['region', { region: '' }],
    ['region', { region: 'US EAST' }],
    ['bucket', { bucket: 'Bucket_Maiusculo' }],
    ['bucket', { bucket: 'a' }],
    ['endpoint', { endpoint: 'ftp://host' }],
    ['endpoint', { endpoint: 'http://user:senha@host:4566' }],
    ['endpoint', { endpoint: 'http://host/?token=x' }],
    ['endpoint', { endpoint: 'nao-e-url' }],
    ['timeoutMs', { timeoutMs: 50 }],
    ['timeoutMs', { timeoutMs: 60_001 }],
    ['maxAttempts', { maxAttempts: 0 }],
    ['maxAttempts', { maxAttempts: 6 }],
    ['maxObjectBytes', { maxObjectBytes: 0 }],
    ['maxObjectBytes', { maxObjectBytes: 101 * 1024 * 1024 }],
    ['contentTypeAllowlist', { contentTypeAllowlist: [] }],
    ['contentTypeAllowlist', { contentTypeAllowlist: ['text/html'] }],
    ['serverSideEncryption', { serverSideEncryption: { mode: 'none' } }],
    ['serverSideEncryption', { serverSideEncryption: { mode: 'aws:kms' } }],
  ])('recusa %s inválido citando somente o campo', (field, extra) => {
    let caught: unknown;
    try {
      resolveAwsS3Options({
        ...BASE,
        ...(extra as Partial<AwsS3Options>),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsS3ConfigError);
    expect((caught as Error).message).toBe(
      `Invalid AWS S3 configuration: ${field}`,
    );
  });

  it('aceita KMS com chave explícita', () => {
    const resolved = resolveAwsS3Options({
      ...BASE,
      serverSideEncryption: { mode: 'aws:kms', kmsKeyId: 'alias/foundation' },
    });
    expect(resolved.serverSideEncryption).toEqual({
      mode: 'aws:kms',
      kmsKeyId: 'alias/foundation',
    });
  });

  it('não expõe credenciais no resultado', () => {
    const resolved = resolveAwsS3Options(BASE) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(resolved)).not.toEqual(
      expect.arrayContaining(['credentials', 'accessKeyId', 'secretAccessKey']),
    );
  });
});
