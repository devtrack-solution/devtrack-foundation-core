# Autoria de módulo: kit de conformidade

Tarefa da mudança `qualify-foundation-module-contracts`. O kit qualifica um artefato de módulo
contra um host e um perfil explícitos. Não é sandbox, não mede carga e não transforma major 1
em compatibilidade universal.

## 1. Pré-requisitos

- Node 24, o mesmo da Foundation (`foundation-api` com `npm ci` já feito).
- O módulo e o host são diretórios de artefato, não o checkout de trabalho. O kit recusa
  symlink que escape do pacote e não completa arquivo ausente a partir de outro diretório.
- Descriptor no formato já usado pela Foundation (`id`, `foundationApiMajor`, `origin`,
  `features`, `provides`, `requires`). Não há manifesto novo.
- `api-cli` presente no workspace se o check `install` for obrigatório. Sem registry
  allowlisted, esse check fica `not-run` e o perfil padrão não aprova.
- Inventário `artifact-inventory.json` do `buildArtifact` quando a exclusão física precisa
  ser provada. Sem o arquivo, o cenário fica `not-run`. Cache de imports não substitui o
  inventário.

## 2. Comando

A partir de `foundation-api/`:

```sh
npm run conformance -- --request caminho/request.json --out caminho/relatorio
```

`--profile` é opcional e só aceita o perfil padrão v1 intacto
(`tooling/module-conformance/profiles/standard-v1.json`). Arquivo adulterado faz a entrada
falhar antes de carregar o módulo.

Códigos de saída, do mesmo runner usado no CI:

| Código | Resultado | Quando |
| --- | --- | --- |
| 0 | `passed` | Todos os checks obrigatórios do perfil informado passaram |
| 1 | `failed` | Qualquer check falhou, ou a entrada é inválida |
| 2 | `incomplete` | Nenhum check falhou, mas um obrigatório não rodou ou estourou o prazo |

`passed` num perfil `custom` não é aprovação do perfil padrão. O resumo diz
`standardApproval: no`.

## 3. Forma da requisição

`schemaVersion` 1. Campos reconhecidos: `host`, `module`, `profile`, `selection`, `tools`,
`limits`, e os opcionais `baseline`, `migration`, `inventory`, `registry`, `foundationRoot`,
`probeSentinel`. Qualquer outro campo, inclusive um checkout de apoio, é rejeitado.

```json
{
  "schemaVersion": 1,
  "host": { "path": "host", "version": "0.0.1", "digest": "sha256:<64 hex>" },
  "module": { "path": "module", "version": "1.0.0", "digest": "sha256:<64 hex>" },
  "profile": { "id": "standard", "version": 1 },
  "selection": {
    "descriptorFile": "descriptor.json",
    "enabledFeatures": [],
    "companions": ["descriptors/clock.json"],
    "bindings": []
  },
  "tools": { "node": "v24.21.0" },
  "limits": { "timeoutMs": 2000, "maxOutputBytes": 4096 }
}
```

Digest é do conteúdo do diretório, sem caminho absoluto. Dois diretórios com o mesmo
conteúdo e caminhos diferentes têm a mesma identidade de insumos. Horário e duração não
entram nessa identidade.

Perfil customizado precisa de `kind: "custom"` e `checks`. Omitir um check do padrão e
ainda assim pedir `id: "standard"` é rejeitado.

## 4. O que o perfil padrão verifica

Checks obrigatórios: integridade, exports, consumidor TS, implementador TS, fronteiras,
composição, geração, boot, inventário e instalação.

- Fronteiras usam `scripts/check-boundaries.mjs` com layout `extension`
  (`src/domain`, `src/application`). O layout `foundation` continua sendo o do host.
  Layout desconhecido é erro, não aprovação. Pacote sem essas pastas fica `not-run`.
- Composição chama `resolveComposition`. Feature ligada e desligada são registradas em
  separado. Provider ausente ou ambíguo devolve o código do resolvedor
  (`MISSING_PROVIDER`, `AMBIGUOUS_PROVIDER`), sem escolher outro provider.
- Geração chama `renderComposition`. Não há segundo gerador.
- Boot executa o comando em `package.json#conformance.boot` com prazo e teto de saída.
  Processo que não encerra é morto; o check fica `not-run` por timeout e o resultado
  global não é `passed`.
- Inventário lê o arquivo do build canônico. Exclusão física, presença e desativação em
  runtime são distinções desse arquivo. Esta suíte não invoca `buildArtifact` (ele faz
  `npm ci`).
- Instalação copia o pacote para área temporária sem symlink e, se `api-cli` carregar,
  chama `validateManifest` e `parseDescriptor`. `installExtension` no host só roda com
  `registry` e `foundationRoot`. Sem isso o check não é aprovado.

## 5. Como ler o relatório

`report.json` e `summary.txt` saem em `--out`. O JSON não guarda caminho absoluto do
artefato nem stdout. `claims.crossVersionCompatibility` fica falso mesmo quando a
comparação estrutural passa. `claims.productionCapacity` e `claims.securityAudit` são
sempre falsos.

Sem `baseline`, o check `compatibility` é `not-applicable`. Não há afirmação entre versões.

Com baseline, export removido, campo obrigatório acrescentado, união ampliada com
consumidor exaustivo ou fixture comportamental divergente reprovam o check. Igualdade de
tipos não cobre semântica que a fixture não exercita.

Exceção experimental (D1): `migration.decision`, `migration.validation` e
`migration.artifactDigests` precisam existir e bater com os artefatos. A quebra continua
`failed`. Digest errado rejeita a exceção e também não apaga a quebra. Consumidores
migrados precisam de uma execução nova; a execução anterior não os cobre.

## 6. Exemplo de interpretação

Relatório com `result: incomplete`, `install: not-run (registry-not-configured)` e
`standardApproval: no`: os checks que rodaram podem estar verdes, mas o perfil padrão não
foi aprovado. Não publicar esse relatório como conformidade.

Relatório com `compatibility: failed` e `exception.accepted: true`: a migração foi
referenciada, a quebra segue visível. Não tratar como compatível.

Relatório com `compatibility: passed` e `crossVersionCompatibility: no`: a diferença
procurada não apareceu. Isso não é compatibilidade universal.

## 7. Troubleshooting

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| saída 1, `digest-mismatch` | O diretório mudou depois do digest calculado | Recalcular o digest do artefato empacotado, não do checkout |
| saída 1, `profile.file` | `standard-v1.json` foi editado | Restaurar o arquivo do kit; não enfraquecer o padrão |
| saída 1, `export-file-missing` | `exports` aponta para arquivo que não está no pacote | Incluir o arquivo no artefato; o kit não busca no checkout |
| saída 1, `checkout-dependency` | Import relativo escapa do pacote | Remover a referência; não passar outro diretório na requisição |
| saída 1, `MISSING_PROVIDER` / `AMBIGUOUS_PROVIDER` | Seleção sem provider único | Corrigir companions ou bindings; o kit não escolhe provider |
| saída 2, `timeout` | Fixture não encerrou no prazo | Corrigir o boot ou aumentar `limits.timeoutMs` |
| saída 2, `registry-not-configured` | Perfil padrão sem registry | Informar registry allowlisted ou aceitar que o padrão não aprovou |
| saída 2, `installer-interface-missing` | `api-cli` não carregou | `npm ci` em `api-cli`; não simular instalação |
| saída 2, `insufficient-material` | Sem `src/domain` ou `src/application` | O gate não aprova o que não analisa |

O processo filho recebe só `PATH`, `HOME` temporário e, se a requisição pedir, o sentinela
de teste. O relatório não reproduz esse valor nem o ambiente completo.

## 8. Rollback

Não há migration nem dado de produção. Para retirar o kit:

1. Remover o job `module-conformance` de `.github/workflows/ci.yml` e a entrada
   correspondente em `ci-required`.
2. Remover os scripts `conformance` e `test:conformance` de `foundation-api/package.json`.
3. Apagar `foundation-api/tooling/module-conformance/` e este guia.

Não apagar relatórios já emitidos se alguém os estiver usando como evidência. Não alterar
runtime, Contacts nem o gate de fronteira do host além do argumento opcional `layout`,
cujo padrão continua `foundation`.

## 9. Execução desta mudança

Suíte `npm run test:conformance` em 2026-11-10: 11/11. Cobre exits 0, 1 e 2, digest
divergente sem boot, perfil adulterado, matriz positiva/negativa, timeout, sentinela,
baseline e exceção D1. O perfil padrão sem registry termina `incomplete` de propósito.
Contacts não entra. O builder seletivo não referencia o kit; `package.json` da Foundation
não ganhou dependência dele.
