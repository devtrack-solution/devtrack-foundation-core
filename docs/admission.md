# Admissão, rate limit, pools e drenagem

Tarefa 4.5 da mudança `define-native-foundation-operational-core`. Requisito de
processamento "Saturação controlada": limites configurados, rejeição explícita com
sinal observável, sem acumulação ilimitada e drenagem no encerramento.

Nada deste recurso está ativo por padrão. Ele entra somente por
`FoundationCoreModule.withAdmission(...)` (equivalente a `AdmissionModule.register(...)`).

## Registro

```ts
import { Module } from '@nestjs/common';
import { FoundationCoreModule } from 'foundation-api/nest';
import {
  CacheRedisModule,
  REDIS_READINESS_CHECK,
  SHARED_RATE_LIMITER,
} from 'foundation-api/native/cache-redis';

@Module({
  imports: [
    FoundationCoreModule.withAdmission({
      imports: [
        CacheRedisModule.register({
          config: { host: 'redis', port: 6379, commandTimeoutMs: 200 },
        }),
      ],
      admission: {
        maxInFlight: 64,        // requisições em processamento por processo
        maxQueue: 32,           // esperas aguardando vaga (0 = rejeição imediata)
        maxQueueWaitMs: 500,    // tempo máximo de espera na fila
        retryAfterSeconds: 1,   // opcional; Retry-After das rejeições 503
        drainDeadlineMs: 10000, // opcional; prazo de drenagem no encerramento
      },
      exemptPaths: ['/health/live', '/health/ready'], // opcional (padrão)
      readiness: { checks: [REDIS_READINESS_CHECK], timeoutMs: 1000 }, // opcional
      rateLimit: {
        store: SHARED_RATE_LIMITER,
        policy: { limit: 300, windowMs: 60_000 },
        failurePolicy: 'fallback-local', // ou 'fail-closed'; padrão fallback-local
        localFallbackRatio: 0.5,         // opcional; fração do limite no fallback
        keyDigestSecret: process.env.RATE_LIMIT_DIGEST_SECRET!, // mínimo 16 caracteres
      },
      signals: OPERATION_SIGNALS,        // opcional; token de OperationSignals fornecido pelo host
    }),
  ],
})
export class AppModule {}
```

Validação na inicialização: faixas fora do intervalo, política desconhecida, fração
fora de `(0, 1]`, segredo de digest curto ou caminho sem `/` lançam erro citando
apenas o nome do campo. O valor informado nunca aparece na mensagem.

Para encerramento gracioso completo, o host deve chamar `app.enableShutdownHooks()`
em `main.ts`. Sem essa chamada, `app.close()` ainda drena, mas sinais do sistema
(SIGTERM) não disparam o encerramento do Nest.

## Admissão por processo

- `AdmissionMiddleware` roda antes de guards e handlers, para todas as rotas.
- Até `maxInFlight` requisições são processadas ao mesmo tempo. As demais esperam
  na fila, que tem tamanho `maxQueue` e prazo `maxQueueWaitMs`.
- Fila cheia, prazo de espera expirado ou drenagem respondem **503** com `Retry-After`
  e corpo neutro `{ statusCode, error, correlationId }`.
- A vaga é devolvida quando a resposta termina (ou a conexão fecha). Liberações repetidas não têm efeito.
- Caminhos de `exemptPaths` não passam pela admissão nem pelo rate limit.

## Rate limit compartilhado

- Chave: `sub:<tenant>:<subject>` para autenticados (principal do contexto autorizado,
  depois do guard) e `ip:<digest>` para anônimos. O digest é HMAC-SHA256 do IP
  com `keyDigestSecret`, truncado. O IP bruto não é guardado, nem em chave, nem em sinal.
- Algoritmo: token bucket com capacidade `limit` e reposição de `limit / windowMs` por
  milissegundo. Implementado em Redis por script Lua atômico (`src/native/cache-redis/redis-rate-limit.script.ts`).
  O relógio é o `TIME` do próprio Redis, para que réplicas com relógios diferentes
  compartilhem a mesma contagem.
- Limitado: **429** com `Retry-After` em segundos.
- O rate limit roda depois do guard. Requisições rejeitadas pelo guard (401/403)
  não consomem cota. Login com força bruta precisa de limitador próprio na rota de autenticação.

### Falha do Redis

Cada consulta compartilhada tem prazo (`sharedTimeoutMs`, padrão 200 ms) e o cliente
não enfileira comandos sem conexão (`enableOfflineQueue: false`). Falha gera
`ratelimit.degraded` e aplica a política:

| `failurePolicy` | Comportamento |
| --- | --- |
| `fallback-local` (padrão) | Limitador em memória (LRU, `localMaxKeys`, padrão 10000) com limite `floor(limit * localFallbackRatio)`, mínimo 1. Nunca libera sem limite. |
| `fail-closed` | Responde **503** `Service Unavailable` com `Retry-After`. Não libera a requisição. |

## Pools e orçamento de conexões

O pool do TypeORM é configurado no adapter de persistência, não aqui. O que este
módulo fornece é a verificação do orçamento, em função pura
(`src/core/application/admission/connection-budget.ts`, função `evaluateConnectionBudget`).
Ela ainda não está em um subpath público: use-a em teste ou script de dimensionamento.

```ts
evaluateConnectionBudget({
  maxDatabaseConnections: 100, // max_connections do servidor
  apiReplicas: 3,
  poolMaxPerReplica: 20,
  workerProcesses: 2,
  poolMaxPerWorker: 10,
  reservedConnections: 5,      // migrações e manutenção
});
// soma = 3*20 + 2*10 + 5 = 85 <= 100: retorna { requested: 85, limit: 100, headroom: 15 }
```

Regra de dimensionamento: `réplicas × pool por réplica + workers × pool por worker + reserva <= max_connections`.
Ao escalar réplicas, recalcule a soma: aumentar réplicas aumenta o consumo do banco
mesmo quando cada processo, isoladamente, parece saudável. Acima do limite, a função
lança `ConnectionBudgetError` com a lista de problemas.

## Health e drenagem

- `GET /health/live`: 200 enquanto o processo responde.
- `GET /health/ready`: 200 `{ "status": "ready" }`, ou 503 `{ "status": "unavailable" }`
  durante drenagem ou quando uma dependência obrigatória de `readiness.checks` falha
  (falha, exceção ou timeout contam como falha).
- `AdmissionService.beginDrain(deadlineMs)`: marca não pronto, rejeita novas entradas
  com 503 e aguarda as requisições em voo até o prazo. Resolve `true` se nada restou
  e `false` se o prazo expirou.
- No encerramento (`app.close()` ou sinal, com `enableShutdownHooks`), o Nest chama
  `beforeApplicationShutdown` antes de fechar o servidor HTTP. Nesse ponto o processo
  ainda atende: novas requisições recebem 503 e as em voo terminam dentro de
  `drainDeadlineMs`. Depois, o cliente Redis é encerrado.

## Sinais

Os contadores usam `OperationSignals` e os nomes do catálogo
`core/application/observability/signal-catalog.ts`:

| Sinal | Tipo | Atributo `reason` |
| --- | --- | --- |
| `foundation.admission.rejected` (recordSaturation) | contador | `queue-full`, `queue-timeout`, `draining` |
| `foundation.ratelimit.rejected` (recordSaturation) | contador | `limit-exceeded`, `store-unavailable` |
| `admission.admitted`, `admission.queued`, `admission.queue_wait` (recordActivity) | atividade / duração | — |
| `ratelimit.allowed`, `ratelimit.degraded` (recordActivity) | atividade | — |

Valores de `reason` usam hífen: o validador de atributos rejeita sublinhado.

Limitação: a profundidade da fila de espera é gauge (`foundation.queue.depth`), e a
porta `OperationSignals` atual não tem método de gauge. A profundidade fica disponível
em `AdmissionService.snapshot().queueDepth` (e `inFlight`, contadores acumulados).
Publicá-la como gauge exige extensão da porta, fora desta tarefa.

## Testes

- `src/core/application/admission/*.spec.ts`: configuração, gate, token bucket, LRU, fallback, chave, orçamento.
- `src/native/cache-redis/*.spec.ts` e `src/core/presentation/http/admission/*.spec.ts`: validação.
- `test/admission-saturation.e2e-spec.ts`: carga sustentada acima do limite (3 s, 40 req/100 ms), fila e concorrência observadas por amostragem, heap após GC explícito e recuperação.
- `test/admission-drain.e2e-spec.ts`: health live/ready, dependência obrigatória, drenagem com e sem prazo e pelo `app.close()`.
- `test/admission-shared-rate-limit.e2e-spec.ts`: Redis real (Testcontainers, `redis:7-alpine`) com duas instâncias somando consumo, isolamento por tenant e subject, readiness com Redis, e Redis indisponível com as duas políticas.

Os testes com Redis exigem Docker em execução; sem ele, falham com
`Docker did not respond to Testcontainers (Redis 7)...`.

## Limitações conhecidas

- O rate limit por subject não cobre requisições rejeitadas pelo guard.
- Profundidade da fila sem gauge no catálogo (ver Sinais).
- Após fechar um cliente ioredis apontado para porta fechada, o processo de teste
  mantém timers internos do ioredis por até alguns segundos; o Jest emite aviso
  "worker failed to exit gracefully", sem falha. Não afeta produção.
- `RedisConnectionGate` aguarda a primeira conexão no boot por no máximo `connectTimeoutMs`.
  Com Redis fora no boot, a aplicação sobe e usa a política de falha.
