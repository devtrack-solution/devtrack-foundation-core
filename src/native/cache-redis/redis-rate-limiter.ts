import type { Redis } from 'ioredis';
import type {
  RateLimitDecision,
  RateLimiter,
} from '../../core/application/admission/rate-limit';
import type { RateLimitPolicy } from '../../core/application/admission/admission.config';
import { REDIS_TOKEN_BUCKET_SCRIPT } from './redis-rate-limit.script';

/** Limitador compartilhado: um balde por chave, atômico no Redis (script Lua). */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly client: Pick<Redis, 'eval'>,
    private readonly keyPrefix: string,
  ) {}

  async consume(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    const reply = await this.client.eval(
      REDIS_TOKEN_BUCKET_SCRIPT,
      1,
      `${this.keyPrefix}${key}`,
      String(policy.limit),
      String(policy.limit / policy.windowMs),
      String(policy.windowMs),
    );
    if (
      !Array.isArray(reply) ||
      reply.length !== 2 ||
      typeof reply[0] !== 'number' ||
      typeof reply[1] !== 'number'
    )
      throw new Error('redis_rate_limit_reply');
    return {
      allowed: reply[0] === 1,
      retryAfterMs: reply[0] === 1 ? 0 : reply[1],
    };
  }
}
