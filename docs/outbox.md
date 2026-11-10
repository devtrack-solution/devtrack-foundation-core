# Outbox, inbox e efeitos externos

Este documento descreve o mecanismo genérico de entrega confiável da Foundation:
intenção de publicação gravada com a escrita de negócio (outbox), relay que
publica no broker, deduplicação do consumidor (inbox) e tratamento de efeitos
externos com resultado incerto.

**Garantia real:** entrega *at-least-once* entre banco e broker, e efeito *único*
no consumidor que usa inbox. **Não há exactly-once externo.** Chamadas a provedores
(AWS, WhatsApp, pagamentos) só são seguras com chave de idempotência suportada pelo
provedor, deduplicação do receptor ou reconciliação.

## Componentes

| Peça | Camada | Local |
| --- | --- | --- |
| `OutboxIntent`, `OutboxSnapshot`, limites | Application (pura) | `src/core/application/outbox/outbox.model.ts` |
| Validação da intenção | Application | `outbox.validation.ts` |
| Portas `OutboxWriter`, `InboxStore`, `OutboxStore` | Application | `outbox.ports.ts` |
| `OutboxRelay` (drenagem em lotes) | Application | `outbox-relay.ts` |
| `InboxGuard` (efeito único por consumidor) | Application | `inbox-guard.ts` |
| `ExternalEffectRunner` (efeito externo sob idempotência) | Application | `external-effect.ts` |
| `TypeOrmOutboxWriter`, `TypeOrmInboxStore`, `TypeOrmOutboxStore` | Native | `src/native/persistence-typeorm/outbox/` |
| Contribuição `OUTBOX_PERSISTENCE` (`foundation/outbox`) | Native | `outbox.contribution.ts` |

A camada de aplicação não importa TypeORM nem BullMQ. Os adapters ficam em
`src/native/**`.

## Tabelas

`outbox_messages` (migration `CreateOutboxMessages1794604800000`):

- `id` (PK, vira `JobEnvelope.id` e `jobId` no broker), `type`, `payload_version`,
  `payload` (jsonb), `subject_id`, `tenant_id`, `correlation_id`, `trace_context`.
- `state`: `pending` | `published` | `failed`.
- `attempts`: número de reivindicações para publicação.
- `next_attempt_at_ms`: quando a mensagem volta a ser elegível. Também é o lease de
  quem a reivindicou.
- `last_error_code`: código técnico (`BROKER_UNAVAILABLE`, `MAX_ATTEMPTS_EXCEEDED`,
  `ENVELOPE_INVALID`). Nunca guarda mensagem de erro bruta.
- `created_at_ms`, `published_at_ms`, `updated_at_ms`.
- Índice `(state, next_attempt_at_ms)` para a varredura de elegíveis.

`inbox_messages` (migration `CreateInboxMessages1794691200000`):

- Chave primária `(consumer_id, message_id)`. A unicidade é por consumidor: o mesmo
  evento pode ser processado por consumidores diferentes, mas só uma vez por cada um.

`inbox_messages` e `outbox_messages` pertencem ao catálogo de persistência do host.

## Uso no caso de uso (escrita + intenção)

A intenção é gravada pelo recurso `outbox` do UnitOfWork, na mesma transação da
escrita de negócio. Nunca publique no broker dentro do `run`.

```ts
const unitOfWork = new TypeOrmUnitOfWork(dataSource, (manager) => ({
  contacts: new TypeOrmContactRepository(manager),
  outbox: new TypeOrmOutboxWriter(manager, clock),
}));

await unitOfWork.run(async ({ contacts, outbox }) => {
  await contacts.save(contact);
  await outbox.append({
    id: `contact-created-${contact.id}`,
    type: 'contacts.created',
    payloadVersion: 1,
    payload: { contactId: contact.id },
    subjectId,
    correlationId,
  });
});
```

Se o `run` lançar, a escrita de negócio e a intenção são desfeitas juntas. Se o
commit ocorrer e o broker estiver fora, a intenção permanece `pending` até o relay
publicá-la.

## Relay

`OutboxRelay.drainOnce()` executa uma rodada: reivindica até `batchSize` mensagens
elegíveis e publica cada uma pela porta `JobQueue` com `envelope.id = message.id`.
O processo que chama `drainOnce` (um laço com intervalo no worker, por exemplo)
é responsabilidade do integrador.

- **Reivindicação concorrente:** `claimDue` faz um `UPDATE ... FROM (SELECT ... FOR
  UPDATE SKIP LOCKED)`. Relays concorrentes não reivindicam a mesma linha. A posse
  dura `leaseMs` (via `next_attempt_at_ms`).
- **Recuperação:** relay que cai no meio do lote não libera nada explicitamente. Após
  o lease, outro relay retoma as mensagens pendentes.
- **Publicação repetida:** crash entre publicar e marcar `published` faz a mensagem
  ser publicada de novo. O broker deduplica pelo `jobId` (BullMQ devolve
  `already_present`) e o consumidor usa inbox.
- **Falha de broker:** a mensagem fica `pending`, com `attempts` incrementado,
  `last_error_code = BROKER_UNAVAILABLE` e backoff exponencial limitado
  (`min(maxMs, baseMs * 2^(tentativas-1))`, sem jitter). A rodada para na primeira
  falha; as demais reivindicações expiram pelo lease.
- **Esgotamento:** ao atingir `maxAttempts`, a mensagem vai a `failed` com
  `MAX_ATTEMPTS_EXCEEDED`. Envelope inválido vai a `failed` com `ENVELOPE_INVALID`
  na primeira tentativa. Nada é descartado: linhas `failed` ficam para inspeção e
  reprocessamento manual.
- **Limites:** `batchSize` (1 a 500) e `maxPublishPerSecond` (1 a 10 000) por relay.
  Ao atingir o teto na janela de um segundo, `drainOnce` devolve `rateLimited: true`
  sem reivindicar.

### Sinalização

`OutboxRelay.snapshot()` devolve `pending`, `failed`, `oldestPendingAgeMs` e
`maxPendingAttempts`. A ligação com `OperationSignals` (catálogo de saturação) não
foi feita: o catálogo está fora do escopo desta entrega e deve receber as métricas
de pendência e falha pelo integrador.

## Inbox: efeito único no consumidor

```ts
const guard = new InboxGuard(unitOfWork, clock); // recursos incluem `inbox`

await guard.applyOnce({ consumerId: 'billing', messageId: job.data.id }, async ({ billing }) => {
  await billing.applyContactCreated(job.data.payload);
});
```

Dentro da transação: registra `(consumerId, messageId)` e aplica o efeito apenas
se o registro for novo. Entrega repetida retorna `{ applied: false }` sem repetir
o efeito. O efeito não deve fazer chamadas de rede.

## Efeitos externos com resultado incerto

`ExternalEffectRunner` envolve `IdempotencyService.execute`:

1. Grava a intenção antes da chamada (`in_progress`, com lease e fencing).
2. Repassa a chave do cliente ao provedor como chave de idempotência.
3. Falha classificada como `IdempotentRetryableFailure` ou `IdempotentTerminalFailure`
   grava o desfecho correspondente.
4. Falha ambígua (sem classificação) grava `outcome_unknown`. Nenhuma nova chamada é
   feita automaticamente: novas tentativas recebem `IdempotencyOutcomeUnknownError`.
5. `reconcile(context, operation, clientKey, reconciler)` decide pelo provedor:
   `confirmed` grava o resultado (replays não chamam o provedor de novo);
   `not_performed` libera nova tentativa; `unresolved` mantém o bloqueio.

Não use transação aberta durante a chamada externa. Grave a intenção, chame o
provedor fora de transação e registre o resultado em nova escrita idempotente.

## Testes

- `test/outbox-postgres.e2e-spec.ts` (PostgreSQL 16 real): atomicidade (commit e
  rollback), intenção inválida desfaz a escrita, relays concorrentes com exatamente
  uma publicação por mensagem, recuperação após relay morto, publicação repetida com
  inbox, falha de broker com tentativas crescentes até `failed`, envelope inválido,
  limite de taxa, e efeito externo (ambíguo, confirmado, não realizado, não resolvido).
- `test/outbox-broker.e2e-spec.ts` (PostgreSQL 16 e Redis 7 reais): broker
  indisponível após commit (porta fechada por proxy TCP, depois reaberta), com
  publicação e processamento pelo consumidor BullMQ; publicação repetida no broker real.
- `src/core/application/outbox/*.spec.ts`: relay com store em memória, validação e inbox.

Para rodar: `npx jest --config ./test/jest-e2e.json --runInBand test/outbox` (requer Docker).

## Fora do escopo desta entrega

- Adição de `OUTBOX_PERSISTENCE` a `PERSISTENCE_CONTRIBUTIONS` e ao catálogo do
  runtime e da CLI (integrador).
- Módulo Nest do relay e laço de agendamento com múltiplas réplicas.
- Ligação das métricas de pendência a `OperationSignals`.
- Jitter no backoff e purga de linhas `published` antigas (operação separada).
