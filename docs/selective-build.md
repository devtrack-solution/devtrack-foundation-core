# Build seletivo do artefato

Este documento descreve o build seletivo (tarefa 2.2 da mudança `define-native-foundation-operational-core`): como o artefato é montado, o que entra e o que fica de fora, e o formato do inventário. A seção de contratos e perfil continua em `docs/core-contracts.md` (6.6 a 6.8).

## Uso

```bash
npm run build:artifact -- --profile <perfil.yaml> --out <diretório>
npm run build:artifact -- --verify <diretório do artefato>
npm run test:artifact
```

- `--profile` é um perfil de composição no mesmo formato de `config/composition.yaml`. Nunca contém segredos.
- `--out` recebe `dist/`, `package.json`, `package-lock.json` e `artifact-inventory.json`. O diretório de dependências (`node_modules`) não é copiado: o artefato é instalado pelo host com o lock gerado.
- `--workdir` (opcional) escolhe a área limpa. Precisa estar vazia ou não existir. Sem ela, o build usa um diretório temporário e o remove ao final.
- `--verify` confere um diretório já construído: inventário contra lock e conteúdo de `dist/`. Quando há `node_modules`, confere também.
- `npm test` **não** roda os testes do artefato; eles instalam pacotes e são lentos. Use `npm run test:artifact`.

## Pipeline

1. Lê e valida o perfil e resolve as dependências (`resolveArtifactDependencies` em `src/core/infrastructure/composition/native-sources.ts`).
2. Cria uma área limpa nova, fora de `src/`, e copia **somente**: `src/core`, `src/contracts`, `src/composition`, os quatro arquivos de bootstrap (`main.ts`, `app.module.ts`, `app.controller.ts`, `app.service.ts`), `src/worker.ts` **só** quando `native/queue-bullmq` está selecionado (o entrypoint do worker importa a fila e a persistência, que sem a fila não existem no artefato), os diretórios `src/native/<id>` dos nativos selecionados, `tsconfig*.json`, o perfil (como `config/composition.yaml`) e o script do gerador. Specs e testes não são copiados.
3. Roda o gerador de composição (`scripts/generate-composition.ts`) dentro da área limpa.
4. Remove da área limpa os arquivos que só existem para gerar a composição (`TOOLING_SOURCE_FILES`). O artefato não depende de nenhum deles.
5. Escreve `package.json` do artefato com as dependências de runtime do núcleo e dos nativos selecionados, em **versões exatas** tiradas do `package-lock.json` do host. Instala com `npm install --omit=dev --ignore-scripts --allow-scripts= --no-audit --no-fund`, o que gera o lock do artefato.
6. Compila com `tsc` (`tsconfig.build.json`) para `dist/`.
7. Gera `artifact-inventory.json`, confere com `verifyArtifact` e só então copia para `--out`.

## Excluir do build x desativar em runtime

São coisas diferentes e o inventário as separa:

| Conceito                                          | Significado                                                                                                                                                                             | Onde aparece                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Excluído do build** (`excluded-from-build`)     | O módulo e seus pacotes exclusivos **não existem** no artefato: não há arquivo em `dist/native/<id>`, nem pacote em `node_modules`, nem referência em `dist/`. Ativar exige novo build. | `modules.excludedFromBuild` e `excludedPackages`                                                      |
| **Desativado em runtime** (`disabled-at-runtime`) | O código e os pacotes **estão** no artefato, mas a funcionalidade é desligada por configuração do host.                                                                                 | `modules.disabledAtRuntime` (hoje vazio: nenhuma funcionalidade é incluída para depois ser desligada) |

Regra da arquitetura (design, seção 3): runtime pode desligar o que já foi incluído; a ausência física exige rebuild e rollout. Autenticação protegida não vira pública por desativar JWT.

## Formato do `artifact-inventory.json`

```json
{
  "schemaVersion": 2,
  "foundationApiMajor": 1,
  "profile": { "file": "full.yaml", "sha256": "..." },
  "node": { "version": "v24.21.0" },
  "entrypoints": ["main", "worker"],
  "modules": {
    "selected": [{ "id": "native/aws-s3", "features": [] }],
    "excludedFromBuild": ["native/opentelemetry"],
    "disabledAtRuntime": []
  },
  "excludedPackages": [{ "name": "@opentelemetry/sdk-node", "owner": "native/opentelemetry" }],
  "neverInArtifact": ["prettier", "ts-node", "typescript"],
  "packages": [
    {
      "name": "@aws-sdk/client-s3",
      "version": "3.1164.0",
      "integrity": "sha512-...",
      "path": "node_modules/@aws-sdk/client-s3",
      "directOf": ["native/aws-s3"]
    }
  ]
}
```

- O artefato inclui um `.npmrc` com `legacy-peer-deps=true`. O peer `@devtrack/foundation-api` das extensões (como `@devtrack/jwt-auth`) é o próprio host, que o npm não reconhece como instalado e tentaria baixar. Os peers foram validados pelo `api-cli` na instalação. O mesmo arquivo vale para o `npm ci` de implantação e rollback.
- `packages` vem de `npm ls --all --omit=dev --json` depois da instalação. Cada entrada traz versão e `integrity` do lock do artefato. `directOf` lista o núcleo (`core`), o nativo ou a extensão que declara o pacote como dependência direta; transitivos têm lista vazia.
- Peers opcionais ausentes (ex.: `class-transformer` de `@nestjs/common`) aparecem no `npm ls` sem versão e não são instalados; não entram no inventário.
- O inventário não tem timestamp: dois builds do mesmo perfil no mesmo Node produzem o mesmo arquivo (coberto por teste de determinismo).
- `excludedPackages` lista só pacotes exclusivos de nativos não selecionados. Pacote compartilhado com o núcleo ou com um nativo selecionado não é exclusivo.
- `entrypoints` lista os processos presentes em `dist/`, em ordem alfabética. `main` (`dist/main.js`) está sempre. `worker` (`dist/worker.js`) só entra com `native/queue-bullmq`, que exige `native/persistence-typeorm`. `schemaVersion` 2 introduziu o campo; inventários da versão 1 não passam em `--verify`.
- Subir o worker a partir do artefato: `node dist/worker.js` com as variáveis de `docs/operations.md` (seção 3.4, worker). Sem resolver de identidade, o arquivo sai com código 1 e `worker_identity_resolver_missing`, porque o entrypoint não passa `identity` (ver `docs/operations.md`, seção 6.2). O host sobe o worker chamando `runWorkerProcess` de `dist/worker.js` com o resolver dele.

## Nativos e pacotes de runtime

Cada nativo declara em `NATIVE_SOURCES` (`src/core/infrastructure/composition/native-sources.ts`) os pacotes npm que o código dele importa. Um teste confere essa lista contra os imports reais do diretório. O núcleo sempre inclui `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `reflect-metadata` e `rxjs`.

| Nativo | `runtimePackages` | Observação |
| --- | --- | --- |
| `native/http-security` | nenhum | Código no núcleo. |
| `native/opentelemetry` | `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace`, `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express`, `yaml` | `yaml` é peer obrigatório de `@opentelemetry/configuration`. |
| `native/aws-s3` | `@aws-sdk/client-s3` | Adapter de `ObjectStorage`. |
| `native/cache-redis` | `ioredis` | Rate limit compartilhado e readiness. |
| `native/persistence-typeorm` | `typeorm`, `pg` | `pg` é carregado pelo TypeORM para o driver PostgreSQL. |

Um nativo não selecionado tem seus pacotes exclusivos listados em `excludedPackages`, e não entra no artefato.

## Verificação

`verifyArtifact` reprova o build quando:

- um pacote excluído ou de tooling aparece no lock, em `node_modules` ou em `dist/` (busca por `'nome'` ou `'nome/...'` em `.js` e `.d.ts`);
- existe `dist/<id>` para um módulo excluído, ou `dist/native/<x>` sem seleção;
- o inventário não bate com o lock (versão ou `integrity`), ou o lock tem pacote que o inventário não lista;
- `dist/worker.js` existe sem o entrypoint `worker` no inventário (ou o contrário), ou o entrypoint `worker` existe sem `native/queue-bullmq` selecionado.

Os pacotes de tooling declarados em `TOOLING_PACKAGES` são `prettier`, `ts-node` e `typescript`.

## Decisões e desvios

- **`yaml` fica no nativo de telemetria, não no tooling.** O perfil padrão (sem nativos) não o contém, mas `@opentelemetry/configuration` declara `yaml` como peer obrigatório e o npm o instala junto com o OTel. Por isso `yaml` é declarado por `native/opentelemetry`. O núcleo nunca o importa, porque `composition-profile.ts` (que usa `yaml`) fica fora do artefato.
- **Gerador com ferramentas do host.** O gerador roda na área limpa, mas `prettier` e `yaml` vêm do `node_modules` do host via `NODE_PATH`. Eles não são instalados no artefato.
- **Lock do host como semente.** O `package-lock.json` do host é copiado para a área limpa antes do `npm install`, para que as versões transitivas continuem as já travadas. Só as dependências diretas são escritas com versão exata no `package.json` do artefato.
- **`--allow-scripts=` e ambiente sem `npm_config_*`.** O `~/.npmrc` do host define `allow-scripts=google-logging-utils`, que o npm 11 recusa em instalação de projeto. O build passa `--allow-scripts=` e remove as variáveis `npm_config_*` herdadas de `npx`/`npm run` dos processos filhos.
- **Extensões npm.** Entradas `extensions` do perfil entram no `package.json` com a versão exata do perfil. O `integrity` do perfil é conferido contra o lock. Hoje o registro de extensões está vazio, então o gerador rejeita qualquer extensão antes disso.

## Não coberto

- O adapter S3 (`native/aws-s3`) existe e é selecionável pelo perfil. Os testes de artefato cobrem o mecanismo com o fixture `native/fixture-storage` em `native-sources.spec.ts`; o S3 real não é exercitado no build.
- O build não verifica o tarball além do `integrity` do lock (a verificação de integridade do instalador é a tarefa 2.3).
- Perfis com `http-security` exigem um fornecedor de `access-token`, hoje a extensão `ext/jwt-auth`. O pacote dela e o `jose` entram no artefato como dependência da extensão instalada, não como nativo. O mesmo vale para `ext/swagger-adapter` e `@nestjs/swagger`. Esses perfis são montados e inventariados, mas não sobem sem os tokens do host. A subida real é coberta pelos testes e2e.
