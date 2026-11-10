# Parecer — revisão de `docs/core-contracts.md`

- **Data:** 08/11/2026
- **Objeto:** versão "Core e contratos — etapa 1" de [`../core-contracts.md`](../core-contracts.md), comparada com o código de `foundation-api/src` no mesmo dia.
- **Natureza:** revisão documental feita por agente (Claude), lendo o documento, os contratos, os serviços, o resolvedor, o módulo Nest, o gate de fronteiras e os testes. Não é validação de segurança, aceite humano nem evidência de execução; os testes não foram reexecutados nesta revisão.
- **Resultado:** o documento foi reescrito no mesmo dia. A coluna "Disposição" indica onde cada ponto foi tratado na nova versão.

## 1. Veredito

O documento era **fiel ao código no que afirmava**: nenhuma afirmação falsa foi encontrada. Era também honesto sobre os limites (não prometia tempo constante, transação distribuída nem integração real).

O problema estava no **escopo e na organização**. O título prometia "core e contratos", mas o texto cobria só composição e autenticação. Ele misturava referência estável, política de segurança e runbook de passagem de contexto. Na prática, funcionava como anexo do resumo operacional, e não como referência dos contratos.

## 2. Afirmações conferidas e corretas

| Afirmação | Evidência no código |
| --- | --- |
| Sessão pendente → emissão → conferência de prazos → ativação → nova conferência; falha revoga e nunca devolve token, mesmo se a revogação falhar. | [`authentication.service.ts:104-150`](../../src/core/application/security/authentication.service.ts); há testes para revogação que falha e para expiração durante a ativação. |
| Limites de 1–256 / 1–4096 em unidades UTF-16, hash fictício obrigatório, senha sem trim. | [`password-credentials.service.ts`](../../src/core/application/security/password-credentials.service.ts) |
| Provider desconhecido, callback rejeitado ou vínculo ausente resultam em `invalid_credentials`. | `authentication.service.spec.ts`, caso parametrizado com `unknown-provider`. |
| Subpaths `./contracts` e `./nest`; símbolos `Symbol.for('foundation.api.v1.*')`; fachada sem carregar Nest. | `package.json#exports`, [`authentication.tokens.ts`](../../src/core/application/security/authentication.tokens.ts), `test/contracts/public-entrypoint.test.cjs`. |

## 3. Problemas encontrados

### Alta prioridade

| # | Problema | Disposição |
| --- | --- | --- |
| A1 | Metade da superfície pública sem documentação: `SessionReader`, `OperationContext`, `UnitOfWork`, `AuditWriter`/`AuditEntry`, `JobEnvelope`, `Clock` e `AccessTokenVerifier` eram exportados por [`contracts/index.ts`](../../src/contracts/index.ts), mas só apareciam de passagem. | §5, catálogo com papel, garantias e status. |
| A2 | Sem política de versionamento: não definia breaking change, relação entre `FOUNDATION_API_MAJOR` e o namespace `v1`, depreciação nem convivência de majors. | §4, separando fatos do código de uma **política proposta**, pendente de aprovação na tarefa 1.1. |
| A3 | Códigos de erro e regra de identificadores da composição incompletos: omitia `INVALID_DESCRIPTOR`, `UNKNOWN_FEATURE` e `INVALID_BINDING`, não explicava `INCOMPATIBLE_CAPABILITY` × `MISSING_PROVIDER` e não citava a regex de [`resolve-composition.ts:11`](../../src/core/application/modules/resolve-composition.ts). | §6.2 e §6.3. |

### Média prioridade

| # | Problema | Disposição |
| --- | --- | --- |
| M1 | Sem exemplo de `withAuthentication` e sem aviso de que chamá-lo em vários módulos pode criar instâncias distintas do serviço. | §7.7, exemplo compilado e regra de composition root único. |
| M2 | Erros sem semântica de transporte. `beginFederatedLogin` com `redirectId` ou `clientBinding` vazio retorna `invalid_credentials` ([`authentication.service.ts:66`](../../src/core/application/security/authentication.service.ts)), embora seja requisição malformada. | §7.5, tabela com tradução esperada (401/503); decisão em aberto no §10. |
| M3 | A seção "Federação futura" misturava portas entregues com adapter pendente. | §7.4, em "entregue no core / obrigações do adapter / pendente". |
| M4 | "`jwt-auth` implementará" podia ser lido como o scaffold irmão na raiz, e não como a capacidade nativa. | §7.2 distingue `native/jwt-auth` do scaffold `jwt-auth/`. |
| M5 | "`AppModule` importa a base" sugeria registro de algo; sem `withAuthentication`, o módulo é vazio. | §7.7. |

### Baixa prioridade

| # | Problema | Disposição |
| --- | --- | --- |
| B1 | Árvore de "Estrutura entregue" omitia `app.controller.ts`, `app.service.ts`, `scripts/check-boundaries.test.mjs` e `test/app.e2e-spec.ts`. | §9. |
| B2 | Diagrama Mermaid só com o caminho feliz; a compensação, ponto forte do desenho, não aparecia. | §7.1, `sequenceDiagram` com ramo de revogação (sintaxe validada). |
| B3 | Conteúdo efêmero: título "etapa 1", rollback citando snapshot/commit inexistente, estado sem baseline Git, versões de Node/npm. | Removido; o documento aponta para `validation.md` e `incorporation-plan.md`. |

## 4. Observações de código

Pontos do código que o documento passou a registrar ou que pedem decisão. Nenhum foi alterado no código.

| # | Observação | Disposição |
| --- | --- | --- |
| C1 | `ResolvedComposition` não carrega `enabledFeatures`, de que o futuro gerador estático (tarefa 2.1) vai precisar. | §6.5 e §10. |
| C2 | `AuditEntry.context` guarda o `OperationContext` completo, inclusive `principal.permissions`, o que tende a reter dados demais. | §10, projeção mínima a definir antes da tarefa 3.5. |
| C3 | `useFactory: (...args: never[])` em [`foundation-core.module.ts:17`](../../src/core/infrastructure/modules/foundation-core.module.ts) não confere tipos entre `inject` e os parâmetros da factory. | §7.7, como regra do composition root. |
| C4 | Se `createPending` devolver `id` vazio, o core nega o login mas chama `revoke('')`. | §5.2 (garantia do adapter), §7.1 (comportamento) e §10 (decisão). |

## 5. Pendências após a reescrita

- Aprovar ou ajustar a política de versão do §4 (tarefa 1.1).
- Decidir os itens da tabela do §10 de `core-contracts.md`.
- Os exemplos de código foram compilados com `tsc` em modo strict contra o pacote local, numa pasta temporária. Isso não substitui um teste de documentação no CI: se a API mudar, os exemplos podem ficar desatualizados sem que nada acuse.
