# Persistência TypeORM (`native/persistence-typeorm`)

Adapter técnico nativo que a Foundation oferece para persistência relacional em PostgreSQL. A Foundation fornece a conexão (um DataSource único), o catálogo de entidades e migrations, e a unidade de trabalho transacional. Cada módulo continua dono das suas entidades `*.orm-entity.ts`, migrations, mappers e repositórios.

Subpath de importação: `./native/persistence-typeorm` (ver integração no `package.json#exports` pelo integrador).

## Catálogo de persistência

Cada módulo declara sua contribuição por import estático. Não há varredura de disco.

```ts
export const CONTACTS_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'contacts',
  entities: [ContactOrmEntity],
  migrations: [CreateContacts1700000000001],
};
```

`buildPersistenceCatalog(contributions)` valida e congela o catálogo. Falhas lançam `PersistenceError` com código estável:

| Código | Quando |
| --- | --- |
| `PERSISTENCE_DUPLICATE_MODULE_ID` | `moduleId` repetido. |
| `PERSISTENCE_DUPLICATE_TABLE` | Mesma tabela declarada por dois módulos ou duas entidades. |
| `PERSISTENCE_DUPLICATE_ENTITY` | Mesma classe de entidade registrada duas vezes. |
| `PERSISTENCE_DUPLICATE_MIGRATION` | Mesma classe de migration registrada duas vezes. |
| `PERSISTENCE_DUPLICATE_MIGRATION_NAME` | Duas classes diferentes com o mesmo nome de migration. |
| `PERSISTENCE_INVALID_ENTITY` | Classe sem `@Entity`. |
| `PERSISTENCE_INVALID_MIGRATION` | Migration sem `up`/`down` ou sem timestamp de 13 dígitos no nome. |
| `PERSISTENCE_INVALID_CONTRIBUTION` | `moduleId` vazio ou listas malformadas. |

Migrations seguem a convenção do TypeORM: o nome termina em timestamp de 13 dígitos (ex.: `CreateContacts1700000000001`).

## Configuração

`FOUNDATION_DB_*` (lidas por `persistenceConfigFromEnv`) ou um objeto passado pelo host:

- `host`, `port`, `database`, `username`, `password`, `applicationName` (obrigatórios; `applicationName` com até 63 caracteres).
- `poolMax` (padrão 10, inteiro entre 1 e 100; fora disso: `PERSISTENCE_INVALID_POOL_SIZE`).
- `connectTimeoutMs` (padrão 5000), `statementTimeoutMs` (padrão 30000).
- `ssl` (padrão false), `migrationsRun` (padrão false, opt-in).

Não existe campo para ligar `synchronize`. Valor `true` lança `PERSISTENCE_SYNCHRONIZE_FORBIDDEN`. O DataSource é sempre criado com `synchronize: false`, `dropSchema: false` e `migrationsRun: false`. Senha nunca aparece em mensagem de erro. Credenciais não vão no perfil de composição.

## Módulo Nest

```ts
PersistenceTypeOrmModule.register({ contributions: CONTACTS_PERSISTENCE_LIST, config })
PersistenceTypeOrmModule.registerAsync({ imports, inject, useFactory: (...) => ({ contributions, config }) })
```

- Catálogo e configuração são validados já em `register` (ou na factory de `registerAsync`); configuração inválida impede o boot.
- Token do DataSource: `PERSISTENCE_DATA_SOURCE`.
- Boot: inicializa o DataSource e, se `migrationsRun` for true, aplica migrations pendentes numa única transação. Falha nas migrations fecha o DataSource e propaga o erro.
- Shutdown (`app.close()`): destrói o DataSource e fecha o pool.

## UnitOfWork

```ts
const uow = new TypeOrmUnitOfWork(dataSource, (manager) => ({
  contacts: new ContactRepository(manager),
  notes: new NoteRepository(manager),
}));

await uow.run(async ({ contacts, notes }) => {
  await contacts.save(...);
  await notes.save(...);
});
```

- `run` abre uma transação, entrega os recursos construídos a partir do `EntityManager` transacional e confirma ou desfaz tudo junto.
- O use case recebe só os recursos. Não vê `EntityManager`.
- Chamar `run` de dentro de um `work` do mesmo DataSource lança `PERSISTENCE_NESTED_TRANSACTION`.
- Regra: o `work` faz apenas operações de banco pelos recursos recebidos. Não chame rede, HTTP, filas nem serviços externos dentro dele, porque a transação fica aberta durante o trabalho. Efeitos externos ficam depois do `run`, ou em outbox dentro da mesma transação.

## Bases técnicas

Ficam no adapter, sem Domain artificial:

- `TypeOrmRepositoryBase<Entity>`: recebe o `EntityManager` e expõe `repository` do tipo da entidade.
- `TechnicalAuditColumns`: colunas `created_at`, `updated_at` (timestamptz) e `version` (controle otimista). Herde nas entidades do módulo.
- `PersistenceMapper<Model, Record>`: interface de mapeamento `toRecord` / `toModel`, implementada por cada módulo.

## CLI do TypeORM

`data-source.cli.ts` exporta o DataSource padrão a partir de `PERSISTENCE_CONTRIBUTIONS` e da mesma fábrica do runtime (`createMigrationDataSource`):

```sh
typeorm migration:run -d dist/native/persistence-typeorm/data-source.cli.js
```

Configuração pelas variáveis `FOUNDATION_DB_*`. Sem elas, a importação falha com `PERSISTENCE_INVALID_CONFIG`.

O host deve manter uma única lista de contribuições. O runtime e a CLI devem receber a mesma `PERSISTENCE_CONTRIBUTIONS`. Os testes em `migration-data-source.spec.ts` comparam as opções e as listas de entidades e migrations das duas formas de criação.

## Remoção de módulo

Remover um módulo do catálogo não apaga tabelas nem o histórico da tabela `migrations`, e não executa rollback de schema. Purge de dados é uma operação separada. Coberto por `test/persistence.e2e-spec.ts`.

## Testes

- Unitários (`src/native/persistence-typeorm/*.spec.ts`): duplicidades, migration sem timestamp, `synchronize` ligado, pool inválido, variáveis de ambiente, paridade CLI/runtime.
- Integração (`test/persistence.e2e-spec.ts`): PostgreSQL 16 via `@testcontainers/postgresql`. Cobre criação de tabelas só por migrations, commit e rollback de dois repositórios, aninhamento rejeitado, remoção de módulo preservando dados e histórico, e fechamento do pool no shutdown. Se o Docker não responder, o teste falha com mensagem explícita e não é pulado.

Execução: `npm run test:e2e -- --runInBand` (exige Docker ativo).

## Fora do escopo desta entrega

- Adapters de repositório concretos de Contacts (tarefa 6.x).
- Outbox e idempotência (tarefa 4.x).
- Migração de dados entre versões de banco.
