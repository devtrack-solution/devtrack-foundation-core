/** Configuração do Redis compartilhado. Valida faixas; erros citam só o nome do campo. */
export class RedisCacheConfigError extends Error {
  constructor(readonly field: string) {
    super(`Invalid redis configuration: ${field}`);
    this.name = 'RedisCacheConfigError';
  }
}

export interface RedisCacheConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;
  /** Prefixo das chaves de rate limit. Padrão: `foundation:rl:`. */
  readonly keyPrefix?: string;
  /** Tempo máximo para abrir conexão, em ms. Padrão: 1000. */
  readonly connectTimeoutMs?: number;
  /** Tempo máximo de cada comando, em ms. Padrão: 200. */
  readonly commandTimeoutMs?: number;
}

export interface ResolvedRedisCacheConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db: number;
  readonly keyPrefix: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
}

const DEFAULT_KEY_PREFIX = 'foundation:rl:';

export function validateRedisCacheConfig(
  input: RedisCacheConfig,
): ResolvedRedisCacheConfig {
  if (input === null || typeof input !== 'object')
    throw new RedisCacheConfigError('redis');
  if (
    typeof input.host !== 'string' ||
    input.host.length === 0 ||
    input.host.length > 255
  )
    throw new RedisCacheConfigError('host');
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  )
    throw new RedisCacheConfigError('port');
  const db = input.db ?? 0;
  if (!Number.isSafeInteger(db) || db < 0 || db > 15)
    throw new RedisCacheConfigError('db');
  const keyPrefix = input.keyPrefix ?? DEFAULT_KEY_PREFIX;
  if (!/^[A-Za-z0-9:._-]{1,64}$/.test(keyPrefix))
    throw new RedisCacheConfigError('keyPrefix');
  const connectTimeoutMs = input.connectTimeoutMs ?? 1_000;
  if (
    !Number.isSafeInteger(connectTimeoutMs) ||
    connectTimeoutMs < 10 ||
    connectTimeoutMs > 30_000
  )
    throw new RedisCacheConfigError('connectTimeoutMs');
  const commandTimeoutMs = input.commandTimeoutMs ?? 200;
  if (
    !Number.isSafeInteger(commandTimeoutMs) ||
    commandTimeoutMs < 10 ||
    commandTimeoutMs > 10_000
  )
    throw new RedisCacheConfigError('commandTimeoutMs');
  return {
    host: input.host,
    port: input.port,
    ...(input.password === undefined ? {} : { password: input.password }),
    db,
    keyPrefix,
    connectTimeoutMs,
    commandTimeoutMs,
  };
}
