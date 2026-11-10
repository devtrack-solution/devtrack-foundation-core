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
- O destino real (npm público com a organização `devtrack` ou feed do Azure Artifacts) é uma decisão aberta da change. Ele só muda a variável e as credenciais do pipeline.

O `.npmrc` com `${DEVTRACK_REGISTRY}` não é versionado. O npm falha quando a variável referenciada não existe, e isso quebraria `npm install` em qualquer checkout sem ela.

## Versões e ordem

- A Foundation e os módulos começam em `0.1.0`. Os módulos declaram peer `@devtrack/foundation-api: ^0.1.0`.
- Em `0.x`, `^0.1.0` aceita só `0.1.x`. Uma versão menor nova da Foundation exige republicar os módulos depois que a conformidade passar contra ela.
- Ordem: primeiro a Foundation, depois os módulos. A versão da Foundation exigida pelo peer precisa existir no mesmo registry antes da publicação de um módulo.
- Versão publicada não é removida. Um defeito se corrige com uma versão nova e `npm deprecate` na versão anterior.

## Limites

- A verificação olha só o `package.json`. Não garante que o conteúdo empacotado funcione; isso cabe ao ensaio no Verdaccio e ao kit de conformidade.
- O `license` continua `UNLICENSED`. Antes de publicar no npm público, é preciso definir a licença.
