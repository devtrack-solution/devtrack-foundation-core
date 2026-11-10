# Jobs, atividades e worker (tarefa 4.4)

Entrega da tarefa 4.4 da mudança `define-native-foundation-operational-core`:
atividade e job com retries limitados, backoff, concorrência e falha terminal,
mais um processo worker separado da API com drenagem por prazo.

## Modelo

- **Envelope** (`JobEnvelope`, `core/application/execution`): `id`, `type`,
  `payloadVersion`, `payload`, `subjectId`, `tenantId?`, `correlationId`,
  `deadlineAt`, `maxAttempts` e `traceContext?` (somente `traceparent` e
  `tracestate`, repassados sem interpretação). Não contém bearer token.
- **Atividade** (`ActivityRecord`): `id` (= id do job), `type`, `state`,
  `attempts`, `lastErrorCode`, `correlationId`, `subjectId`, `tenantId`,
  timestamps. Estados: `queued`, `running`, `succeeded`, `failed_retryable`,
  `failed_terminal`, `cancelled`. `lastErrorCode` é um código estável; a
  mensagem bruta de erro nunca é gravada.
- **Consulta**: `ActivityStore.find(id, tenantId)`. `tenantId` `null` consulta
  apenas atividades sem tenant. Não há consulta que cruze tenants.

## Handlers

Um handler por `type`, com uma `payloadVersion`:

```ts
const handler: JobHandler<SyncContactPayload> = {
  type: 'contacts.sync',
  payloadVersion: 1,
  async handle(payload, context) {
    // context: jobId, attempt, correlationId, deadlineAt, principal, traceContext, signal
  },
};
```

- `JobHandlerRegistry` rejeita `type` duplicado (`job_handler_duplicate_type`).
- Versão de payload diferente da declarada gera falha terminal
  (`job_payload_version_unsupported`); `type` sem handler gera
  `job_handler_not_found`.
- **Handlers devem ser idempotentes.** A entrega é at-least-once: após kill,
  drenagem com prazo ou expiração de lock, o mesmo job pode rodar de novo.
  Efeitos internos devem ser chaveados pelo `jobId` (por exemplo, inserção com
  `ON CONFLICT DO NOTHING`). Handlers devem observar `context.signal`, que é
  disparado em timeout e na drenagem forçada.

## Reautorização

Antes de cada tentativa, o executor chama `IdentityAccessResolver.bySubject(subjectId)`
e reconstrói o `Principal` atual. Identidade ausente ou tenant diferente do
envelope gera `job_reauthorization_denied` (terminal) e o handler não roda.

## Política de execução

| Regra | Valor |
| --- | --- |
| Tentativas | `min(envelope.maxAttempts, retry.globalMaxAttempts)`, mínimo 1 |
| Backoff | exponencial: teto = `min(maxDelayMs, baseDelayMs * 2^(n-1))`; atraso sorteado em `[teto/2, teto]` ("equal jitter") |
| Timeout | `retry.timeoutMs` por tentativa; se o prazo do envelope for menor, vale o prazo |
| Prazo vencido | não executa; falha terminal `job_deadline_exceeded` |
| Timeout do handler | recuperável `job_timeout` |
| Erro recuperável | recuperável `job_handler_error` (erro desconhecido também) |
| Erro terminal | sem retry |
| Último orçamento | falha recuperável na última tentativa vira `failed_terminal` |

Orçamento único: o retry é feito somente pelo BullMQ (`attempts` no job e
backoff da política). A aplicação não reenfileira por conta própria. Erro
terminal sobe como `UnrecoverableError`, que vai direto para a fila de falha.

## Fila de falha (DLQ)

Jobs terminais ficam no conjunto `failed` do BullMQ (`removeOnFail: false`), com
`failedReason` igual ao código de erro. A atividade correspondente fica com o
estado `failed_terminal`, que é a fonte consultável. Não há reprocessamento
automático da fila de falha; reprocessar é uma operação explícita.

## Submissão

`JobSubmitter.submit(envelope)`:

1. valida o envelope (campos, tamanho do payload, traceContext, `maxAttempts`);
2. grava a atividade como `queued` apenas se a id não existir;
3. enfileira. Reenviar a mesma id é seguro: a fila deduplica (`already_present`).

Se o broker falhar depois do passo 2, a atividade fica `queued` e o produtor
repete a chamada com a mesma id.

## Drenagem (SIGTERM)

`runWorkerProcess` trata SIGTERM e SIGINT:

1. `consumer.drain(prazo)` pausa a busca de novos jobs e aguarda os em execução
   até `FOUNDATION_WORKER_DRAIN_DEADLINE_MS`;
2. ao vencer o prazo, o worker é fechado à força. Jobs ainda ativos perdem o
   lock e voltam à fila pelo mecanismo de stalled do BullMQ;
3. `app.close()` fecha persistência e Redis; o processo sai com código `0`.

O Nest `enableShutdownHooks` não é usado para sinais: ele fecharia o DataSource
antes da drenagem. A ordem de encerramento fica explícita no entrypoint.

## Escala API × worker

- A API usa `QueueBullmqModule.register({ consume: false, ... })`: só produz
  (`JobSubmitter`), sem consumir.
- O worker usa `consume: true` e roda em processo próprio (`src/worker.ts`).
  Escale réplicas de cada um conforme a carga.
- Concorrência por processo: `FOUNDATION_WORKER_CONCURRENCY` (1 a 64).
- Dimensione o pool do PostgreSQL pela soma de réplicas da API, workers e pools
  (ver `evaluateConnectionBudget` em `docs/admission.md`).

## Configuração do worker

Variáveis (defaults entre parênteses):

- Redis: `FOUNDATION_REDIS_HOST` (obrigatório), `FOUNDATION_REDIS_PORT` (6379),
  `FOUNDATION_REDIS_PASSWORD`, `FOUNDATION_REDIS_DB`.
- Fila: `FOUNDATION_JOBS_QUEUE` (`foundation-jobs`), `FOUNDATION_JOBS_MAX_PAYLOAD_BYTES` (65536),
  `FOUNDATION_JOBS_MAX_ATTEMPTS` (5), `FOUNDATION_JOBS_BACKOFF_BASE_MS` (1000),
  `FOUNDATION_JOBS_BACKOFF_MAX_MS` (60000), `FOUNDATION_JOBS_TIMEOUT_MS` (30000).
- Consumo: `FOUNDATION_WORKER_CONCURRENCY` (4), `FOUNDATION_WORKER_LOCK_MS` (30000),
  `FOUNDATION_WORKER_STALLED_INTERVAL_MS` (30000), `FOUNDATION_WORKER_MAX_STALLED` (3),
  `FOUNDATION_WORKER_DRAIN_DEADLINE_MS` (30000).
- Banco: `FOUNDATION_DB_*` (como na persistência; `FOUNDATION_DB_MIGRATIONS_RUN=true`
  aplica a migration de `activities`).

Valores inválidos impedem o boot e a mensagem cita apenas o nome do campo.

## Composição

1. Incluir `ACTIVITIES_PERSISTENCE` (`moduleId: 'foundation/activities'`) em
   `PERSISTENCE_CONTRIBUTIONS` (`native/persistence-typeorm/persistence-contributions.ts`).
   O worker já a inclui de forma idempotente.
2. Declarar os handlers de cada módulo e passá-los ao worker. Um `type` por handler.
3. Fornecer `IdentityAccessResolver` do host. Sem ele, `startWorker` lança
   `worker_identity_resolver_missing` e o worker não sobe.
4. Entrypoint: `src/worker.ts` (`runWorkerProcess({ env, handlers, identity })`).

## Evidência de testes

- Unitários (`src/core/application/activities`, `src/native/queue-bullmq`): registry,
  política de backoff e teto, classificação, reautorização, prazo, timeout, validação
  de envelope e de configuração.
- E2E com Redis e PostgreSQL reais (testcontainers): `test/worker-activity-store.e2e-spec.ts`,
  `test/worker-bullmq.e2e-spec.ts`, `test/worker-recovery.e2e-spec.ts`.

## Limites

- Outbox (intenção de publicação ligada à escrita transacional) não faz parte
  desta tarefa.
- Métricas de job no catálogo de sinais não foram adicionadas.
- A fila de falha não tem reprocessamento automatizado.
