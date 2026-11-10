import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AWS_S3_OBJECT_STORAGE, AwsS3Module } from './aws-s3.module';
import { S3ObjectStorage } from './aws-s3.adapter';
import { AwsS3ConfigError } from './aws-s3.options';

describe('AwsS3Module', () => {
  it('exporta o provider sob o símbolo estável da Foundation', () => {
    expect(AWS_S3_OBJECT_STORAGE).toBe(
      Symbol.for('foundation.api.v1.native.aws-s3.object-storage'),
    );
  });

  it('register valida a configuração antes do boot', () => {
    expect(() =>
      AwsS3Module.register({ region: 'us-east-1', bucket: 'INVALIDO' }),
    ).toThrow(AwsS3ConfigError);
  });

  it('registerAsync rejeita configuração inválida devolvida pela fábrica', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          AwsS3Module.registerAsync({
            useFactory: () => ({
              region: 'us-east-1',
              bucket: 'media',
              timeoutMs: 1,
            }),
          }),
        ],
      }).compile(),
    ).rejects.toBeInstanceOf(AwsS3ConfigError);
  });

  it('expõe o adapter para módulos consumidores que importam AwsS3Module', async () => {
    @Module({
      imports: [AwsS3Module.register({ region: 'us-east-1', bucket: 'media' })],
    })
    class ConsumerModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [ConsumerModule],
    }).compile();
    expect(moduleRef.get(AWS_S3_OBJECT_STORAGE)).toBeInstanceOf(
      S3ObjectStorage,
    );
  });
});
