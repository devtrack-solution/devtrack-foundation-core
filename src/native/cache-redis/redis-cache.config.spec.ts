import {
  RedisCacheConfigError,
  validateRedisCacheConfig,
} from './redis-cache.config';

const base = { host: 'redis.internal', port: 6379 };

describe('validateRedisCacheConfig', () => {
  it('aplica padrões seguros', () => {
    expect(validateRedisCacheConfig(base)).toEqual({
      host: 'redis.internal',
      port: 6379,
      db: 0,
      keyPrefix: 'foundation:rl:',
      connectTimeoutMs: 1_000,
      commandTimeoutMs: 200,
    });
  });

  it.each([
    ['host', { host: '' }],
    ['port', { port: 0 }],
    ['port', { port: 70_000 }],
    ['db', { db: 16 }],
    ['keyPrefix', { keyPrefix: 'bad prefix' }],
    ['connectTimeoutMs', { connectTimeoutMs: 5 }],
    ['commandTimeoutMs', { commandTimeoutMs: 20_000 }],
  ])('rejeita %s inválido citando só o nome do campo', (field, patch) => {
    let caught: unknown;
    try {
      validateRedisCacheConfig({ ...base, ...patch });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedisCacheConfigError);
    expect((caught as RedisCacheConfigError).field).toBe(field);
  });

  it('não expõe a senha em mensagens de erro', () => {
    let message = '';
    try {
      validateRedisCacheConfig({ ...base, port: -1, password: 'super-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Invalid redis configuration: port');
    expect(message).not.toContain('super-secret');
  });
});
