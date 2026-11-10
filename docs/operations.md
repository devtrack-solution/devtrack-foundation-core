# Operação da Foundation: instalação, configuração, migração, desativação, recuperação e rollback

Tarefa 7.4 da mudança `define-native-foundation-operational-core`.

Este guia reúne os procedimentos operacionais e aponta para os documentos técnicos existentes
em `docs/*.md`, sem repeti-los. Tudo aqui descreve o que existe no código hoje. Quando um passo
não foi executado no ensaio, o texto diz **não ensaiado**. O ensaio é reproduzível com
`scripts/rehearse-operations.sh` (seção 11).

Convenções: caminhos relativos são a partir de `foundation-api/`. `<artefato>` é o diretório de
saída de `npm run build:artifact`. Variáveis de ambiente são lidas pelo código real citado em cada seção.

## 1. Pré-requisitos

| Item | Requisito | Origem | Ensaio |
| --- | --- | --- | --- |
| Node.js | 24 (`api-cli` declara `engines.node >=24`; `foundation-api/package.json` não declara) | `api-cli/package.json` | v24.21.0 |
| npm | 11 (o build usa `--allow-scripts=` e `--ignore-scripts`, aceitos pelo npm 11) | `scripts/build-artifact.ts` | 11.19.0 |
| PostgreSQL | 16 (é a versão dos testes e2e) | `docs/persistence.md` | `postgres:16-alpine` |
| Docker | Necessário ao ensaio e aos testes com Testcontainers | `scripts/rehearse-operations.sh`, `docs/admission.md` | 29.8.0 |
| Redis | Só se o perfil selecionar `native/queue-bullmq` ou `native/cache-redis`. O worker exige `FOUNDATION_REDIS_HOST` | `docs/jobs.md`, `docs/admission.md` | não ensaiado |
| Registry npm | O `package-lock.json` da Foundation resolve pacotes em `https://registry.npmjs.org/`. O build e o `npm ci` do artefato precisam de acesso a esse endereço ou de um espelho que o lock aceite | `package-lock.json` | acesso ao registry público |
| Registry isolado para extensões | `api-cli install` só aceita registry na allowlist (`API_CLI_REGISTRY_ALLOWLIST`, padrão `http://localhost:4873`) e versão exata `x.y.z` | `api-cli/README.md` | não ensaiado (ver seção 3) |

## 2. Instalação

### 2.1 Foundation

```sh
cd foundation-api
npm ci
```

A instalação do host traz o pacote de desenvolvimento (ts-node, typescript, jest). Ele não entra no
artefato (seção 4).

### 2.2 Extensão npm via `api-cli`

O `api-cli` fica fora de `foundation-api/`. Ele opera sobre a Foundation com `--foundation <caminho>`
(padrão: `../foundation-api`).

```sh
cd api-cli
npm ci && npm run build
node dist/src/bin.js --foundation <caminho>/foundation-api \
  install <pacote>@<x.y.z> --registry <url-allowlisted>
```

O `install` faz, nesta ordem (`api-cli/README.md`):

1. recusa registry fora da allowlist e versão que não seja exata, antes de qualquer requisição;
2. baixa o tarball, confere o sha512 com `dist.integrity` do registry e lê `package.json` e o descriptor
   dentro do tarball, sem executar código do pacote;
3. valida peers contra as versões instaladas na Foundation, `foundationApiMajor: 1` do descriptor e
   ausência de dependências `file:`, `link:`, git ou URL;
4. instala com `--ignore-scripts`, confere `resolved` (`REGISTRY_MISMATCH`) e `integrity`
   (`INTEGRITY_MISMATCH`) no lock;
5. registra a extensão em `config/composition.yaml`, regera `src/composition/extension-sources.ts` e roda
   `npm run compose`.

Qualquer falha desfaz perfil, arquivo gerado, `package.json` e lock. `uninstall` recusa se a extensão
participa de `bindings`.

**Peer do host (automático):** extensões instaladas, como `@devtrack/jwt-auth`,
`@devtrack/swagger-adapter` e Contacts, importam `@devtrack/foundation-api` em runtime. No host, esse
pacote é o próprio projeto raiz, e o `api-cli` instala com `--legacy-peer-deps`, sem trazer o peer.
Por isso, depois de cada `npm install`/`npm uninstall` que executa, o `api-cli` sincroniza
`node_modules/<nome do host>` como symlink para a raiz, enquanto houver extensão selecionada que declara o
host como peer, e o remove quando a última sai. Ele nunca sobrescreve um diretório real ou um link para
outro destino nesse caminho: a operação falha com `HOST_LINK_CONFLICT` e é desfeita.

Um `npm ci` ou `npm install` feito à mão no checkout do host poda esse link (ele não está no lock).
O próximo `api-cli install` ou `uninstall` o recria. No artefato isso não acontece: ver a seção 4.

Ressalva: `src/composition/extension-sources.ts` está vazio neste repositório. O gerador só conhece
extensões que estão nesse registro, então o fluxo completo depende do `install` do `api-cli`
(**não ensaiado** nesta entrega; coberto pelos testes do `api-cli` com Verdaccio e por
`contacts/test/removal`).

### 2.3 Instalar, incluir no build e habilitar são coisas diferentes

| Conceito | Significado | Como muda |
| --- | --- | --- |
| Instalar | O pacote está em `node_modules` e no lock, com versão exata. Não entra em artefato por isso. | `api-cli install` / `uninstall` |
| Incluir no build | A capacidade está em `config/composition.yaml`, entra no artefato e tem código em `dist/`. | editar perfil ou `api-cli setting enable-native`, depois `npm run compose` e `build:artifact` |
| Habilitar em runtime | O módulo é carregado pelo processo em execução. Hoje não há flags de runtime: selecionado equivale a habilitado. | só por rebuild e redeploy |

Selecionar no perfil não ativa nada sem rebuild, e instalar não inclui nada no artefato.

## 3. Configuração

### 3.1 Perfil `config/composition.yaml`

Formato (`src/core/infrastructure/composition/composition-profile.ts`):

```yaml
foundationApiMajor: 1
natives:
  - id: native/persistence-typeorm
extensions: []        # id, packageName, version (exata), integrity (sha...), features
# bindings: []        # opcional: consumer, capability, provider
```

- O perfil não aceita campo com nome de segredo (`secret`, `password`, `token`, `apikey`,
  `credential`, `privatekey`, `keymaterial`). A validação falha com `PROFILE_SECRET_FIELD`.
  Credenciais e chaves vêm do host, nunca do perfil.
- Ids de nativo aceitos: `native/http-security`,
  `native/aws-s3`, `native/cache-redis`, `native/queue-bullmq`, `native/persistence-typeorm`,
  `native/opentelemetry` (`src/core/infrastructure/composition/native-sources.ts`). JWT Auth e Swagger são as
  extensões `ext/jwt-auth` e `ext/swagger-adapter` (pacotes `@devtrack/jwt-auth` e `@devtrack/swagger-adapter`),
  instaladas pelo `api-cli`. Perfis antigos com `native/jwt-auth` ou `native/swagger-adapter` falham com
  `PROFILE_UNKNOWN_NATIVE`: mova a entrada para `extensions` depois de
  instalar o pacote.
- Ids que começam com `native/` não podem ser extensões.

### 3.2 Gerador: `npm run compose`

```sh
npm run compose             # regenera src/composition/composition.generated.ts e instrumentation.generated.ts
npm run compose -- --check  # não escreve; falha se os arquivos gerados estiverem desatualizados
```

`npm run build` (Nest) roda `check:boundaries` e `compose --check` antes do build. Os arquivos gerados
não devem ser editados à mão.

### 3.3 Tokens de host para os nativos

O módulo gerado usa tokens que o **host** precisa fornecer. Ele não os provê sozinho. Os símbolos são
`Symbol.for('foundation.api.v1.host.<nome>')` (`composition-generator.ts`).

| Token (`COMPOSITION_HOST_TOKENS.`) | Símbolo | Nativo que exige |
| --- | --- | --- |
| `jwtAuthOptions` | `jwt-auth.options` | extensão `ext/jwt-auth` (declarado no bloco `composition` do descriptor) |
| `swaggerOptions` | `swagger.options` | extensão `ext/swagger-adapter` (título, versão e caminho; sem eles o boot falha) |
| `awsS3Options` | `aws-s3.options` | `native/aws-s3` |
| `cacheRedisOptions` | `cache-redis.options` | `native/cache-redis` |
| `persistenceOptions` | `persistence.options` | `native/persistence-typeorm` (configuração de `FOUNDATION_DB_*`, seção 3.4) |
| `queueBullmqOptions` | `queue-bullmq.options` | `native/queue-bullmq` |
| `jobIdentityResolver` | `job-identity-resolver` | `native/queue-bullmq` (`IdentityAccessResolver` do host; sem ele o worker não sobe) |
| `sessions`, `identities`, `clock` | `sessions`, `identities`, `clock` | `native/http-security` com `withHttpSecurity` |

O host fornece cada token em um módulo `@Global`, porque o módulo gerado só importa os dynamic modules
e não provê os tokens (`test/composition-native.e2e-spec.ts`). `contacts/test/removal/README.md` registra
o mesmo ponto como limitação: sem `persistence.options`, o boot do artefato falha.

O ensaio (seção 11) fornece `persistence.options` com um `@Global` mínimo na cópia descartável.

### 3.4 Variáveis de ambiente

**API (`src/main.ts`)**

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP. |

**Persistência (`persistenceConfigFromEnv`, `src/native/persistence-typeorm/persistence-config.ts`)**

| Variável | Padrão | Observação |
| --- | --- | --- |
| `FOUNDATION_DB_HOST` | obrigatório | |
| `FOUNDATION_DB_PORT` | `5432` | inteiro 1–65535 |
| `FOUNDATION_DB_NAME` | obrigatório | |
| `FOUNDATION_DB_USER` | obrigatório | |
| `FOUNDATION_DB_PASSWORD` | ausente vira string vazia; a validação exige apenas que seja string | nunca aparece em mensagem de erro |
| `FOUNDATION_DB_APPLICATION_NAME` | obrigatório | 1–63 caracteres: letras, dígitos, `_`, `.`, `-` |
| `FOUNDATION_DB_POOL_MAX` | `10` | 1–100 (`PERSISTENCE_INVALID_POOL_SIZE`) |
| `FOUNDATION_DB_CONNECT_TIMEOUT_MS` | `5000` | 1–60000 |
| `FOUNDATION_DB_STATEMENT_TIMEOUT_MS` | `30000` | 1–600000 |
| `FOUNDATION_DB_SSL` | `false` | `true` ou `false` |
| `FOUNDATION_DB_MIGRATIONS_RUN` | `false` | `true` aplica migrations pendentes no boot (opt-in, seção 5) |
| `FOUNDATION_DB_SYNCHRONIZE` | ausente | Só `false` é aceito. Qualquer outro valor lança `PERSISTENCE_SYNCHRONIZE_FORBIDDEN` |

**Worker (`src/worker.ts`, `queueBullmqOptionsFromEnv`)**

| Variável | Padrão |
| --- | --- |
| `FOUNDATION_REDIS_HOST` | obrigatório |
| `FOUNDATION_REDIS_PORT` | `6379` |
| `FOUNDATION_REDIS_PASSWORD`, `FOUNDATION_REDIS_DB` | opcionais |
| `FOUNDATION_JOBS_QUEUE` | `foundation-jobs` |
| `FOUNDATION_JOBS_MAX_PAYLOAD_BYTES` | `65536` |
| `FOUNDATION_JOBS_MAX_ATTEMPTS` | `5` |
| `FOUNDATION_JOBS_BACKOFF_BASE_MS` / `_MAX_MS` | `1000` / `60000` |
| `FOUNDATION_JOBS_TIMEOUT_MS` | `30000` |
| `FOUNDATION_WORKER_CONCURRENCY` | `4` |
| `FOUNDATION_WORKER_LOCK_MS` | `30000` |
| `FOUNDATION_WORKER_STALLED_INTERVAL_MS` | `30000` |
| `FOUNDATION_WORKER_MAX_STALLED` | `3` |
| `FOUNDATION_WORKER_DRAIN_DEADLINE_MS` | `30000` |

Valores inválidos impedem o boot, e a mensagem cita só o nome do campo (`docs/jobs.md`).

**Telemetria (`native/opentelemetry`)**: as variáveis `FOUNDATION_OTEL_*`, `FOUNDATION_SERVICE_NAME`,
`FOUNDATION_SERVICE_VERSION` e `FOUNDATION_DEPLOYMENT_ENVIRONMENT` estão em `docs/core-contracts.md`
(seção 8). Não foram ensaiadas.

## 4. Build seletivo (`npm run build:artifact`)

```sh
npm run build:artifact -- --profile <abs>/perfil.yaml --out <abs>/artefato [--workdir <abs>/vazio]
npm run build:artifact -- --verify <artefato>     # confere inventário contra lock e dist
npm run test:artifact                             # testes do build (instala pacotes; lento)
```

- `--profile` e `--out` devem ser caminhos absolutos quando chamados pelo `api-cli`.
- `--workdir`, se usado, precisa estar vazio ou não existir. Sem ele, o build usa diretório temporário
  e o remove ao final.
- O artefato contém `dist/`, `package.json`, `package-lock.json` e `artifact-inventory.json`. Não contém
  `node_modules`. Instale com o lock gerado:

  ```sh
  cd <artefato> && npm ci --omit=dev --ignore-scripts --allow-scripts=
  # o .npmrc do artefato (legacy-peer-deps=true) precisa ir junto: sem ele, o npm ci tenta baixar
  # @devtrack/foundation-api como peer das extensões instaladas
  node dist/main.js
  ```

  Não há passo depois do `npm ci`. Quando alguma extensão declara o host como peer, o `package.json` do
  artefato traz `"@devtrack/foundation-api": "file:."` e o mapa `exports` do host. O lock registra essa
  entrada como link para a raiz (`resolved: ""`), e o próprio `npm ci` recria
  `node_modules/@devtrack/foundation-api -> ../..`, sem script e sem rede. As extensões resolvem
  `@devtrack/foundation-api/nest`, `/contracts` e `/native/*` para o `dist/` do artefato, a mesma instância
  carregada por `dist/main.js`. A verificação aceita no lock só esse link para a raiz. Qualquer outro link
  reprova. O link não entra em `packages` do inventário porque não é pacote baixado e não tem `integrity`.

- Só são copiados `src/core`, `src/contracts`, `src/composition`, os quatro arquivos de bootstrap
  (`main.ts`, `app.module.ts`, `app.controller.ts`, `app.service.ts`), `src/worker.ts` (só com
  `native/queue-bullmq`), `src/native/<id>` dos nativos selecionados, `tsconfig*.json` e o perfil.
  Specs e testes não entram.
- Pacotes de tooling (`prettier`, `ts-node`, `typescript`) nunca vão ao artefato.
- `artifact-inventory.json` (sem timestamp; dois builds iguais dão o mesmo arquivo) traz perfil com sha256,
  Node, módulos `selected`, `excludedFromBuild`, `disabledAtRuntime`, `excludedPackages` e pacotes com
  versão e `integrity`. Detalhes em `docs/selective-build.md`.

Ensaio: o perfil com `native/persistence-typeorm` gerou artefato com 135 pacotes de runtime e
inventário listando o nativo. `dist/` continha `main.js` e `native/persistence-typeorm/data-source.cli.js`.

**Worker**: com `native/queue-bullmq` selecionado, o artefato traz `src/worker.ts` compilado em `dist/worker.js`
e o inventário lista `entrypoints: ["main", "worker"]`. Sem a fila, `dist/worker.js` não existe e `entrypoints`
é `["main"]`. A verificação reprova `dist/worker.js` sem a fila e entrypoint `worker` sem o arquivo.
Como subir o worker a partir do artefato está na seção 6.2.

## 5. Migração

### 5.1 Catálogo

As entidades e migrations vêm de `PERSISTENCE_CONTRIBUTIONS`
(`src/native/persistence-typeorm/persistence-contributions.ts`). Histórico em `migrations`
(`PERSISTENCE_MIGRATIONS_TABLE`). Os nomes terminam em timestamp de 13 dígitos.

| Migration (ordem de execução) | Tabela(s) | `down` real? |
| --- | --- | --- |
| `CreateIdempotencyRecords1794259200000` | `idempotency_records` | sim: `DROP TABLE` |
| `CreateActivities1794345600000` | `activities` | sim: `DROP TABLE` |
| `CreateAuditEntries1794345600000` | `audit_entries` (+ trigger `TRG_audit_entries_append_only` e função `audit_entries_append_only`) | sim: remove trigger, função e tabela. **Apaga a auditoria.** |
| `CreateAuthSessions1794345600000` | `auth_sessions`, `auth_refresh_tokens` | sim: `DROP TABLE` das duas |
| `AddIdempotencyLease1794432000000` | coluna `lease_expires_at_ms` em `idempotency_records` | sim: remove constraint e coluna |
| `CreateOutboxMessages1794604800000` | `outbox_messages` | sim: `DROP TABLE` |
| `CreateInboxMessages1794691200000` | `inbox_messages` | sim: `DROP TABLE` |

Todos os `down` existem e executam DDL real. Nenhum é "vazio". Isso não quer dizer que o rollback
preserve dados: os `down` apagam as tabelas com as linhas.

### 5.2 Como rodar (CLI, recomendado)

```sh
cd <artefato>
FOUNDATION_DB_HOST=... FOUNDATION_DB_PORT=... FOUNDATION_DB_NAME=... FOUNDATION_DB_USER=... \
FOUNDATION_DB_PASSWORD=... FOUNDATION_DB_APPLICATION_NAME=... \
node node_modules/typeorm/cli.js migration:run -d dist/native/persistence-typeorm/data-source.cli.js
```

O `data-source.cli.ts` usa o mesmo catálogo e a mesma fábrica do runtime
(`createMigrationDataSource`), com `synchronize: false`, `dropSchema: false` e `migrationsRun: false`.
**Ensaiado**: 7 migrations aplicadas, 8 tabelas criadas (as 7 de dados mais `migrations`).

Recomendação (não ensaiada): execute as migrations num passo único, antes de subir as réplicas. Com
`FOUNDATION_DB_MIGRATIONS_RUN=true`, cada processo tenta aplicar as migrations no próprio boot
(`PersistenceLifecycle.onModuleInit`). Com várias réplicas, isso concorre pelo mesmo histórico.

### 5.3 Proibido

- Nenhum caminho do runtime ou da CLI liga `synchronize`. Mudanças de schema só entram por migration.
- Não há `dropSchema`.
- Não há migração de dados entre versões de banco (`docs/persistence.md`, "Fora do escopo").

## 6. Processos

### 6.1 API (`src/main.ts`)

1. Carrega `composition/instrumentation.generated` antes de tudo (OTel, vazio sem seleção).
2. `NestFactory.create(AppModule)`, depois `app.enableShutdownHooks()` e `app.listen(PORT ?? 3000)`.

Execução do artefato (ensaiada): `cd <artefato> && PORT=<porta> node dist/main.js`.

Encerramento: o Nest recebe SIGTERM, chama `beforeApplicationShutdown` (admissão em drenagem:
novas requisições 503, em voo até `drainDeadlineMs`, padrão 10000 ms; ver `docs/admission.md`), fecha o
pool do `DataSource` e só então reemite o sinal ao próprio processo. O código de saída observado é
**143** (128 + SIGTERM), não 0. Isso é o comportamento do Nest (`nest-application-context.js`, linha
213), e não é erro. O ensaio mediu o fechamento do pool: as conexões da API no PostgreSQL caíram de 1
para 0.

Não ensaiado: resposta 503 de `/health/ready` durante a drenagem. A cobertura existe em
`test/admission-drain.e2e-spec.ts`.

### 6.2 Worker (`src/worker.ts`)

- Entrypoint de produção é `runWorkerProcess({ env, handlers, identity })`, chamado pelo host. O
  `require.main` do próprio arquivo passa `identity: undefined`, então o processo sai com código 1 e
  o código `worker_identity_resolver_missing`. Isso é esperado: sem resolver de identidade, o worker não sobe.
  Comportamento lido do código (`src/worker.ts`); não executado no ensaio.
- Sinais: SIGTERM e SIGINT chamam `consumer.drain(FOUNDATION_WORKER_DRAIN_DEADLINE_MS)`. Ao vencer o
  prazo, o worker fecha e jobs ativos perdem o lock e voltam à fila pelo stalled do BullMQ. Depois,
  `app.close()` e saída com código 0. Um backstop sai com código 1 após prazo + 10 s.
- **Subir o worker a partir do artefato** (com `native/queue-bullmq` selecionado; sem ele o arquivo não existe):
  1. Defina as variáveis da seção 3.4 (worker). `FOUNDATION_REDIS_HOST` é obrigatório; a persistência usa as
     variáveis de `native/persistence-typeorm`.
  2. `node dist/worker.js` a partir da raiz do artefato, depois de `npm ci --omit=dev --ignore-scripts --allow-scripts=`.
  3. O arquivo não passa resolver de identidade. Sem ele, sai com código 1 e `worker_identity_resolver_missing`.
     Esse é o comportamento atual, não uma falha de instalação. O host sobe o worker chamando
     `runWorkerProcess({ env, handlers, identity })` de `dist/worker.js` com o próprio resolver.
- Verificado no build: `dist/worker.js` existe, `bullmq` está no inventário na versão do lock e o módulo
  resolve as dependências sem iniciar (teste `artifact: entrypoint do worker`). Não ensaiado: subida real
  com Redis e PostgreSQL, drenagem e reentrega. A cobertura existe em `test/worker-recovery.e2e-spec.ts`.

### 6.3 Escala

- API: `QueueBullmqModule.register({ consume: false })`, só produz jobs.
- Worker: `consume: true`, processo próprio. Escale cada um pela carga.
- Pool do PostgreSQL: `réplicas × pool + workers × pool + reserva <= max_connections`
  (`evaluateConnectionBudget`, `docs/admission.md`).

## 7. Desativação

Desativar um nativo ou extensão é uma mudança de build. O código sai do artefato e nenhum dado é apagado.

1. Retire o nativo do perfil (`api-cli setting disable-native <id>` ou edição manual) ou
   desinstale a extensão (`api-cli uninstall <pacote>`, que recusa se houver `bindings`).
2. `npm run compose`. Confirme com `npm run compose -- --check`.
3. Remova a contribuição de persistência do host. Ela fica no catálogo do host
   (`PERSISTENCE_CONTRIBUTIONS`). O `api-cli uninstall` não a remove sozinho
   (`contacts/test/removal/README.md`).
4. `npm run build:artifact` e redeploy do novo artefato.

O que permanece depois da desativação:

- tabelas e linhas, porque o código não as remove;
- o histórico da tabela `migrations`, sem rollback de schema;
- o purge de dados é uma operação separada, que a Foundation não oferece (`docs/persistence.md`,
  "Remoção de módulo").

Ensaio: **não ensaiado aqui**. O cenário completo, com dados em dois tenants, remoção, rebuild e boot
sobre o mesmo banco, está em `contacts/test/removal/removal.e2e.test.ts` (`npm run test:removal` em
`contacts/`). Não o executei nesta entrega.

## 8. Recuperação

| Situação | Comportamento | Ação do operador | Referência |
| --- | --- | --- | --- |
| PostgreSQL parado ou conexões caídas | Refresh, leitura de sessão e login falham com `authentication_unavailable`. Nenhum token é emitido. | Restaurar o banco. Não há reemissão automática. | `docs/sessions.md` |
| Sessão pendente com falha | A sessão é revogada e o login é negado. | Nenhuma. | `docs/sessions.md` |
| Reuso de refresh token | A família é revogada, o evento é auditado e a resposta é `invalid_credentials`. | Investigar pela auditoria. | `docs/sessions.md` |
| Efeito externo com resultado incerto (`outcome_unknown`) | Replays respondem 409 `idempotency_outcome_unknown`. Nenhuma reexecução automática. | Resolver com `reconcileOutcomeUnknown` e um `ExternalOutcomeReconciler` do host. Sem reconciliador, a decisão é humana. | `docs/idempotency.md`, "Efeito externo e reconciliação" |
| Executor de idempotência que caiu no meio | Fica em `in_progress`. Após o lease, outra réplica com o mesmo intento o recupera. | Nenhuma. | `docs/idempotency.md`, "Recuperação" |
| Outbox pendente após falha do broker | `pending` com `attempts` e `BROKER_UNAVAILABLE`, backoff exponencial limitado. Ao esgotar, vai a `failed` (`MAX_ATTEMPTS_EXCEEDED`). Nada é descartado. | Inspecionar `failed`. O reprocessamento é manual. O laço de `drainOnce` é responsabilidade do integrador. | `docs/outbox.md` |
| Job com falha recuperável | Retry só pelo BullMQ, com backoff e teto `min(envelope.maxAttempts, FOUNDATION_JOBS_MAX_ATTEMPTS)`. Na última tentativa vira `failed_terminal`. | Nenhuma. | `docs/jobs.md`, "Política de execução" |
| Job com falha terminal | Vai à fila `failed` do BullMQ, com `failedReason` igual ao código. A atividade fica `failed_terminal`. | Reprocessar é operação explícita. Não há reprocessamento automático. | `docs/jobs.md`, "Fila de falha" |
| Worker morto no meio de um job | O lock expira. O job volta à fila (at-least-once). Handlers precisam ser idempotentes. | Nenhuma. | `docs/jobs.md`, "Drenagem" |
| Redis indisponível (rate limit) | `fallback-local` (padrão) limita com metade do limite. `fail-closed` responde 503. | Restaurar o Redis. | `docs/admission.md`, "Falha do Redis" |
| Redis indisponível no boot | A aplicação sobe e usa a política de falha. | Restaurar o Redis. | `docs/admission.md`, "Limitações" |
| Admissão saturada | 503 com `Retry-After` para fila cheia, espera expirada ou drenagem. | Ajustar `maxInFlight`/`maxQueue` ou escalar réplicas. | `docs/admission.md` |
| Rate limit excedido | 429 com `Retry-After` em segundos. | Nenhuma, salvo ajuste de política. | `docs/admission.md` |
| Readiness | `/health/ready` devolve 200 se nenhuma dependência de `readiness.checks` falhar. Sem checks configurados, o PostgreSQL **não** entra na readiness. | Configurar checks no host se a readiness deve refletir o banco. | `docs/admission.md` |

Os endpoints `/health/live` e `/health/ready` só existem com `FoundationCoreModule.withAdmission(...)`.
Sem essa chamada, eles dão 404 (`src/core/infrastructure/modules/foundation-core.module.ts`).

Não ensaiado: queda real de PostgreSQL ou de Redis durante a execução da API, e a resposta de
`/health/ready` nesses casos. As garantias estão cobertas por testes e2e existentes.

## 9. Rollback

### 9.1 Código (artefato)

- Mantenha o artefato anterior inteiro (`dist/`, `package.json`, `package-lock.json` e
  `artifact-inventory.json`). Ele é a referência do que estava no ar.
- Para voltar, reimplante o artefato anterior e rode `npm ci --omit=dev --ignore-scripts` nele.
- Compare o `profile.sha256` e os pacotes do inventário para confirmar a versão antes do redeploy.

Não ensaiado: rollback de artefato entre duas versões reais. Há apenas um artefato no ensaio.

### 9.2 Extensão

Reinstale a versão anterior com `api-cli install <pacote>@<versão-anterior-exata>`. O `api-cli` valida
peers e integridade da mesma forma que na instalação nova. Não ensaiado.

### 9.3 Migrations

Ordem de rollback: uma migration por vez, da mais nova para a mais antiga. O `typeorm` reverte a última
registrada na tabela `migrations`.

```sh
cd <artefato>
FOUNDATION_DB_HOST=... (mesmas variáveis da seção 5.2) \
node node_modules/typeorm/cli.js migration:revert -d dist/native/persistence-typeorm/data-source.cli.js
```

Ensaiado: `migration:revert` executou o `down` de `CreateInboxMessages1794691200000` (a última),
removeu `inbox_messages` e o registro na tabela `migrations`. Depois, `migration:run` reaplicou
as 7 migrations e a tabela voltou. A API subiu de novo e respondeu `/health/ready` com 200.

Reversível e não reversível:

- **Reversível em schema**: todas as 7 têm `down` com DDL real.
- **Destrutivo em dados**: o `down` apaga a tabela com todas as linhas. Faça backup antes (`pg_dump`
  é recomendação, não ensaiada).
- **Auditoria**: o `down` de `CreateAuditEntries` apaga `audit_entries`, a trilha de auditoria. Não
  reverta essa migration em produção sem exportar a auditoria antes.
- **Compatibilidade código × schema**: o schema novo pode ter sido usado pelo código novo. Reverter o
  schema sem reverter o código antigo quebra a versão em execução. Coordene os dois.

Não ensaiado: revert em cadeia (mais de uma migration) e a reversão de `AddIdempotencyLease` com
dados.

## 10. Limites conhecidos

1. **Worker sem resolver de identidade**: o entrypoint `dist/worker.js` está no artefato com fila, mas sai com
   `worker_identity_resolver_missing` quando executado direto. O host precisa chamar `runWorkerProcess` com o
   resolver dele (seção 6.2; achado 13.1).
2. **Tokens de host obrigatórios**: o boot com `native/persistence-typeorm` exige `persistence.options`
   provido pelo host. O `AppModule` padrão não o fornece (seção 3.3).
3. **Health só com admissão**: `/health/*` depende de `withAdmission`. A readiness não verifica o banco
   sem `readiness.checks`.
4. **Código de saída 143**: a API termina pelo SIGTERM reemitido pelo Nest. Orquestradores devem
   tratar 143 como encerramento normal, não como falha.
5. **Relay do outbox não ligado ao worker**: o laço de `OutboxRelay.drainOnce` é do integrador
   (`docs/outbox.md`).
6. **Fila de falha sem reprocessamento automático** (`docs/jobs.md`).
7. **Profundidade da fila de admissão sem gauge** (`docs/admission.md`, "Sinais").
8. **Extensões**: `extension-sources.ts` vazio no repositório. Ativar extensão depende do `api-cli install`.
9. **Registry**: o lock aponta para o registry público. Um ambiente com registry isolado precisa de
   espelho compatível com essas URLs, o que não foi testado.

## 11. Ensaio operacional

```sh
cd foundation-api
perl -e 'alarm 1200; exec @ARGV' bash scripts/rehearse-operations.sh
```

O script (`scripts/rehearse-operations.sh`) copia a Foundation para um diretório temporário, sem
`.git`, e nunca altera o repositório. Ele:

1. escreve um perfil com `native/persistence-typeorm` na cópia;
2. aplica na cópia um host de ensaio: um `@Global` que provê `persistence.options` a partir de
   `FOUNDATION_DB_*` e `FoundationCoreModule.withAdmission(...)` para habilitar `/health/*`;
3. roda `npm run compose` e `npm run compose -- --check`;
4. roda `npm run build:artifact` e `npm ci --omit=dev --ignore-scripts` no artefato;
5. sobe `postgres:16-alpine` com nome único e porta efêmera, criados pelo próprio script;
6. aplica as migrations pela CLI do TypeORM;
7. sobe `dist/main.js`, checa `/health/live`, `/health/ready` e `/`;
8. envia SIGTERM, mede o código de saída e as conexões no PostgreSQL antes e depois;
9. reverte a última migration, confere a remoção e reaplica;
10. sobe a API de novo, checa `/health/ready` e envia SIGTERM;
11. remove o contêiner que criou.

Limpeza: um `trap` remove somente o contêiner criado pelo script, pelo nome gerado. Ele encerra o
processo da API iniciado aqui e apaga o diretório temporário, exceto com `KEEP_WORK=1`. O script nunca
usa `docker rm` genérico, `docker system prune` nem toca em outros contêineres.

Resultado da última execução: exit 0, nos passos 1 a 11 acima. Detalhes e saída na seção 12.

## 12. Resultado do ensaio

Execução de 2026-11-09 em macOS (Darwin 27.2.0), Node v24.21.0, npm 11.19.0, Docker 29.8.0,
`postgres:16-alpine`. Exit 0 do script.

| Passo | Resultado |
| --- | --- |
| Copia e perfil | `natives: native/persistence-typeorm`, `extensions: []` |
| `npm run compose` e `--check` | `Composition is up to date.` |
| `npm run build:artifact` | `Artifact built: 135 packages, modules [native/persistence-typeorm].` |
| `npm ci --omit=dev` no artefato | ok; `prettier`, `typescript` e `ts-node` ausentes |
| PostgreSQL | contêiner `foundation-rehearsal-pg-…` criado e removido pelo script |
| `migration:run` | 7 migrations `has been executed successfully`; tabelas `activities, audit_entries, auth_refresh_tokens, auth_sessions, idempotency_records, inbox_messages, migrations, outbox_messages` |
| `GET /health/live` | 200 |
| `GET /health/ready` | 200 `{"status":"ready"}` |
| `GET /` | 200 |
| SIGTERM | código 143; conexões da API no PostgreSQL 1 → 0; log sem erro |
| `migration:revert` | `CreateInboxMessages1794691200000 has been reverted successfully.`; `inbox_messages` removida |
| `migration:run` (reaplicação) | 7 migrations; `inbox_messages` restaurada |
| API após reaplicação | `/health/ready` 200; SIGTERM 143; pool 1 → 0 |
| Remoção do contêiner | `foundation-rehearsal-pg-…` removido; nenhum contêiner restante |

Verificações complementares:

- `npx -y openspec validate define-native-foundation-operational-core --strict`: exit 0, "Change … is valid".
- `npm run lint:check` (escopo `src` e `test`; o script fica em `scripts/`): exit 0.

Passos do guia **não ensaiados** e por quê:

- instalação de extensão via `api-cli` com registry isolado (seção 2.2);
- desativação com remoção de contribuição e boot sem o pacote (seção 7; coberto por `contacts/test/removal`);
- drenagem da API com requisições em voo e 503 em `/health/ready` (seção 6.1);
- subida real, drenagem e reentrega do worker (seção 6.2; o entrypoint está no artefato, mas não foi subido com Redis e PostgreSQL);
- queda real de PostgreSQL e de Redis, e as respostas de readiness correspondentes (seção 8);
- rollback de artefato entre duas versões, reinstalação de extensão anterior e revert em cadeia (seção 9);
- backup antes do revert e revert com dados (seção 9.3);
- `FOUNDATION_DB_MIGRATIONS_RUN=true` no boot (seção 5.2);
- Redis, `queue-bullmq`, `cache-redis`, `ext/jwt-auth`, `ext/swagger-adapter` e `opentelemetry` (fora do perfil ensaiado).

## 13. Achados do ensaio para a equipe

1. **Entrypoint do worker no artefato (corrigido)**: `scripts/build-artifact.ts` copia `src/worker.ts` só com
   `native/queue-bullmq` selecionado. O artefato traz `dist/worker.js` e o inventário lista
   `entrypoints: ["main", "worker"]`. O arquivo não passa resolver de identidade, então `node dist/worker.js`
   sai com código 1 e `worker_identity_resolver_missing`. O host precisa de um bootstrap que chame
   `runWorkerProcess` de `dist/worker.js` com o resolver dele (seção 6.2).
2. **O boot com persistência depende de token de host que a Foundation não provê.** Os testes de
   `contacts/` já reconhecem a lacuna. O ensaio contornou o problema com um `@Global` na cópia.
3. **`/health/*` existe só com `withAdmission`**, e a readiness não verifica o banco por padrão.
4. **SIGTERM retorna 143 na API.** Isso é o comportamento do Nest com `enableShutdownHooks`. Os
   orquestradores precisam saber disso.
5. **Catálogo nativo**: descriptors em `src/core/application/modules/native-catalog.ts` (metadata pura) e fontes de import/pacotes em `src/core/infrastructure/composition/native-sources.ts`; os dois precisam evoluir juntos.

## 14. Qualificação de capacidade

Este guia não mede capacidade. A única execução do perfil D4 está em `docs/qualification.md`.
Ela não autoriza alegação de produção: dois critérios não atenderam, e a topologia medida não
é a de contêiner pedida em D4.
