import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CacheRedisModule } from './cache-redis.module';
import { RedisCacheConfigError } from './redis-cache.config';

const HOST_CONFIG = Symbol('test.cache-redis.config');

describe('CacheRedisModule', () => {
  it('register continua validando a configuração de forma síncrona', () => {
    expect(() =>
      CacheRedisModule.register({ config: { host: '', port: 6379 } }),
    ).toThrow(RedisCacheConfigError);
  });

  it('registerAsync rejeita configuração inválida vinda do host na criação do módulo', async () => {
    @Module({
      providers: [{ provide: HOST_CONFIG, useValue: { host: 'x', port: 0 } }],
      exports: [HOST_CONFIG],
    })
    class HostModule {}

    const moduleRef = CacheRedisModule.registerAsync({
      imports: [HostModule],
      inject: [HOST_CONFIG],
      useFactory: (config: unknown) => config as never,
    });

    await expect(
      Test.createTestingModule({ imports: [moduleRef] }).compile(),
    ).rejects.toThrow('Invalid redis configuration: port');
  });

  it('registerAsync exige useFactory', () => {
    expect(() =>
      CacheRedisModule.registerAsync({
        useFactory: undefined as unknown as () => never,
      }),
    ).toThrow(RedisCacheConfigError);
  });
});
