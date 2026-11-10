import {
  persistenceConfigFromEnv,
  validatePersistenceConfig,
} from './persistence-config';
import type { PersistenceConfigInput } from './persistence-config';

const base: PersistenceConfigInput = {
  host: 'db.internal',
  port: 5432,
  database: 'foundation',
  username: 'foundation',
  password: 'secret-value-that-must-not-leak',
  applicationName: 'foundation-api',
};

function codeOf(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('validatePersistenceConfig', () => {
  it('normalizes defaults for pool, timeouts, ssl and migrationsRun', () => {
    const config = validatePersistenceConfig(base);
    expect(config).toMatchObject({
      poolMax: 10,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      ssl: false,
      migrationsRun: false,
    });
  });

  it('accepts synchronize explicitly set to false', () => {
    expect(() =>
      validatePersistenceConfig({ ...base, synchronize: false }),
    ).not.toThrow();
  });

  it('rejects synchronize true', () => {
    const input = {
      ...base,
      synchronize: true,
    } as unknown as PersistenceConfigInput;
    expect(codeOf(() => validatePersistenceConfig(input))).toBe(
      'PERSISTENCE_SYNCHRONIZE_FORBIDDEN',
    );
  });

  it.each([0, 101, 1.5, Number.NaN, -3])('rejects pool size %p', (poolMax) => {
    expect(codeOf(() => validatePersistenceConfig({ ...base, poolMax }))).toBe(
      'PERSISTENCE_INVALID_POOL_SIZE',
    );
  });

  it('accepts the pool bounds 1 and 100', () => {
    expect(validatePersistenceConfig({ ...base, poolMax: 1 }).poolMax).toBe(1);
    expect(validatePersistenceConfig({ ...base, poolMax: 100 }).poolMax).toBe(
      100,
    );
  });

  it('rejects an invalid port without leaking the password', () => {
    let message = '';
    try {
      validatePersistenceConfig({ ...base, port: 70000 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('port');
    expect(message).not.toContain(base.password);
  });

  it('rejects an empty host and an invalid application name', () => {
    expect(
      codeOf(() => validatePersistenceConfig({ ...base, host: ' ' })),
    ).toBe('PERSISTENCE_INVALID_CONFIG');
    expect(
      codeOf(() =>
        validatePersistenceConfig({ ...base, applicationName: 'x'.repeat(64) }),
      ),
    ).toBe('PERSISTENCE_INVALID_CONFIG');
  });
});

describe('persistenceConfigFromEnv', () => {
  const env = {
    FOUNDATION_DB_HOST: 'db.internal',
    FOUNDATION_DB_NAME: 'foundation',
    FOUNDATION_DB_USER: 'foundation',
    FOUNDATION_DB_PASSWORD: 'from-env',
    FOUNDATION_DB_APPLICATION_NAME: 'foundation-api',
    FOUNDATION_DB_POOL_MAX: '7',
    FOUNDATION_DB_MIGRATIONS_RUN: 'true',
  };

  it('reads FOUNDATION_DB_* variables and applies the defaults', () => {
    const config = validatePersistenceConfig(persistenceConfigFromEnv(env));
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      poolMax: 7,
      migrationsRun: true,
      ssl: false,
    });
  });

  it('rejects FOUNDATION_DB_SYNCHRONIZE set to anything but false', () => {
    expect(
      codeOf(() =>
        persistenceConfigFromEnv({ ...env, FOUNDATION_DB_SYNCHRONIZE: 'true' }),
      ),
    ).toBe('PERSISTENCE_SYNCHRONIZE_FORBIDDEN');
  });

  it('rejects a non-numeric pool size', () => {
    expect(
      codeOf(() =>
        validatePersistenceConfig(
          persistenceConfigFromEnv({ ...env, FOUNDATION_DB_POOL_MAX: 'abc' }),
        ),
      ),
    ).toBe('PERSISTENCE_INVALID_POOL_SIZE');
  });

  it('rejects a boolean flag that is not true or false', () => {
    expect(
      codeOf(() =>
        persistenceConfigFromEnv({ ...env, FOUNDATION_DB_SSL: 'yes' }),
      ),
    ).toBe('PERSISTENCE_INVALID_CONFIG');
  });
});
