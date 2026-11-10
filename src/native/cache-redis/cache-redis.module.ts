import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ReadinessCheck } from '../../core/application/admission/readiness';
import {
  RedisCacheConfigError,
  validateRedisCacheConfig,
  type RedisCacheConfig,
  type ResolvedRedisCacheConfig,
} from './redis-cache.config';
import { RedisRateLimiter } from './redis-rate-limiter';

/** Tokens estáveis entre cópias compatíveis do pacote. */
export const REDIS_CLIENT = Symbol.for('foundation.native.cache-redis.client');
export const SHARED_RATE_LIMITER = Symbol.for(
  'foundation.native.cache-redis.shared-rate-limiter',
);
export const REDIS_READINESS_CHECK = Symbol.for(
  'foundation.native.cache-redis.readiness',
);
const REDIS_RESOLVED_CONFIG = Symbol.for(
  'foundation.native.cache-redis.config',
);

export interface CacheRedisRegistration {
  readonly config: RedisCacheConfig;
}

/** Cliente sem fila offline: comando falha rápido quando o Redis está fora, em vez de acumular. */
export function createRedisClient(config: ResolvedRedisCacheConfig): Redis {
  const client = new Redis({
    host: config.host,
    port: config.port,
    ...(config.password === undefined ? {} : { password: config.password }),
    db: config.db,
    connectTimeout: config.connectTimeoutMs,
    commandTimeout: config.commandTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (times: number) =>
      Math.min(50 * 2 ** Math.min(times, 8), 5_000),
    lazyConnect: false,
  });
  // Erros de conexão são tratados pelo chamador (fallback); sem listener o ioredis imprime o erro bruto.
  client.on('error', () => undefined);
  return client;
}

/** Readiness do Redis: PING dentro do prazo de comando. */
export class RedisReadinessCheck implements ReadinessCheck {
  constructor(private readonly client: Pick<Redis, 'ping'>) {}

  async check(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }
}

/**
 * Antes de aceitar tráfego, espera a primeira conexão (no máximo `connectTimeoutMs`).
 * Sem essa espera, comandos enviados no boot falhariam por falta de conexão e
 * cairiam no fallback. Depois do boot, falhas continuam rápidas, sem fila.
 */
@Injectable()
export class RedisConnectionGate implements OnApplicationBootstrap {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(REDIS_RESOLVED_CONFIG)
    private readonly config: ResolvedRedisCacheConfig,
  ) {}

  onApplicationBootstrap(): Promise<void> {
    if (this.client.status === 'ready') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.client.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, this.config.connectTimeoutMs);
      this.client.once('ready', done);
    });
  }
}

@Injectable()
export class RedisClientCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // Fecha depois da drenagem do HTTP. QUIT tem prazo curto; depois disso o socket é encerrado à força.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 500);
    });
    await Promise.race([
      this.client.quit().then(
        () => undefined,
        () => undefined,
      ),
      expired,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    this.client.disconnect();
  }
}

export interface CacheRedisAsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: readonly InjectionToken[];
  /** Devolve a configuração (ex.: lida de um cofre). Falha de validação impede o boot. */
  readonly useFactory: (
    ...args: unknown[]
  ) => RedisCacheConfig | Promise<RedisCacheConfig>;
}

/** Providers comuns a register e registerAsync: dependem só da configuração resolvida. */
function sharedProviders(): Provider[] {
  return [
    {
      provide: REDIS_CLIENT,
      inject: [REDIS_RESOLVED_CONFIG],
      useFactory: (config: ResolvedRedisCacheConfig) =>
        createRedisClient(config),
    },
    RedisClientCloser,
    RedisConnectionGate,
    {
      provide: SHARED_RATE_LIMITER,
      inject: [REDIS_CLIENT, REDIS_RESOLVED_CONFIG],
      useFactory: (client: Redis, config: ResolvedRedisCacheConfig) =>
        new RedisRateLimiter(client, config.keyPrefix),
    },
    {
      provide: REDIS_READINESS_CHECK,
      inject: [REDIS_CLIENT],
      useFactory: (client: Redis) => new RedisReadinessCheck(client),
    },
  ];
}

/** Módulo opt-in. Nada é conectado sem `register` ou `registerAsync`. */
@Module({})
export class CacheRedisModule {
  static register(options: CacheRedisRegistration): DynamicModule {
    const config = validateRedisCacheConfig(options.config);
    return {
      module: CacheRedisModule,
      providers: [
        { provide: REDIS_RESOLVED_CONFIG, useValue: config },
        ...sharedProviders(),
      ],
      exports: [SHARED_RATE_LIMITER, REDIS_READINESS_CHECK],
    };
  }

  /**
   * Configuração vinda do host (ex.: cofre), resolvida na injeção. Configuração
   * inválida falha na criação do módulo, antes de qualquer conexão.
   */
  static registerAsync(options: CacheRedisAsyncOptions): DynamicModule {
    if (typeof options?.useFactory !== 'function')
      throw new RedisCacheConfigError('useFactory');
    return {
      module: CacheRedisModule,
      imports: options.imports,
      providers: [
        {
          provide: REDIS_RESOLVED_CONFIG,
          inject: [...(options.inject ?? [])],
          useFactory: async (...args: unknown[]) =>
            validateRedisCacheConfig(await options.useFactory(...args)),
        },
        ...sharedProviders(),
      ],
      exports: [SHARED_RATE_LIMITER, REDIS_READINESS_CHECK],
    };
  }
}
