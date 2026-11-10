#!/usr/bin/env bash
# Ensaio operacional isolado da Foundation (tarefa 7.4 de define-native-foundation-operational-core).
#
# Executa, num diretório temporário próprio, os passos do docs/operations.md que são
# ensaiáveis localmente:
#   1. copia a Foundation (sem node_modules do host como fonte de verdade: usa clone do node_modules);
#   2. perfil com native/persistence-typeorm, npm run compose (+ --check);
#   3. npm run build:artifact e instalação do lock gerado (npm ci --omit=dev);
#   4. PostgreSQL 16 num contêiner criado por ESTE script, com nome único;
#   5. migrations pela CLI do TypeORM (sem synchronize);
#   6. sobe a API compilada (dist/main.js), checa /health/live e /health/ready;
#   7. SIGTERM e verificação de saída ordenada (código 0 e linha de encerramento);
#   8. rollback da última migration (down) e reaplicação;
#   9. sobe a API de novo e confere health após reaplicação.
#
# Limpeza: o trap remove SOMENTE o contêiner criado aqui (pelo nome gerado), encerra o
# processo da API iniciado aqui e apaga o diretório temporário (exceto com KEEP_WORK=1).
# Nunca executa docker rm genérico, docker system prune nem toca em outros contêineres.
#
# Uso: scripts/rehearse-operations.sh   (exit 0 = todos os passos ensaiados passaram)
# Pré-requisitos: Node 24, npm 11, Docker ativo, curl, rede para o registry npm (lock).

set -euo pipefail

FOUNDATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +%s)-$$-$RANDOM"
CONTAINER_NAME="foundation-rehearsal-pg-${RUN_ID}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/foundation-rehearsal.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
APP_DIR="$WORK/foundation"
ARTIFACT_DIR="$WORK/artifact"
LOG_DIR="$WORK/logs"
PG_IMAGE="${REHEARSAL_PG_IMAGE:-postgres:16-alpine}"
DB_NAME="foundation"
DB_USER="foundation"
DB_PASSWORD="rehearsal-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
DB_CREATED=0
API_PID=""
CONTAINER_CREATED=0
LAST_MIGRATION="CreateInboxMessages1794691200000"
MIGRATION_CLI=""

mkdir -p "$LOG_DIR"

step() { printf '\n== [ensaio] %s\n' "$*"; }
ok()   { printf '   ok: %s\n' "$*"; }
fail() { printf '   FALHA: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local code=$?
  set +e
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null
    wait "$API_PID" 2>/dev/null
  fi
  if [[ "$CONTAINER_CREATED" == "1" ]]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
    if docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      echo "   AVISO: contêiner $CONTAINER_NAME ainda existe" >&2
      code=1
    else
      echo "== [ensaio] contêiner $CONTAINER_NAME removido"
    fi
  fi
  if [[ "${KEEP_WORK:-0}" == "1" ]]; then
    echo "== [ensaio] diretório mantido por KEEP_WORK=1: $WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

wait_for_http() { # url expected_status timeout_s
  local url="$1" expected="$2" timeout="$3" code=""
  for _ in $(seq 1 "$timeout"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    [[ "$code" == "$expected" ]] && return 0
    sleep 1
  done
  echo "   último status observado em $url: ${code:-sem resposta}" >&2
  return 1
}

start_api() { # log_file
  local log="$1" port
  port="$(free_port)"
  API_PORT="$port"
  (cd "$ARTIFACT_DIR" && PORT="$port" \
    FOUNDATION_DB_HOST=127.0.0.1 \
    FOUNDATION_DB_PORT="$DB_PORT" \
    FOUNDATION_DB_NAME="$DB_NAME" \
    FOUNDATION_DB_USER="$DB_USER" \
    FOUNDATION_DB_PASSWORD="$DB_PASSWORD" \
    FOUNDATION_DB_APPLICATION_NAME=foundation-rehearsal \
    FOUNDATION_DB_MIGRATIONS_RUN=false \
    exec node dist/main.js) >"$log" 2>&1 &
  API_PID=$!
}

api_pg_connections() {
  psql_q "select count(*) from pg_stat_activity where application_name='foundation-rehearsal'"
}

# Envia SIGTERM e mede: código de saída e conexões da API no PostgreSQL antes e depois.
# O Nest (enableShutdownHooks) executa beforeApplicationShutdown/onModuleDestroy, fecha o
# pool do DataSource e só então reemite o sinal ao próprio processo: código 143 = 128+15.
stop_api_sigterm() {
  local started=$SECONDS before after waited=0
  before="$(api_pg_connections)"
  kill -TERM "$API_PID"
  set +e
  wait "$API_PID"
  API_EXIT=$?
  set -e
  API_PID=""
  after="$(api_pg_connections)"
  while [[ "$after" != "0" && $waited -lt 10 ]]; do
    sleep 1; waited=$((waited + 1)); after="$(api_pg_connections)"
  done
  API_CONN_BEFORE="$before"
  API_CONN_AFTER="$after"
  echo "   API encerrada por SIGTERM: código $API_EXIT em $((SECONDS - started))s; conexões no PostgreSQL antes=$before depois=$after"
}

run_migration_cli() { # subcommand
  (cd "$ARTIFACT_DIR" && \
    FOUNDATION_DB_HOST=127.0.0.1 \
    FOUNDATION_DB_PORT="$DB_PORT" \
    FOUNDATION_DB_NAME="$DB_NAME" \
    FOUNDATION_DB_USER="$DB_USER" \
    FOUNDATION_DB_PASSWORD="$DB_PASSWORD" \
    FOUNDATION_DB_APPLICATION_NAME=foundation-rehearsal \
    node "$MIGRATION_CLI" "$1" -d dist/native/persistence-typeorm/data-source.cli.js)
}

psql_q() { # sql
  docker exec "$CONTAINER_NAME" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -tAc "$1"
}

# ---------------------------------------------------------------------------
step "1. Copia isolada da Foundation em $APP_DIR"
mkdir -p "$APP_DIR"
(cd "$FOUNDATION_DIR" && tar --exclude=./node_modules --exclude=./dist --exclude=./coverage -cf - .) \
  | (cd "$APP_DIR" && tar -xf -)
if cp -c -R "$FOUNDATION_DIR/node_modules" "$APP_DIR/node_modules" 2>/dev/null; then
  ok "node_modules clonado (copy-on-write)"
else
  cp -R "$FOUNDATION_DIR/node_modules" "$APP_DIR/node_modules"
  ok "node_modules copiado"
fi
ok "copia pronta sem .git e sem testes de contêiner"

# ---------------------------------------------------------------------------
step "2. Perfil de composição com native/persistence-typeorm"
cat > "$APP_DIR/config/composition.yaml" <<'YAML'
# Perfil do ensaio operacional. Sem segredos: credenciais vêm de FOUNDATION_DB_* em tempo de execução.
foundationApiMajor: 1
natives:
  - id: native/persistence-typeorm
extensions: []
YAML
ok "perfil escrito (natives: native/persistence-typeorm; extensions: [])"

# Host de ensaio: o módulo gerado exige o token `persistence.options` e a rota de saúde
# só existe com FoundationCoreModule.withAdmission. Este arquivo substitui app.module.ts
# SOMENTE na cópia descartável; o src/ do repositório não é alterado.
cat > "$APP_DIR/src/app.module.ts" <<'TS'
// Host de ensaio operacional (cópia descartável). Não faz parte do repositório.
import { Global, Module } from '@nestjs/common';
import { FoundationCoreModule } from './core/infrastructure/modules/foundation-core.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  COMPOSITION_HOST_TOKENS,
  GeneratedCompositionModule,
} from './composition/composition.generated';
import { persistenceConfigFromEnv } from './native/persistence-typeorm';

@Global()
@Module({
  providers: [
    {
      provide: COMPOSITION_HOST_TOKENS.persistenceOptions,
      useFactory: () => persistenceConfigFromEnv(process.env),
    },
  ],
  exports: [COMPOSITION_HOST_TOKENS.persistenceOptions],
})
class RehearsalHostTokensModule {}

@Module({
  imports: [
    FoundationCoreModule.withAdmission({
      admission: { maxInFlight: 64, maxQueue: 64, maxQueueWaitMs: 1000 },
    }),
    RehearsalHostTokensModule,
    GeneratedCompositionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
TS
ok "host de ensaio aplicado na cópia (token persistence.options e withAdmission)"

# ---------------------------------------------------------------------------
step "3. npm run compose (--check)"
(cd "$APP_DIR" && npm run compose) >"$LOG_DIR/compose.log" 2>&1 || { cat "$LOG_DIR/compose.log"; fail "npm run compose"; }
(cd "$APP_DIR" && npm run compose -- --check) >"$LOG_DIR/compose-check.log" 2>&1 || { cat "$LOG_DIR/compose-check.log"; fail "compose --check"; }
tail -n 1 "$LOG_DIR/compose-check.log" | sed 's/^/   /'
grep -q "PersistenceTypeOrmModule" "$APP_DIR/src/composition/composition.generated.ts" \
  || fail "composição gerada não contém PersistenceTypeOrmModule"
ok "composição gerada com PersistenceTypeOrmModule"

# ---------------------------------------------------------------------------
step "4. npm run build:artifact"
(cd "$APP_DIR" && npm run build:artifact -- --profile "$APP_DIR/config/composition.yaml" --out "$ARTIFACT_DIR") \
  >"$LOG_DIR/build-artifact.log" 2>&1 || { tail -n 60 "$LOG_DIR/build-artifact.log"; fail "build:artifact"; }
tail -n 3 "$LOG_DIR/build-artifact.log" | sed 's/^/   /'
for f in dist/main.js dist/native/persistence-typeorm/data-source.cli.js package.json package-lock.json artifact-inventory.json; do
  [[ -f "$ARTIFACT_DIR/$f" ]] || fail "artefato sem $f"
done
ok "artefato com dist/, package.json, package-lock.json e artifact-inventory.json"
grep -q '"native/persistence-typeorm"' "$ARTIFACT_DIR/artifact-inventory.json" && ok "inventário lista native/persistence-typeorm"

step "4b. Instalação de runtime a partir do lock do artefato (npm ci --omit=dev)"
(cd "$ARTIFACT_DIR" && npm ci --omit=dev --ignore-scripts --allow-scripts= --no-audit --no-fund) \
  >"$LOG_DIR/npm-ci.log" 2>&1 || { tail -n 60 "$LOG_DIR/npm-ci.log"; fail "npm ci do artefato"; }
ok "dependências de runtime instaladas do lock"
[[ -f "$ARTIFACT_DIR/node_modules/typeorm/cli.js" ]] || fail "typeorm CLI ausente no artefato"
MIGRATION_CLI="$ARTIFACT_DIR/node_modules/typeorm/cli.js"
if [[ -e "$ARTIFACT_DIR/node_modules/prettier" || -e "$ARTIFACT_DIR/node_modules/typescript" ]]; then
  fail "tooling (prettier/typescript) presente no node_modules do artefato"
fi
ok "tooling (prettier, typescript, ts-node) ausente do artefato"

# ---------------------------------------------------------------------------
step "5. PostgreSQL 16 em contêiner criado por este script ($CONTAINER_NAME)"
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -p 127.0.0.1::5432 "$PG_IMAGE" >"$LOG_DIR/docker-run.log"
CONTAINER_CREATED=1
DB_PORT="$(docker port "$CONTAINER_NAME" 5432/tcp | head -n 1 | sed 's/.*://')"
ok "contêiner criado, porta do host $DB_PORT"
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER_NAME" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1; then
    DB_CREATED=1
    break
  fi
  sleep 1
done
[[ "$DB_CREATED" == "1" ]] || fail "PostgreSQL não respondeu em 90s"
ok "PostgreSQL aceitando conexões TCP"

# ---------------------------------------------------------------------------
step "6. Migrations pela CLI do TypeORM (sem synchronize)"
run_migration_cli migration:run >"$LOG_DIR/migration-run.log" 2>&1 || { cat "$LOG_DIR/migration-run.log"; fail "migration:run"; }
{ grep -E "has been executed successfully|No migrations are pending" "$LOG_DIR/migration-run.log" || true; } | sed 's/^/   /' | head -n 10
APPLIED="$(psql_q 'select count(*) from migrations')"
[[ "$APPLIED" == "7" ]] || fail "esperadas 7 migrations registradas, obtidas $APPLIED"
ok "7 migrations registradas em \"migrations\""
TABLES="$(psql_q "select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema='public'")"
ok "tabelas: $TABLES"

# ---------------------------------------------------------------------------
step "7. Sobe a API compilada (dist/main.js) e checa saúde"
API_LOG="$LOG_DIR/api-1.log"
start_api "$API_LOG"
wait_for_http "http://127.0.0.1:$API_PORT/health/live" 200 60 || { cat "$API_LOG"; fail "/health/live não retornou 200"; }
ok "GET /health/live = 200"
wait_for_http "http://127.0.0.1:$API_PORT/health/ready" 200 30 || { cat "$API_LOG"; fail "/health/ready não retornou 200"; }
ok "GET /health/ready = 200 ($(curl -s "http://127.0.0.1:$API_PORT/health/ready"))"
ROOT_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/")"
ok "GET / = $ROOT_CODE"

# ---------------------------------------------------------------------------
step "8. Encerramento ordenado por SIGTERM"
stop_api_sigterm "$API_LOG"
# 143 = processo encerrado pelo SIGTERM reemitido pelo Nest após o close ordenado (ver função acima).
[[ "$API_EXIT" == "143" || "$API_EXIT" == "0" ]] || { cat "$API_LOG"; fail "código de saída inesperado após SIGTERM: $API_EXIT"; }
[[ "${API_CONN_BEFORE:-0}" -ge 1 ]] || fail "API sem conexões no PostgreSQL antes do SIGTERM"
[[ "$API_CONN_AFTER" == "0" ]] || fail "pool da API ainda aberto após SIGTERM ($API_CONN_AFTER conexões)"
ok "código $API_EXIT (encerramento pelo sinal após close ordenado); pool fechado ($API_CONN_BEFORE -> 0 conexões)"
if grep -qi "error" "$API_LOG"; then
  echo "   linhas de erro no log da API:"; grep -i "error" "$API_LOG" | head -n 5 | sed 's/^/     /'
  fail "log da API contém erro durante encerramento"
fi
ok "sem erro no log da API"

# ---------------------------------------------------------------------------
step "9. Rollback da última migration ($LAST_MIGRATION) e reaplicação"
run_migration_cli migration:revert >"$LOG_DIR/migration-revert.log" 2>&1 || { cat "$LOG_DIR/migration-revert.log"; fail "migration:revert"; }
{ grep -E "reverted successfully" "$LOG_DIR/migration-revert.log" || true; } | sed 's/^/   /' | head -n 2
psql_q "select count(*) from migrations where name='$LAST_MIGRATION'" | grep -qx "0" || fail "migration revertida continua registrada"
[[ "$(psql_q "select count(*) from information_schema.tables where table_schema='public' and table_name='inbox_messages'")" == "0" ]] \
  || fail "tabela inbox_messages não foi removida pelo down"
ok "down removeu inbox_messages e o registro de $LAST_MIGRATION"
run_migration_cli migration:run >"$LOG_DIR/migration-rerun.log" 2>&1 || { cat "$LOG_DIR/migration-rerun.log"; fail "reaplicação de migration:run"; }
[[ "$(psql_q 'select count(*) from migrations')" == "7" ]] || fail "reaplicação não restaurou 7 migrations"
[[ "$(psql_q "select count(*) from information_schema.tables where table_schema='public' and table_name='inbox_messages'")" == "1" ]] \
  || fail "inbox_messages não voltou após reaplicação"
ok "reaplicação restaurou as 7 migrations e a tabela inbox_messages"

# ---------------------------------------------------------------------------
step "10. Sobe a API após reaplicação e confere saúde"
API_LOG="$LOG_DIR/api-2.log"
start_api "$API_LOG"
wait_for_http "http://127.0.0.1:$API_PORT/health/ready" 200 60 || { cat "$API_LOG"; fail "/health/ready após reaplicação"; }
ok "GET /health/ready = 200 após rollback e reaplicação"
stop_api_sigterm "$API_LOG"
[[ "$API_EXIT" == "143" || "$API_EXIT" == "0" ]] || fail "segundo encerramento com código inesperado: $API_EXIT"
[[ "$API_CONN_AFTER" == "0" ]] || fail "pool da API aberto após o segundo SIGTERM"
ok "segundo encerramento ordenado (código $API_EXIT, pool fechado)"

# ---------------------------------------------------------------------------
step "11. Remoção do contêiner criado por este script"
docker rm -f "$CONTAINER_NAME" >/dev/null
CONTAINER_CREATED=0
if docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  fail "contêiner $CONTAINER_NAME ainda existe"
fi
ok "contêiner $CONTAINER_NAME removido"

echo
echo "== [ensaio] concluído com sucesso (exit 0)"
