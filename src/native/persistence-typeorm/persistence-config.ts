import { PersistenceError } from './persistence-errors';

/** Entrada do host. Não existe campo para ligar `synchronize`. */
export interface PersistenceConfigInput {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly applicationName: string;
  readonly poolMax?: number;
  readonly connectTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly ssl?: boolean;
  /** Opt-in: aplica migrations pendentes no boot. Padrão: false. */
  readonly migrationsRun?: boolean;
  /** Forçado para `false`. Qualquer outro valor lança PERSISTENCE_SYNCHRONIZE_FORBIDDEN. */
  readonly synchronize?: false;
}

/** Configuração validada e normalizada. */
export interface PersistenceConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly applicationName: string;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly ssl: boolean;
  readonly migrationsRun: boolean;
}

export const PERSISTENCE_DEFAULTS = Object.freeze({
  poolMax: 10,
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
  ssl: false,
  migrationsRun: false,
});

export const PERSISTENCE_LIMITS = Object.freeze({
  poolMax: { min: 1, max: 100 },
  connectTimeoutMs: { min: 1, max: 60_000 },
  statementTimeoutMs: { min: 1, max: 600_000 },
  applicationNameMaxLength: 63,
});

const APPLICATION_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Valida a entrada do host. Mensagens nunca incluem a senha. */
export function validatePersistenceConfig(
  input: PersistenceConfigInput,
): PersistenceConfig {
  if (input === null || typeof input !== 'object') {
    throw new PersistenceError(
      'PERSISTENCE_INVALID_CONFIG',
      'Persistence config must be an object',
    );
  }
  if (input.synchronize !== undefined && input.synchronize !== false) {
    throw new PersistenceError(
      'PERSISTENCE_SYNCHRONIZE_FORBIDDEN',
      'synchronize is forced to false; schema changes must go through migrations',
    );
  }

  const host = requireText(input.host, 'host');
  const database = requireText(input.database, 'database');
  const username = requireText(input.username, 'username');
  if (typeof input.password !== 'string') {
    throw invalidConfig('password must be a string');
  }
  if (!isInteger(input.port, 1, 65_535)) {
    throw invalidConfig('port must be an integer between 1 and 65535');
  }
  const applicationName = input.applicationName;
  if (
    typeof applicationName !== 'string' ||
    applicationName.length === 0 ||
    applicationName.length > PERSISTENCE_LIMITS.applicationNameMaxLength ||
    !APPLICATION_NAME_PATTERN.test(applicationName)
  ) {
    throw invalidConfig(
      'applicationName must be 1-63 characters: letters, digits, "_", "." or "-"',
    );
  }

  const poolMax = input.poolMax ?? PERSISTENCE_DEFAULTS.poolMax;
  if (
    !isInteger(
      poolMax,
      PERSISTENCE_LIMITS.poolMax.min,
      PERSISTENCE_LIMITS.poolMax.max,
    )
  ) {
    throw new PersistenceError(
      'PERSISTENCE_INVALID_POOL_SIZE',
      `poolMax must be an integer between ${PERSISTENCE_LIMITS.poolMax.min} and ${PERSISTENCE_LIMITS.poolMax.max}`,
    );
  }
  const connectTimeoutMs =
    input.connectTimeoutMs ?? PERSISTENCE_DEFAULTS.connectTimeoutMs;
  if (
    !isInteger(
      connectTimeoutMs,
      PERSISTENCE_LIMITS.connectTimeoutMs.min,
      PERSISTENCE_LIMITS.connectTimeoutMs.max,
    )
  ) {
    throw invalidConfig(
      'connectTimeoutMs must be an integer in milliseconds within the allowed range',
    );
  }
  const statementTimeoutMs =
    input.statementTimeoutMs ?? PERSISTENCE_DEFAULTS.statementTimeoutMs;
  if (
    !isInteger(
      statementTimeoutMs,
      PERSISTENCE_LIMITS.statementTimeoutMs.min,
      PERSISTENCE_LIMITS.statementTimeoutMs.max,
    )
  ) {
    throw invalidConfig(
      'statementTimeoutMs must be an integer in milliseconds within the allowed range',
    );
  }
  const ssl = input.ssl ?? PERSISTENCE_DEFAULTS.ssl;
  const migrationsRun =
    input.migrationsRun ?? PERSISTENCE_DEFAULTS.migrationsRun;
  if (typeof ssl !== 'boolean' || typeof migrationsRun !== 'boolean') {
    throw invalidConfig('ssl and migrationsRun must be booleans');
  }

  return Object.freeze({
    host,
    port: input.port,
    database,
    username,
    password: input.password,
    applicationName,
    poolMax,
    connectTimeoutMs,
    statementTimeoutMs,
    ssl,
    migrationsRun,
  });
}

/**
 * Lê a configuração de variáveis de ambiente `FOUNDATION_DB_*`. Nunca lê perfil
 * de composição. `FOUNDATION_DB_SYNCHRONIZE` só é aceito como `false`.
 */
export function persistenceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PersistenceConfigInput {
  if (
    env.FOUNDATION_DB_SYNCHRONIZE !== undefined &&
    env.FOUNDATION_DB_SYNCHRONIZE !== 'false'
  ) {
    throw new PersistenceError(
      'PERSISTENCE_SYNCHRONIZE_FORBIDDEN',
      'FOUNDATION_DB_SYNCHRONIZE is forced to false; schema changes must go through migrations',
    );
  }
  return {
    host: env.FOUNDATION_DB_HOST ?? '',
    port: parseNumberEnv(env.FOUNDATION_DB_PORT, 5432),
    database: env.FOUNDATION_DB_NAME ?? '',
    username: env.FOUNDATION_DB_USER ?? '',
    password: env.FOUNDATION_DB_PASSWORD ?? '',
    applicationName: env.FOUNDATION_DB_APPLICATION_NAME ?? '',
    poolMax: parseOptionalNumberEnv(env.FOUNDATION_DB_POOL_MAX),
    connectTimeoutMs: parseOptionalNumberEnv(
      env.FOUNDATION_DB_CONNECT_TIMEOUT_MS,
    ),
    statementTimeoutMs: parseOptionalNumberEnv(
      env.FOUNDATION_DB_STATEMENT_TIMEOUT_MS,
    ),
    ssl: parseBooleanEnv(env.FOUNDATION_DB_SSL, 'FOUNDATION_DB_SSL'),
    migrationsRun: parseBooleanEnv(
      env.FOUNDATION_DB_MIGRATIONS_RUN,
      'FOUNDATION_DB_MIGRATIONS_RUN',
    ),
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidConfig(`${field} is required`);
  }
  return value;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function invalidConfig(detail: string): PersistenceError {
  return new PersistenceError(
    'PERSISTENCE_INVALID_CONFIG',
    `Invalid persistence config: ${detail}`,
  );
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : toNumber(value);
}

function parseOptionalNumberEnv(value: string | undefined): number | undefined {
  return value === undefined ? undefined : toNumber(value);
}

function toNumber(value: string): number {
  // Valor não numérico vira NaN e é rejeitado pela validação com o código adequado.
  return value.trim() === '' ? Number.NaN : Number(value);
}

function parseBooleanEnv(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalidConfig(`${name} must be "true" or "false"`);
}
