import { PersistenceTypeOrmModule } from './persistence-typeorm.module';
import type { PersistenceConfigInput } from './persistence-config';

const config: PersistenceConfigInput = {
  host: 'localhost',
  port: 5432,
  database: 'foundation',
  username: 'foundation',
  password: 'not-a-real-secret',
  applicationName: 'foundation-module',
};

function codeOf(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('PersistenceTypeOrmModule registration', () => {
  it('validates the configuration eagerly in register', () => {
    const invalid = {
      ...config,
      synchronize: true,
    } as unknown as PersistenceConfigInput;
    expect(
      codeOf(() =>
        PersistenceTypeOrmModule.register({
          contributions: [],
          config: invalid,
        }),
      ),
    ).toBe('PERSISTENCE_SYNCHRONIZE_FORBIDDEN');
  });

  it('rejects an invalid pool size eagerly in register', () => {
    expect(
      codeOf(() =>
        PersistenceTypeOrmModule.register({
          contributions: [],
          config: { ...config, poolMax: 0 },
        }),
      ),
    ).toBe('PERSISTENCE_INVALID_POOL_SIZE');
  });

  it('rejects registerAsync without a factory', () => {
    expect(
      codeOf(() =>
        PersistenceTypeOrmModule.registerAsync({
          useFactory: undefined as unknown as () => never,
        }),
      ),
    ).toBe('PERSISTENCE_INVALID_CONFIG');
  });
});
