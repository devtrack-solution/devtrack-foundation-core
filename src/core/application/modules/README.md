# Contrato de composição — API 1

`ModuleDescriptor` descreve uma unidade nativa ou npm. `ModuleSelection` seleciona
a unidade e suas funcionalidades. A entrada de `resolveComposition` contém apenas
as unidades selecionadas, sem descoberta do sistema de arquivos. O resultado
contém bindings resolvidos e `modules: readonly ResolvedModuleSelection[]`, com
providers antes dos consumidores. Cada item contém `id` e `enabledFeatures`
sempre presente: `[]` quando omitido na entrada, ou a lista validada em ordem
lexical. `orderedModuleIds` é derivado dessa mesma lista e permanece disponível.
As listas, os itens e os bindings retornados são cópias independentes da entrada;
mutações posteriores em descriptors ou seleções não alteram o resultado. Os tipos
são `readonly`, sem promessa de congelamento de objetos em runtime. A função não
inicia Nest, importa implementações ou instala pacotes.

Cada capacidade tem `id` e `major` inteiro positivo. O host aceita
`foundationApiMajor: 1`; os majors das capacidades devem ser iguais. Compatibilidade
de versões npm e integridade do pacote serão verificadas pelo instalador; não há
interpretador próprio de intervalos SemVer. Metadados npm são informações declaradas,
nunca prova de origem ou segurança. Esta função recebe objetos TypeScript tipados;
o futuro leitor de JSON/YAML deve validar sua estrutura antes de chamá-la.

`requires` declara uma dependência obrigatória. `whenFeature` a condiciona a uma
funcionalidade declarada em `features` e selecionada em `enabledFeatures`. Não há
ativação implícita. Uma capacidade tem no máximo uma declaração por lista e módulo.
Dois providers compatíveis exigem binding explícito por consumidor/capacidade.
Bindings para dependências inativas, providers ausentes ou incompatíveis são erros.
Providers internos de uma mesma unidade não devem ser declarados como dependência
de composição da própria unidade: isso produziria um ciclo.

Exemplo de um módulo com upload habilitável:

```ts
const media = {
  descriptor: {
    id: 'module/media',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    features: ['upload'],
    provides: [],
    requires: [{ id: 'object-storage', major: 1, whenFeature: 'upload' }],
  },
  enabledFeatures: ['upload'],
} satisfies ModuleSelection;
```

O consumidor conhece `object-storage`, sem depender de AWS. Um binding pode
selecionar `native/aws-s3` quando esse descriptor estiver na composição. Sem
`upload`, a dependência não existe. Isso resolve o grafo, mas ainda não gera imports,
configura DI, remove dependências do artefato ou permite ativar módulos em runtime.

Consumidores que precisam conhecer funcionalidades devem usar `result.modules`,
por exemplo `result.modules.find(({ id }) => id === 'module/media')?.enabledFeatures`.
Isso evita tentar reconstruir a seleção a partir dos bindings: funcionalidades
podem não introduzir dependências. A API pública permanece no major 1 experimental;
fixtures que constroem `ResolvedComposition` devem incluir a nova lista obrigatória
`modules`. Essa evolução não representa um lockfile nem um gerador de build.

Falhas retornam `CompositionError` com `code` estável. O chamador deve interromper
a composição, sem recuperar o erro habilitando um provider arbitrário.

## Catálogo, perfil e gerador

- `native-catalog.ts` lista os descriptors nativos (por exemplo `native/http-security`). É metadata pura, sem Nest. O fornecedor de `access-token` é a extensão `ext/jwt-auth` (`@devtrack/jwt-auth`).
- Módulos que expõem operações protegidas declaram `requires: [{ id: 'authenticator', major: 1 }]`. Sem um provider de `authenticator` na composição, a resolução falha com `MISSING_PROVIDER`.
- O perfil `config/composition.yaml` é lido e validado em `src/core/infrastructure/composition/`, fora de Application. O leitor não conhece segredos e recusa chaves com nomes de segredo.
- `npm run compose` gera `src/composition/composition.generated.ts`. Detalhes em `docs/core-contracts.md`, seções 6.6 a 6.8.
