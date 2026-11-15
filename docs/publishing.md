# Publicação dos pacotes `@devtrack`

Regras da spec `foundation-distribution` e da change `split-foundation-repositories`. Valem para `@devtrack/foundation-api` e para os módulos oficiais (`@devtrack/jwt-auth`, `@devtrack/swagger-adapter`).

## Verificação de publicação

A Foundation distribui o executável `devtrack-check-publishable` (`scripts/check-publishable.mjs`, sem dependências). Ele reprova o pacote quando:

- o `name` está fora do escopo `@devtrack`;
- a `version` não é semver exata;
- o pacote está marcado como `private`;
- alguma dependência (`dependencies`, `optionalDependencies`, `peerDependencies`, `bundleDependencies`) usa `file:`, `link:`, `workspace:`, caminho relativo ou absoluto, git ou URL.

O resultado sai pelo exit code: 0 quando o pacote é publicável e 1 com a lista de violações.

```bash
# na Foundation (também roda no prepack, antes de qualquer npm pack/publish)
npm run check:publishable

# num módulo oficial, com a Foundation instalada como devDependency
npx devtrack-check-publishable
```

Testes: `npm run test:publishable`, que cobre o pacote válido, o nome sem escopo, dependência `file:`, link e relativa, `private` e versão não exata.

## Registry

O registry não fica no `package.json`. Cada ambiente o define no `.npmrc` (local ou do pipeline):

```ini
@devtrack:registry=${DEVTRACK_REGISTRY}
```

- O ensaio usa sempre um Verdaccio local, por exemplo `DEVTRACK_REGISTRY=http://localhost:4873`.
- Destino definitivo (decisão de 2026-11-15): npm público, `https://registry.npmjs.org`, com a organização `devtrack` e pacotes públicos (`publishConfig.access: public`). Nos pipelines, `DEVTRACK_REGISTRY=https://registry.npmjs.org`.
- Destino provisório até a primeira publicação no npmjs (decisão de 2026-11-10): o registry local persistente do workspace, `tooling/local-registry/` na raiz do monorepo (`./start.sh`, `http://localhost:4873`, storage em `~/.devtrack/verdaccio`). Ele continua servindo ao ensaio e ao desenvolvimento local.
- Quem tem `@devtrack:registry=https://registry.npmjs.org/` no `~/.npmrc` precisa sobrescrever o escopo no `.npmrc` do projeto (ou usar `npm_config_userconfig` apontando para um `.npmrc` próprio), senão `npm install` procura os pacotes no npmjs e `npm publish` pode tentar publicar lá.

### Lockfile sem URL de registry

Os repositórios dos módulos versionam um `.npmrc` com `omit-lockfile-registry-resolved=true`. O lock guarda versão e `integrity`, mas não o `resolved`, e cada ambiente baixa do registry configurado. Assim o mesmo lock serve ao registry local, ao ensaio e ao destino definitivo. Esse arquivo não tem variáveis e por isso pode ser versionado; o escopo `@devtrack` continua no `.npmrc` de cada ambiente.

O `.npmrc` com `${DEVTRACK_REGISTRY}` não é versionado. O npm falha quando a variável referenciada não existe, e isso quebraria `npm install` em qualquer checkout sem ela.

## Versões e ordem

- A Foundation e os módulos começam em `0.1.0`. Os módulos declaram peer `@devtrack/foundation-api: ^0.1.0`.
- Em `0.x`, `^0.1.0` aceita só `0.1.x`. Uma versão menor nova da Foundation exige republicar os módulos depois que a conformidade passar contra ela.
- `@devtrack/api-cli` é publicado deste monorepo (D9). Não tem peers e pode sair a qualquer momento; o kit de conformidade o usa como instalador canônico fora do monorepo (`DEVTRACK_API_CLI_ROOT`).
- Ordem: primeiro a Foundation, depois os módulos. A versão da Foundation exigida pelo peer precisa existir no mesmo registry antes da publicação de um módulo.
- Versão publicada não é removida. Um defeito se corrige com uma versão nova e `npm deprecate` na versão anterior.

## Pipelines (Azure Pipelines, D5)

Cada repositório tem um `azure-pipelines.yml` e o template `.azure-pipelines/setup.yml`, que fixa o Node e grava o npmrc do escopo `@devtrack` no diretório temporário do agente (`NPM_CONFIG_USERCONFIG`).

Variáveis definidas na UI do pipeline, fora do repositório:

| Variável | Uso |
| --- | --- |
| `DEVTRACK_REGISTRY` | URL do registry do escopo `@devtrack`. É a origem da Foundation, do `api-cli` e o destino da publicação. |
| `DEVTRACK_REGISTRY_TOKEN` | Secreta. Token de publicação. Só os jobs de publicação o recebem (`auth: true` no template); os gates leem o registry sem credencial, porque executam código de dependências e do módulo qualificado. Sem ela, o job de publicação falha no passo do token. |

Disparo: push na `main` e tags `v*`. O Azure Repos ignora a chave `pr:`, então a validação de PR é uma política de branch da `main` (Build validation) apontando para o pipeline.

- **Foundation** (`devtrack-foundation-core`): um job por gate do CI do monorepo (imports, lint-typecheck, unit, contracts, composition, integration, artifact, publishable, module-conformance). O job do kit instala `@devtrack/api-cli` (`API_CLI_VERSION`) num prefixo separado.
- **Módulos** (`devtrack-jwt-auth`, `devtrack-swagger-adapter`): job de qualidade (typecheck, lint, testes, fronteiras, build, `check:publishable`) e job de conformidade contra a Foundation publicada. O segundo faz checkout do `devtrack-foundation-core` na tag do peer (`resources.repositories`, `ref: refs/tags/v0.1.0`) numa pasta que não pode se chamar `foundation-api`, porque o `link-foundation.mjs` ligaria a pasta irmã. Depois roda `npm run conformance:published` a partir dela. O relatório sai como artefato do pipeline mesmo quando o job falha.
- **Publicação**: stage próprio, só em tag `v*` e depois de todos os gates verdes. A tag precisa ser igual a `v` mais a versão do `package.json`. Nos módulos, o `prepublishOnly` ainda recusa publicar sem o peer publicado.

`conformance:published` (`tooling/module-conformance/runner/qualify-published.ts`):

1. Resolve no `DEVTRACK_REGISTRY` a maior versão publicada da Foundation dentro da faixa do peer e recusa um checkout em outra versão.
2. Sobe um Verdaccio efêmero em Docker e copia para ele o tarball publicado da Foundation, com a `integrity` conferida, mais o `npm pack` do módulo. Nada é publicado no registry real.
3. Instala `@devtrack/api-cli` do registry real, monta o inventário num host limpo (`api-cli install` e `build:artifact`) e roda o kit no perfil padrão.
4. Sai com o código do kit: `0` (passed) libera a publicação; `1` (failed) e `2` (incomplete) bloqueiam.

A ordem de publicação vale para as tags. Primeiro a tag `v<versão>` da Foundation, que publica e cria a ref usada pelos módulos; depois as tags dos módulos.

O lock de cada módulo guarda a `integrity` do tarball da Foundation. Quando a Foundation é publicada com conteúdo diferente do que gerou o lock (num registry novo, por exemplo), o `npm ci` do módulo falha com `EINTEGRITY`. Antes da tag do módulo, regenere essa entrada contra o registry de destino. Com a mesma versão, `npm install --package-lock-only` confia no lock e não muda nada, então apague antes a entrada `node_modules/@devtrack/foundation-api` do `package-lock.json`. Depois rode `npm install --package-lock-only`, confira que só a linha `integrity` dessa entrada mudou e faça o commit.

### Primeira publicação no npmjs

Pré-requisitos, fora do repositório:

- Organização `devtrack` no npmjs, com quem publica como owner ou membro com permissão de publicação nos pacotes do escopo.
- Token granular do npmjs com leitura e escrita restritas ao escopo `@devtrack` e com a opção de ignorar 2FA ativada; sem ela, o `npm publish` do pipeline pede OTP. O npmjs limita a validade de tokens com escrita: anote o vencimento e renove `DEVTRACK_REGISTRY_TOKEN` antes dele.

Ordem, porque cada etapa precisa da anterior no registry:

1. `@devtrack/api-cli`, deste monorepo e sem pipeline, porque o job do kit da Foundation o instala.
2. Tag `v0.1.0` no `devtrack-foundation-core`, que publica a Foundation e cria a ref usada pelos módulos.
3. Em cada módulo, regenerar a entrada da Foundation no lock contra o npmjs (parágrafo do `EINTEGRITY` acima), commit, e a tag `v0.1.0`.

Nome e versão publicados no npmjs não voltam a ficar disponíveis: um `unpublish` não libera a mesma versão. Antes de cada tag, confira versão, licença e conteúdo com `npm pack --dry-run`.

## Limites

- A verificação olha só o `package.json`. Não garante que o conteúdo empacotado funcione; isso cabe ao ensaio no Verdaccio e ao kit de conformidade.
- Licença: MIT nos quatro pacotes publicados (decisão de 2026-11-15), com o arquivo `LICENSE` na raiz de cada repositório, que o npm inclui no tarball. O `contacts` e o artefato gerado pelo `build:artifact` continuam `UNLICENSED`, porque não são publicados.
