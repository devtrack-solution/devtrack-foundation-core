# Idempotência com intenção (tarefas 4.1 e 4.2)

Contrato de idempotência de operações HTTP e de casos de uso. A 4.1 cobre estado, chave contextual, fingerprint, serviço, stores, interceptor HTTP. A 4.2 cobre reivindicação com lease e fencing, execução com `UnitOfWork` (negócio, resultado e auditoria no mesmo commit), recuperação e reconciliação de efeito externo incerto. Ver [Reivindicação, lease e fencing (4.2)](#reivindicação-lease-e-fencing-42) e [Garantias e limites](#garantias-e-limites).

## Ordem de execução

`IdempotencyService.execute(context, operation, clientKey, payload, run)` segue a ordem do design (seção 5):

1. Valida a chave do cliente. Ausente gera `idempotency_key_required`; inválida gera `idempotency_key_invalid`.
2. Revalida a autorização atual com `operation.authorize(context)`. Roda em toda chamada, inclusive em replay, antes de qualquer resultado ser devolvido.
3. Calcula o fingerprint do conteúdo semântico e a chave contextual.
4. Reivindica a intenção no store (`begin`), com lease de `leaseMs` (padrão 30 s).
5. Se a intenção já existe e não é reivindicável, responde pelo estado (sem executar `run`). Se foi reivindicada agora, executa `run` e registra o resultado (`complete`) ou a falha (`fail`), sempre com o token e a versão da reivindicação.

Autenticação e validação de entrada ocorrem antes da chamada, como no restante da Foundation. Nenhum resultado persistido é devolvido sem `authorize` ter passado.

## Chave contextual e fingerprint

- **Chave contextual:** SHA-256 de JSON canônico de `{ tenantId, subjectId, operationId, clientKey }`. A mesma chave do cliente em outro tenant, outro subject ou outra operação gera outra intenção.
- **Chave do cliente:** string de 1 a 128 caracteres de `A-Z a-z 0-9 . _ : -`.
- **Fingerprint:** SHA-256 do JSON canônico do conteúdo semântico. Chaves de objeto são ordenadas lexicalmente. Propriedades `undefined` em objetos são omitidas. `undefined` em arrays, `NaN`, `Infinity`, `Date`, instâncias não planas, funções e ciclos lançam `idempotency_content_invalid`.
- **Normalização por operação:** a política pode declarar `semanticContent(payload)`. Sem ela, o payload inteiro entra no fingerprint.

Application não importa `node:crypto`. O hash e os tokens chegam pela porta `IdempotencyCrypto`. A implementação Node fica em `src/core/presentation/http/idempotency/node-idempotency-crypto.ts`.

## Estados e regras

| Situação ao chegar uma chamada com a mesma chave contextual | Resposta |
| --- | --- |
| Registro `completed`, dentro da retenção, mesmo fingerprint | Resultado persistido, `replayed: true`, `run` não chamado |
| Mesma chave, fingerprint diferente (em qualquer estado, exceto `failed_retryable`) | `idempotency_conflict`, `run` não chamado |
| `in_progress` com lease vigente | `idempotency_in_progress` |
| `in_progress` com lease vencido e mesmo fingerprint (ou retenção vencida) | Recuperação: nova reivindicação, `run` chamado (ver 4.2) |
| `failed_terminal` | `idempotency_failed_terminal` (falha reapresentada, `run` não chamado) |
| `outcome_unknown` | `idempotency_outcome_unknown` (efeito possivelmente feito; não é reexecutado sem reconciliação) |
| `failed_retryable` | Nova tentativa com a mesma chave; qualquer fingerprint |
| Registro vencido (retenção expirada) | Nova intenção, `run` chamado |

Falhas do `run` são classificadas:

- `IdempotentRetryableFailure`, ou 4xx no HTTP: `failed_retryable`.
- `IdempotentTerminalFailure`: `failed_terminal`.
- Qualquer outro erro: `outcome_unknown`. O erro original é relançado.

Se `run` terminar e o resultado não for JSON canônico, o registro vai para `outcome_unknown` e a chamada falha com `idempotency_result_invalid`.

## Política

```ts
const policy: IdempotentOperationPolicy<Payload> = {
  operationId: 'contacts.create',          // minúsculas, dígitos, . _ -; até 64
  retentionMs: 24 * 60 * 60 * 1000,        // 1 s a 30 dias
  semanticContent: (payload) => payload,   // opcional; JSON puro
  classifyFailure: (error) => 'unknown',   // opcional
};
```

A retenção é contada a partir da reivindicação. Após vencer, a chave volta a ser uma intenção nova.

## Store

`IdempotencyStore` é a porta de armazenamento compartilhado:

- `begin`: reivindicação atômica (regra `isClaimable`, abaixo). Não sobrescreve registros vigentes.
- `heartbeat`, `complete` e `fail`: exigem token **e** versão iguais ao registro e estado `in_progress`. `complete` e `fail` exigem também lease vigente no instante informado. Caso contrário lançam `IdempotencyStaleClaimError` (código `idempotency_claim_lost`).
- `resolveOutcomeUnknown`: altera só `outcome_unknown` com a versão lida.
- `find` e `purgeExpired({ now, limit })`: `limit` entre 1 e 1000. `purgeExpired` nunca remove `in_progress`.

Implementações:

- `InMemoryIdempotencyStore` (`src/core/application/idempotency/`): um processo, para testes e composições sem banco.
- `TypeOrmIdempotencyStore` (`src/native/persistence-typeorm/idempotency/`): PostgreSQL. A reivindicação é um `INSERT ... ON CONFLICT (idempotency_key) DO UPDATE ... WHERE` que vence apenas quando a linha está vencida ou em `failed_retryable`. Quem perde recebe o registro existente. `complete` e `fail` verificam o token no próprio `UPDATE`.

Esquema (`idempotency_records`, migrations `CreateIdempotencyRecords1794259200000` e `AddIdempotencyLease1794432000000`): chave com `UNIQUE`, `operation_id`, `subject_id`, `tenant_id`, `fingerprint`, `state` com `CHECK`, `claim_token`, `result` (jsonb), `failure_class`, `lease_expires_at_ms` (nulo fora de `in_progress`, obrigatório dentro), instantes em epoch ms (`created_at_ms`, `updated_at_ms`, `expires_at_ms`) e `version`. O índice em `expires_at_ms` atende o purge.

Regra de reivindicabilidade (`core/application/idempotency/idempotency.claim-rules.ts`, espelhada na cláusula `WHERE` do upsert):

- `failed_retryable`: reivindicável com qualquer fingerprint.
- `in_progress`: reivindicável somente com lease vencido e, cumulativamente, mesmo fingerprint (recuperação do mesmo intento) ou retenção vencida (novo intento). Lease vigente nunca é tomado.
- `completed`, `failed_terminal` e `outcome_unknown`: reivindicáveis só após a retenção vencer.

Contribuição para o catálogo: `IDEMPOTENCY_PERSISTENCE` (`moduleId: 'foundation/idempotency'`). O host a inclui em `PERSISTENCE_CONTRIBUTIONS`, para runtime e CLI.

`purgeExpired` remove registros vencidos em lote limitado, nos estados `completed`, `failed_*` e `outcome_unknown`. Registro `in_progress` nunca é purgado, mesmo vencido: apagá-lo permitiria uma segunda execução de um executor vivo.

## Interceptor HTTP

```ts
@Post('contacts')
@UseGuards(AuthenticationGuard)
@RequirePermissions('contacts:write')
@Idempotent({ operationId: 'contacts.create', retentionMs: 86_400_000 })
create(@Body() body: CreateContactBody) { /* ... */ }
```

- `Idempotency-Key` é obrigatório. Ausente ou inválido responde 400 (`idempotency_key_required`, `idempotency_key_invalid`).
- Sem contexto autenticado do guard, a requisição é negada com 401.
- Conflito responde 409 `idempotency_conflict`. Em andamento responde 409 `idempotency_in_progress` com `Retry-After: 1`. Desfecho desconhecido responde 409 `idempotency_outcome_unknown`. Falha terminal responde 409 `idempotency_failed_terminal`. Erros internos do contrato respondem 500 `internal_error`. O corpo é `{ statusCode, error, correlationId }`.
- Replay devolve o status e o corpo persistidos com o header `Idempotent-Replayed: true`, sem chamar o handler.
- Em replay, a autorização é revalidada: o principal precisa existir, pertencer ao mesmo tenant e manter as permissões de `@RequirePermissions`. Caso contrário responde 401 ou 403, sem devolver o resultado.
- O status persistido é o declarado pela rota (`@HttpCode` ou o padrão do Nest: 201 para POST, 200 nos demais). Não use `@Res` em rotas idempotentes.
- Um 4xx lançado pelo handler, inclusive por pipe de validação, não tem efeito e pode ser reenviado com a mesma chave após correção.

## Integração para o host

O host precisa registrar:

1. `IDEMPOTENCY_PERSISTENCE` em `PERSISTENCE_CONTRIBUTIONS` (runtime e CLI usam a mesma lista).
2. `IDEMPOTENCY_STORE` com `new TypeOrmIdempotencyStore(dataSource)`, usando `PERSISTENCE_DATA_SOURCE`. Para testes, `InMemoryIdempotencyStore`.
3. `IDEMPOTENCY_CRYPTO` com `NODE_IDEMPOTENCY_CRYPTO`.
4. `IDEMPOTENCY_SERVICE` com `new IdempotencyService({ store, crypto, clock })`. O `clock` é o `Clock` já registrado no `FoundationCoreModule`.
5. `IDEMPOTENCY_IDENTITY_RESOLVER` apontando para o mesmo provider de `IdentityAccessResolver` do registro de segurança.
6. Os providers `IdempotencyInterceptor` e `IdempotencyExceptionFilter` disponíveis no módulo das rotas (o decorator os aplica por método).
7. O `OperationContextInterceptor` ativo (`FoundationCoreModule.withHttpSecurity`), para que o contexto esteja no request antes do interceptor.

Não há barrel de Application: os módulos são importados pelos caminhos dos arquivos. A exportação em `foundation-api/contracts` e `foundation-api/nest` fica para o integrador.

- Application: `IdempotencyService`, `IDEMPOTENCY_SERVICE`, `IDEMPOTENCY_STORE`, `IDEMPOTENCY_CRYPTO`, `IDEMPOTENCY_LIMITS`, `InMemoryIdempotencyStore`, `canonicalJson`, `contextualKeyOf`, `fingerprintOf`, `validateClientKey`, erros `Idempotency*Error`, `IdempotentRetryableFailure`, `IdempotentTerminalFailure`, tipos em `idempotency.types.ts`.
- Native: `IDEMPOTENCY_PERSISTENCE`, `TypeOrmIdempotencyStore`, `IdempotencyRecordOrmEntity`, `CreateIdempotencyRecords1794259200000`, `IDEMPOTENCY_RECORDS_TABLE`.
- Presentation: `Idempotent`, `IdempotencyInterceptor`, `IdempotencyExceptionFilter`, `NODE_IDEMPOTENCY_CRYPTO`, `IDEMPOTENCY_IDENTITY_RESOLVER`, `IDEMPOTENCY_KEY_HEADER`, `IDEMPOTENT_REPLAYED_HEADER`.

## Reivindicação, lease e fencing (4.2)

- **Lease.** `begin` grava `lease_expires_at_ms = now + leaseMs`. `leaseMs` vai no construtor do serviço (padrão 30 s; faixa 1 s a 10 min).
- **Heartbeat.** Em `execute`, `run` recebe `lease.renew()`. A renovação atualiza só o lease e exige token e versão iguais ao registro; não altera a versão. Após re-reivindicação por outro executor, lança `IdempotencyStaleClaimError`.
- **Fencing.** A versão é o fencing token: muda a cada reivindicação e a cada transição. `complete` e `fail` executam `UPDATE ... WHERE claim_token = :t AND version = :v AND state = 'in_progress' AND lease_expires_at_ms > :now` e exigem uma linha afetada. Lease expirado sem sucessor também recusa o commit: executor com lease vencido não confirma nada.
- **Executor obsoleto.** Expirar lease não prova morte. Se outro executor reivindicou, o `complete` do executor antigo afeta zero linhas, lança `IdempotencyStaleClaimError` e a transação do negócio dele é desfeita.

### UnitOfWork: negócio, resultado e auditoria no mesmo commit

`IdempotencyService.executeInUnitOfWork(context, operation, clientKey, payload, { unitOfWork, auditOf }, run)`:

1. Mesmos passos 1 a 5 da execução simples: chave, `authorize`, fingerprint, `begin` com lease. A reivindicação é um commit separado, feito antes da transação de negócio.
2. Dentro de `unitOfWork.run`, recebendo os recursos da transação:
   - `run(context, payload, resources)` executa a escrita de negócio pelos recursos recebidos;
   - o resultado é validado como JSON canônico (se não for, a transação é desfeita e a falha é gravada como `failed_terminal`);
   - `resources.audit.append(...)` grava a auditoria obrigatória com `outcome: 'succeeded'`, montada com `auditOf(result)` (`action` e `target`) e o contexto de auditoria do principal;
   - `resources.idempotency.complete(...)` faz o compare-and-set de fencing da seção anterior.
3. Se qualquer passo falhar, o UnitOfWork desfaz tudo: negócio, auditoria e conclusão. Depois disso:
   - falha `retryable` ou `terminal` (por `IdempotentRetryableFailure`, `IdempotentTerminalFailure` ou `classifyFailure`) grava o estado correspondente, fora da transação;
   - falha `unknown` (inclusive `IdempotencyStaleClaimError`) deixa o registro `in_progress`. Como a transação foi desfeita, nada persistiu; o registro fica recuperável após o lease, ou fica com o executor vigente.
4. Replay devolve o resultado persistido e não audita de novo. Auditoria existe exatamente uma vez por intento confirmado.

O `resources.idempotency` deve ser um `TypeOrmIdempotencyStore` construído sobre o `EntityManager` da transação (`new TypeOrmIdempotencyStore(manager)`). Exemplo de composição do host:

```ts
const unitOfWork = new TypeOrmUnitOfWork(dataSource, (manager) => ({
  idempotency: new TypeOrmIdempotencyStore(manager),
  audit: new TypeOrmAuditWriter(manager),
  contacts: contactsWriterFor(manager),
}));
```

**Sem chamadas de rede dentro da transação.** `run` e o `UnitOfWork` não devem chamar APIs externas, filas, HTTP ou outros sistemas: a transação fica aberta durante o trabalho. Efeito externo fica fora do UnitOfWork, no modo simples de `execute`.

### Efeito externo e reconciliação

Em `execute`, falha não classificada depois de chamada externa grava `outcome_unknown`. O registro nunca é reexecutado automaticamente: replays recebem `idempotency_outcome_unknown` (409) e `run` não é chamado.

Para resolver, o host pode fornecer um `ExternalOutcomeReconciler` (porta opcional, símbolo `IDEMPOTENCY_RECONCILER`). `service.reconcileOutcomeUnknown(key, reconciler)` consulta o provedor ou o receptor pela chave suportada e aplica o desfecho:

| Decisão do reconciliador | Efeito no registro | Retorno |
| --- | --- | --- |
| `{ outcome: 'confirmed', result }` | `completed` com o resultado, sem reexecução | `completed` |
| `{ outcome: 'not_performed' }` | `failed_retryable`; nova tentativa com a mesma chave é permitida | `failed_retryable` |
| `{ outcome: 'unresolved' }` | Sem mudança | `unresolved` |

Sem reconciliador, `outcome_unknown` permanece até decisão humana ou de outro processo.

### Recuperação

- Executor que caiu no meio do `run` deixa `in_progress`. Após o lease, qualquer réplica com o mesmo intento o recupera (mesmo fingerprint).
- Na transação, queda antes do commit desfaz o negócio. Queda depois do commit deixa resultado e auditoria confirmados: o replay devolve o resultado persistido.
- Dois DataSources sobre o mesmo PostgreSQL funcionam como réplicas. As garantias não dependem de um lock em memória.

## Garantias e limites

Garantias verificadas por testes com PostgreSQL 16 real:

- Uma execução interna confirmada por intento, mesmo com duas réplicas concorrentes.
- Crash antes do commit: nenhum efeito de negócio persiste; a sucessora conclui uma vez.
- Crash depois do commit: replay devolve o resultado persistido, sem nova escrita, com uma auditoria.
- Executor obsoleto: não confirma; a sucessora conclui.
- Efeito externo incerto: não é reexecutado automaticamente.

Limites:

- **Efeito externo não é exatamente uma vez.** A Foundation garante a intenção e o registro do desfecho. Para efeitos externos, a operação precisa de chave suportada pelo provedor, deduplicação do receptor ou reconciliação. Um executor que perde o lease pode ter enviado o efeito externo antes de cair.
- **Relógios.** Lease e retenção usam o `Clock` da aplicação. Skew entre réplicas não gera commit duplicado (o fencing por versão decide no banco), mas pode antecipar a recuperação de um executor vivo. Em efeitos externos, isso reabre a janela de duplicidade: mantenha NTP e chaves do provedor.
- **Transação de negócio longa.** A conclusão ocorre no fim da transação. Transação mais longa que o lease faz o executor perder a conclusão e desfazer o trabalho. Mantenha o `run` curto.
- **Auditoria** é gravada só para execução confirmada. Negações e falhas não geram entrada aqui.
- **Não coberto:** carga e volumetria, purga periódica do host, e validação em infraestrutura real com múltiplas instâncias.

## Testes

- Unitários (`src/core/application/idempotency/*.spec.ts`, `src/native/persistence-typeorm/idempotency/*.spec.ts`): forma canônica, validação de chave, chave contextual, fingerprint, replay sem nova execução, conflito, em andamento, revogação na reexecução, expiração com relógio injetado, falhas retryable, terminal e unknown, resultado não JSON, purge em lotes.
- Unitários da 4.2 (`src/core/application/idempotency/idempotency-recovery.spec.ts`): heartbeat com token e versão, renovação recusada após re-reivindicação, lease vencido sem sucessor, recuperação de `in_progress`, conflito com fingerprint diferente em lease vencido, reconciliação (`unresolved`, `confirmed`, `not_performed`), execução transacional com fake de UnitOfWork (auditoria única, falha retryable sem auditoria, resultado não JSON).
- Integração PostgreSQL 16 (`test/idempotency-postgres.e2e-spec.ts`): migration pelo catálogo, UNIQUE no banco, corrida de `begin`, replay e conflito entre duas réplicas, em andamento sob concorrência, desfecho desconhecido após reinício, expiração, purge em lote (sem remover `in_progress`), fencing de conclusão. Exige Docker.
- Integração PostgreSQL 16 de concorrência (`test/idempotency-concurrency.e2e-spec.ts`): 20 rodadas de duas réplicas com a mesma intenção (uma execução por rodada, auditoria única); crash antes do commit com `pg_terminate_backend` durante a transação; crash depois do commit; executor obsoleto com transação desfeita; heartbeat entre réplicas; efeito externo incerto confirmado por reconciliação. Exige Docker.
- HTTP e2e (`test/idempotency-http.e2e-spec.ts`): 201 e replay idêntico com header, corpo divergente com 409, chave ausente e inválida, sem autenticação com 401, isolamento entre subjects e tenants, revogação de permissão no replay com 403, status 202 persistido, reenvio após 400, desfecho desconhecido com 409, em andamento com 409 e `Retry-After`, validação de política na declaração.
