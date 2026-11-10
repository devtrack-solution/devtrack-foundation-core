# Sessões compartilhadas, revogação e renovação (`core/application/security`, `native/persistence-typeorm/sessions`)

Implementa a política D2 do change `define-native-foundation-operational-core` (tarefa 3.4): sessão compartilhada entre réplicas, revogação imediata, renovação atômica de refresh token e falha fechada quando o armazenamento não responde.

## Modelo

- **Access token**: opaco, emitido pelo adapter de tokens (`AccessTokenIssuer`). Expira em até 10 min (padrão do adapter). Nunca pode expirar depois da sessão.
- **Refresh token**: opaco, 256 bits aleatórios (`RefreshTokenSecrets.generate`). O banco guarda somente o digest SHA-256. Nunca é JWT.
- **Sessão = família**: todo refresh pertence a uma sessão. Revogar a sessão revoga toda a família.
- **Prazos**: ociosidade do refresh padrão 7 dias (`idleTtlMs`); expiração absoluta igual à da sessão, padrão 30 dias, fixada na criação. Renovar atualiza só a ociosidade, limitada pela absoluta (`min(agora + idle, absoluta)`).

## Rotação (`AuthenticationService.refresh`)

Operação única no store (`RefreshTokenStore.rotate`), sob lock da sessão. A decisão é função pura (`refresh-rotation.policy.ts`):

| Situação                                                                                                      | Resultado                          | Efeito                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Refresh `active`, dentro do prazo, mesmo binding                                                              | rotação                            | CAS `active -> consumed` com linha afetada = 1 e exatamente um sucessor ativo |
| Refresh `consumed` dentro da janela de graça, mesmo binding, sucessor ainda `active`                          | `refresh_conflict` (409)           | nenhum sucessor, sessão ativa                                                 |
| Refresh `consumed` fora da janela, outro binding, ou sucessor já usado                                        | `invalid_credentials` (401)        | revoga a sessão e todos os refresh                                            |
| Sessão inativa/absolutamente expirada, refresh ocioso expirado, binding divergente em refresh ativo, revogado | `invalid_credentials`              | sem efeito de estado                                                          |
| Store indisponível ou erro inesperado                                                                         | `authentication_unavailable` (503) | nunca aceita sessão                                                           |

Janela de graça padrão 10 s, configurável de 0 a 30 s; com 0 nenhum retry é aceito e qualquer reapresentação é reuso.

Após a rotação, o serviço busca o principal atual (`IdentityAccessResolver.bySubject`) e emite o novo access token. Se o principal foi bloqueado ou a emissão falha, a sessão é revogada e nenhum token é devolvido.

## Revogação (`AuthenticationService.revokeSession`)

Revoga a sessão (`AuthenticationSessions.revoke`, idempotente) e depois a família de refresh. Com ator confiável (`{ subjectId, correlationId }`) grava entrada de auditoria `session.revoked`. A ordem garante que, mesmo se a segunda escrita falhar, nenhum refresh funciona: a rotação exige sessão `active`.

## Auditoria (opcional)

Quando `audit` é composto, são gravadas entradas via `AuditWriter` com `AuditContext` mínimo (`createAuditContext`):

- `session.refresh_rotated` (succeeded), `session.refresh_conflict` (denied), `session.refresh_reuse_revoked` (denied), `session.revoked` (succeeded).

Falha do writer falha fechado: nenhum token é devolvido. O worker de auditoria durável define o destino; esta feature usa apenas a porta.

## Consistência entre réplicas

- Estado decisivo (sessão, refresh) vive no PostgreSQL compartilhado. `TypeOrmSessionReader.find` consulta a cada chamada; não há cache positivo.
- **Janela de consistência contratada: 0.** Uma revogação confirmada em uma réplica é vista por outra na leitura seguinte.
- Serialização: a rotação e a revogação tomam `SELECT ... FOR UPDATE` na linha da sessão antes de ler ou alterar refresh tokens. Isso impede dois sucessores para a mesma família, mesmo com várias réplicas.

## Custo

- Cada requisição protegida: 1 consulta por leitura de sessão (`auth_sessions` por chave primária), além da verificação do token.
- Cada renovação: 1 transação com `SELECT` da sessão (lock), `SELECT` do refresh (lock) com subconsulta do sucessor, `UPDATE` do CAS e `INSERT` do sucessor. Em reuso: `UPDATE` da sessão e da família.
- Login com refresh: `INSERT` da sessão, `INSERT` do refresh, `UPDATE` de ativação.

## Modos de falha

| Falha                                    | Comportamento                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| PostgreSQL parado ou conexões derrubadas | refresh, leitura de sessão e login falham com `authentication_unavailable`; nenhum token é emitido |
| Falha após criar sessão pendente         | a sessão é revogada (se o ID não for vazio) e o login é negado                                     |
| Falha após rotação, antes do token       | a sessão é revogada; o cliente reautentica                                                         |
| Exceção de provedor                      | redigida; o erro público é `authentication_unavailable`                                            |
| Reuso detectado                          | família revogada, evento auditado, `invalid_credentials`                                           |

## Configuração

`AuthenticationDependencies.refresh`: `store`, `secrets`, `idleTtlMs` (padrão 7 dias), `graceWindowMs` (padrão 10 s, 0 a 30 s). Sem `refresh`, login e demais operações mantêm o contrato anterior e `refresh` responde `authentication_unavailable`.

`AuthenticationDependencies.audit`: `writer` e `newEntryId`.

Login com refresh exige `clientBinding` (`loginWithPassword(credentials, { clientBinding })`); federação já o recebe no callback.

## Persistência (`native/persistence-typeorm/sessions`)

- Tabelas `auth_sessions` (id, subject_id, tenant_id, state, method, created_at, expires_at, revoked_at) e `auth_refresh_tokens` (digest único, session_id, state, successor_digest, consumed_at, client_binding_digest, idle_expires_at). Ambas em milissegundos Unix. Constraints `CHECK` garantem estados válidos e `consumed` com sucessor.
- Migration `CreateAuthSessions1794345600000`. Contribuição `SESSIONS_PERSISTENCE` com `moduleId: 'foundation/sessions'`.
- Implementações: `TypeOrmAuthenticationSessions`, `TypeOrmSessionReader`, `TypeOrmRefreshTokenStore`, `NODE_REFRESH_TOKEN_SECRETS`.

## Composição no host

Peças e onde cada uma entra:

1. **Persistência.** `SESSIONS_PERSISTENCE` já está em `PERSISTENCE_CONTRIBUTIONS` (`native/persistence-typeorm/persistence-contributions.ts`), então as tabelas são criadas pela mesma migration da lista. Nada a acrescentar.
2. **Adapters**, sobre o `DataSource` de `PERSISTENCE_DATA_SOURCE`:
   - `AuthenticationSessions` = `new TypeOrmAuthenticationSessions({ dataSource, clock, absoluteTtlMs })`;
   - `SessionReader` = `new TypeOrmSessionReader(dataSource)`;
   - `RefreshTokenStore` = `new TypeOrmRefreshTokenStore(dataSource)`;
   - `RefreshTokenSecrets` = `NODE_REFRESH_TOKEN_SECRETS`.
3. **Login e renovação.** `FoundationCoreModule.withAuthentication` monta `AUTHENTICATION_SERVICE` com as portas nomeadas `identities`, `sessions` (`AuthenticationSessions`), `tokens`, `clock` e, opcionalmente, `password` e `federation`. A renovação e a auditoria são opcionais e também entram por tokens nomeados:

   ```ts
   FoundationCoreModule.withAuthentication({
     imports: [SessionsAdaptersModule], // provê os tokens abaixo
     ports: {
       identities: IDENTITIES,
       sessions: SESSIONS,            // TypeOrmAuthenticationSessions
       tokens: TOKENS,
       clock: CLOCK,
       password: PASSWORD,
       refresh: {
         store: REFRESH_STORE,        // TypeOrmRefreshTokenStore
         secrets: REFRESH_SECRETS,    // NODE_REFRESH_TOKEN_SECRETS
         idleTtlMs: 7 * 24 * 60 * 60_000,  // opcional; padrão 7 dias
         graceWindowMs: 10_000,            // opcional; padrão 10 s, faixa 0 a 30 s
       },
       audit: { writer: AUDIT_WRITER, newEntryId: AUDIT_ENTRY_ID }, // opcional
     },
   });
   ```

   Na inicialização, a Foundation confere o shape: `RefreshTokenStore` precisa de `issue`, `rotate` e `revokeFamily`; `RefreshTokenSecrets`, de `generate` e `digest`; `AuditWriter`, de `append`; e `newEntryId` precisa ser função. Faixas inválidas (janela fora de 0 a 30 s, ociosidade não positiva) falham antes de o Nest iniciar. Sem `refresh`, `refresh` responde `authentication_unavailable`. Sem `audit`, nenhuma entrada de sessão é gravada. Os dois campos são independentes e podem ser omitidos separadamente.
4. **Guard e sessão por requisição.** `FoundationCoreModule.withHttpSecurity` recebe `sessions` com o `SessionReader` (`TypeOrmSessionReader`), que é a leitura autoritativa por requisição.
5. **Resposta HTTP.** `HttpErrorFilter` já traduz `refresh_conflict` para 409 com corpo `{ statusCode, error: 'refresh_conflict', correlationId }`. As rotas de renovação e revogação não existem: o host ou um módulo de negócio as cria chamando `AuthenticationService.refresh` e `revokeSession`.

## Testes

- Unitários (`refresh.service.spec.ts`, store em memória com a mesma semântica): rotação, conflito na janela, reuso com outro binding e após uso do sucessor, reuso após a janela, janela 0, expiração ociosa e absoluta, falhas de storage, revogação de família, auditoria, política inválida.
- Integração PostgreSQL 16 (`test/sessions-postgres.e2e-spec.ts`, Testcontainers): revogação entre réplicas, 20 rodadas de renovação concorrente entre duas réplicas (exatamente um sucessor e um `refresh_conflict` por rodada, verificado por SQL), reuso entre réplicas, e banco parado.

## Não coberto nesta entrega

- Endpoint de refresh e de revogação na camada de apresentação.
- `refresh_conflict` → 409 já está em `HttpErrorFilter`, e `contracts/index.ts` já exporta a política de rotação (`decideRotation`).
- Limpeza periódica de refresh expirados.
- Destino durável da auditoria (outro worker).
