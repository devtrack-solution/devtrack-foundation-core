# Capacidades nativas

Adapters técnicos que a Foundation distribui. Cada nativo entra na composição gerada e no artefato só quando o perfil (`config/composition.yaml`) ou o host o seleciona. O catálogo de descriptors fica em `src/core/application/modules/native-catalog.ts`, e o contrato completo está em `docs/core-contracts.md`, seção 6.7.

## Implementados

- **jwt-auth** (`src/native/jwt-auth/`, entrypoint `foundation-api/native/jwt-auth`): adapter de `AccessTokenIssuer` e `AccessTokenVerifier` sobre `jose@5.10.0`. Política de algoritmos (EdDSA e ES256), chaves por `kid` com rotação, claims mínimas, verificação fechada e configuração validada no boot. Registro via `JwtAuthModule.register` ou `registerAsync`, com tokens `JWT_AUTH_ISSUER` e `JWT_AUTH_VERIFIER`. Provê `access-token` major 1. Detalhes em `docs/core-contracts.md`, seção 7.2.1.
- **swagger-adapter** (`src/native/swagger-adapter/`, entrypoint `foundation-api/native/swagger-adapter`): documentação OpenAPI sobre `@nestjs/swagger@11.4.8` (versão exata). Expõe `/docs` e `/docs-json` somente quando selecionado; título, versão e caminho vêm do host pelo token `swaggerOptions`. Traduz o contrato neutro `defineDtoSchema` (Application, exportado por `foundation-api/contracts`), que módulos de negócio usam sem importar Swagger. Provê `api-documentation` major 1. Detalhes em `docs/core-contracts.md`, seção 6.9.
- **opentelemetry** (`src/native/opentelemetry/`, entrypoint `foundation-api/native/opentelemetry`): SDK único do processo sobre `@opentelemetry/sdk-node@0.301.0` (versões exatas, ver `docs/core-contracts.md`, seção 8). Provê `telemetry` major 1. Identidade do host por `FOUNDATION_SERVICE_NAME`, `FOUNDATION_SERVICE_VERSION` e `FOUNDATION_DEPLOYMENT_ENVIRONMENT`; exportação OTLP/HTTP por `OTEL_EXPORTER_OTLP_ENDPOINT`; filas e prazos com limites explícitos. É inicializado antes de qualquer outro módulo pelo arquivo gerado `src/composition/instrumentation.generated.ts`, importado na primeira linha de `src/main.ts`. Não monta módulo Nest. Implementa as portas neutras de `core/application/observability/`.
- **aws-s3** (`src/native/aws-s3/`, entrypoint `foundation-api/native/aws-s3`): adapter de `ObjectStorage` sobre `@aws-sdk/client-s3`. `AwsS3Module.registerAsync` recebe as opções do host pelo token `awsS3Options`; credenciais vêm da cadeia padrão do SDK, nunca da configuração. Provê `object-storage` major 1, com o token `AWS_S3_OBJECT_STORAGE`. Selecionável pelo perfil.
- **persistence-typeorm** (`src/native/persistence-typeorm/`, entrypoint `foundation-api/native/persistence-typeorm`): `DataSource` único do PostgreSQL, `TypeOrmUnitOfWork`, catálogo de contribuições (`PERSISTENCE_CONTRIBUTIONS`) e as implementações TypeORM de auditoria, idempotência e sessões, reexportadas pelo barrel. Provê `persistence` major 1, com a configuração de conexão vinda do host pelo token `persistenceOptions`. Selecionável pelo perfil. Detalhes em `docs/persistence.md`, `docs/audit.md`, `docs/idempotency.md` e `docs/sessions.md`.
- **cache-redis** (`src/native/cache-redis/`, entrypoint `foundation-api/native/cache-redis`): rate limit compartilhado (`SHARED_RATE_LIMITER`) e readiness (`REDIS_READINESS_CHECK`) sobre `ioredis`. `CacheRedisModule.registerAsync` recebe a configuração do host pelo token `cacheRedisOptions`; `register` continua síncrono, para uso manual em `FoundationCoreModule.withAdmission`. Provê `shared-rate-limit` major 1, com o token `SHARED_RATE_LIMITER`. Selecionável pelo perfil. Detalhes em `docs/admission.md`.

## Em desenvolvimento

- **queue-bullmq** (`src/native/queue-bullmq/`): código de adapter presente, mas fora de `package.json#exports` e do catálogo de composição.

## Pendente

- opentelemetry: Collector real, logs OTel e amostragem por tipo de rota (ver `docs/core-contracts.md`, seção 8.5).
- Adapter real de hash de senha e store de credenciais (portas sem implementação).
- Provedor federado concreto (OIDC/OAuth). Módulos federados poderão fornecer `FederatedIdentityProvider`.

Contacts permanece externo e não foi construído.
