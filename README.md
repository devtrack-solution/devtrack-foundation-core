# Foundation API

Core modular em NestJS. Primeira etapa: contratos públicos, resolução de capacidades, fronteiras de imports e coordenação de autenticação por senha ou federação, independente do formato do token.

A [estrutura e os fluxos de credenciais](docs/core-contracts.md) distinguem implementação entregue, obrigações dos adapters e próximas etapas. Contacts não foi implementado. JWT, OAuth real, persistência de sessões e endpoints de login ainda não estão habilitados.

```sh
npm ci
npm run typecheck
npm run lint:check
npm test -- --runInBand
npm run test:boundaries
npm run test:contracts
npm run test:e2e -- --runInBand
```

O build executa o gate de arquitetura. Contratos são acessíveis por `foundation-api/contracts`; integração Nest por `foundation-api/nest`. O pacote permanece privado e experimental; não foi publicado no npm.
