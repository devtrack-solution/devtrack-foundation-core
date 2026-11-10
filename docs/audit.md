# Auditoria durável

Tarefa 3.5. Auditoria é um registro durável, separado de logs, traces e métricas.
Ela guarda ator, operação, alvo, resultado e correlação de ações auditáveis, e
sobrevive à falha ou desativação de telemetria.

## Modelo

| Peça | Onde | Papel |
| --- | --- | --- |
| `AuditEntry`, `AuditWriter` | `core/application/audit/audit-writer.port.ts` | Entrada e porta de escrita (existentes, sem mudança de forma). |
| `AuditContext`, `createAuditContext` | `core/application/audit/audit-context.ts` | Projeção de `subjectId`, `tenantId?` e `correlationId` (existentes). |
| `toAuditRecord` | `core/application/audit/audit-validation.ts` | Allowlist de campos. Copia só os campos permitidos e valida cada um. |
| `AuditReader` | `core/application/audit/audit-reader.port.ts` | Porta de leitura, separada do writer. |
| `readAuditTrail` | `core/application/audit/audit-access.ts` | Função de aplicação: exige `audit:read` e tenant no principal. |
| `createAuditRetentionPolicy` | `core/application/audit/audit-validation.ts` | Política de retenção validada. |
| `TypeOrmAuditWriter` | `native/persistence-typeorm/audit/typeorm-audit-writer.ts` | Escrita SQL explícita em `audit_entries`. |
| `TypeOrmAuditReader` | `native/persistence-typeorm/audit/typeorm-audit-reader.ts` | Leitura por tenant, intervalo, ação e página limitada. |
| `TypeOrmAuditRetention` | `native/persistence-typeorm/audit/typeorm-audit-retention.ts` | `purgeExpired(batchSize)`, a única via de DELETE. |
| `AUDIT_PERSISTENCE` | `native/persistence-typeorm/audit/audit.contribution.ts` | Contribuição `foundation/audit` (entidade e migration). |

Core não importa TypeORM. Tudo que toca banco fica em `src/native/**`.

## Campos gravados

A tabela `audit_entries` tem exatamente oito colunas:
`id`, `occurred_at` (epoch ms), `subject_id`, `tenant_id` (nulo quando não há tenant),
`correlation_id`, `action`, `target`, `outcome` (`succeeded`, `denied`, `failed`).

O writer nunca espalha o objeto recebido. Ele chama `toAuditRecord`, que lê apenas
esses campos. Permissões, deadline, tokens, e-mails, senhas e qualquer outra
propriedade extra são ignorados em runtime, mesmo quando o objeto não respeita o tipo.

### Validações

- `action`: minúsculas, `^[a-z][a-z0-9_.-]{0,63}$`.
- `target`: `^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`. Sem espaço nem `@`. Rejeitado se
  tiver sequência opaca de 32 ou mais caracteres, JWT (`eyJ...`), segmento de 24 ou
  mais caracteres, segmento sensível (`token`, `password`, `senha`, `secret`,
  `credential`, `cpf`, `email`, `permission` e similares) ou 11 dígitos ou mais
  (CPF, cartão).
- Identificadores (`id`, `subjectId`, `tenantId`, `correlationId`): até 64 ou 128
  caracteres, sem `@`.
- Mensagens de erro nunca ecoam o valor recebido.

Erros usam `AuditValidationError` com código estável: `audit_invalid_entry`,
`audit_invalid_action`, `audit_invalid_target`, `audit_invalid_context`,
`audit_invalid_query`, `audit_invalid_policy`.

## Escrita junto com o negócio

O writer é construído a partir do `EntityManager` da transação. Assim, auditoria e
escrita de negócio confirmam ou desfazem juntas:

```ts
const uow = new TypeOrmUnitOfWork(dataSource, (manager) => ({
  contacts: manager.getRepository(ContactOrmEntity),
  audit: new TypeOrmAuditWriter(manager),
}));

await uow.run(async ({ contacts, audit }) => {
  await contacts.insert(row);
  await audit.append(entry); // mesma transação
});
```

Falha em qualquer ponto do `work` desfaz as duas escritas. Não faça chamadas de
rede dentro do `work`.

## Leitura

`readAuditTrail(reader, context, input)` é a única forma de consultar a trilha pela
aplicação:

- Exige `audit:read` em `principal.permissions`. Sem a permissão, lança
  `AuditAccessError` com código `permission_denied`.
- O tenant vem sempre do principal autenticado. Entrada com outro tenant é ignorada.
  Sem tenant no principal, lança `audit_tenant_required`.
- Limites: `limit` de 1 a 100 (padrão 50), `offset` de 0 a 10.000, intervalo
  `[fromMs, toMs)` com `fromMs < toMs`, `action` opcional. Valores fora da faixa são
  rejeitados antes de chegar ao banco.
- Ordem: mais recente primeiro.

A permissão `audit:read` é dedicada. Não a conceda por papéis de negócio. A leitura
não tem rota HTTP pública e não deve ser exposta junto das rotas de negócio. Se o
host quiser uma rota de auditoria, ela precisa de decisão própria e de revisão de
exposição.

## Retenção

- `createAuditRetentionPolicy({ retentionDays })`: padrão 365 dias, faixa válida
  de 1 a 3650 dias.
- `new TypeOrmAuditRetention(dataSource, policy, now?).purgeExpired(batchSize)`
  remove somente entradas com `occurred_at` anterior a `now - retentionMs`. O lote
  é limitado a 1.000 entradas e devolve a quantidade removida. Chame em loop ou em
  job periódico até devolver 0.
- A purga é a única via de DELETE. O trigger `TRG_audit_entries_append_only`
  rejeita UPDATE e DELETE fora dela. A purga ativa `foundation.audit.purge` apenas
  dentro da transação do lote.
- Retenção de auditoria é independente de logs e traces. Expiração de telemetria não
  remove auditoria, e purga de auditoria não toca em telemetria.

Papéis e privilégios do PostgreSQL continuam sendo responsabilidade do operador. O
trigger impede alteração pela aplicação, mas não substitui um usuário de banco sem
permissão de `UPDATE` e `DELETE` na tabela.

## Independência de telemetria

O writer, o reader e a purga não importam nenhum pacote `@opentelemetry/*`. Testes de
integração comprovam que:

- Um processo sem OTel (sem instrumentação carregada) confirma a operação e a
  auditoria fica recuperável pelo `AuditReader`.
- Um processo com OTel inicializado e exportador apontando para endpoint
  inalcançável também confirma a operação, e a auditoria continua recuperável.

Auditoria não depende de exportação. Nunca use traces ou logs como trilha de auditoria.

## Dados proibidos

Os testes de integração gravam entradas com permissões, deadline, token, e-mail e
senha dentro do contexto. Em seguida, fazem `SELECT *` em toda a tabela e verificam
que nenhum desses valores aparece nas linhas, e que a tabela tem só as oito colunas
permitidas.

## Contribuição para o integrador

Esta etapa não altera os arquivos do host. O integrador deve:

1. Incluir `AUDIT_PERSISTENCE` em `PERSISTENCE_CONTRIBUTIONS`
   (`src/native/persistence-typeorm/persistence-contributions.ts`). A CLI usa a mesma
   lista.
2. Opcionalmente, reexportar `AUDIT_PERSISTENCE`, `TypeOrmAuditWriter`,
   `TypeOrmAuditReader`, `TypeOrmAuditRetention` a partir de
   `src/native/persistence-typeorm/index.ts`. Os testes importam diretamente de
   `persistence-typeorm/audit`.
3. Decidir se `readAuditTrail`, `AuditReader`, `AUDIT_READ_PERMISSION`,
   `createAuditRetentionPolicy` e `AuditValidationError` entram em
   `contracts/index.ts`. São funções e tipos puros.
4. Atualizar `docs/core-contracts.md` (seção 5.3) com `AuditReader` e a permissão.

## Não coberto

- Rota HTTP de leitura e a política de quem recebe `audit:read` em produção.
- Permissões de banco por papel e auditoria da própria auditoria.
- Job periódico de purga (o host decide frequência e agendamento).
- Carga e volumetria: nenhum percentil de latência de escrita foi medido.
- Coleta de auditoria por fila ou outbox. Escrita é síncrona na transação do negócio.
