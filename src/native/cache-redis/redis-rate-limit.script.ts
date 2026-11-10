/**
 * Token bucket atômico no Redis. Executa como uma única unidade: leitura,
 * reposição, consumo e expiração não podem ser intercaladas por outra réplica.
 * O relógio é o do próprio Redis (TIME), para que réplicas com relógios
 * diferentes compartilhem a mesma contagem.
 *
 * KEYS[1]: chave do balde. ARGV: 1 capacidade, 2 reposição por ms, 3 TTL em ms.
 * Retorna {permitido (0|1), ms até a próxima permissão}.
 */
export const REDIS_TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = tonumber(bucket[1])
local updated = tonumber(bucket[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end
local elapsed = math.max(0, now - updated)
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updated', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, retry}
`;
