/* eslint-disable @typescript-eslint/no-require-imports */
// Processo filho do teste de recuperação da auditoria. Modos:
//   no-otel           : nenhuma instrumentação OTel é carregada.
//   otel-unreachable  : OTel inicializado, exportando para um Collector inalcançável.
// Grava uma operação de negócio com auditoria no mesmo UnitOfWork e imprime um JSON
// com o estado observado. Configuração chega por variáveis de ambiente AUDIT_CHILD_*.
import type { OperationSignals } from '../../src/core/application/observability/signal-contracts';

const mode = process.env.AUDIT_CHILD_MODE;
const correlationId = process.env.AUDIT_CHILD_CORRELATION_ID as string;
const noteId = process.env.AUDIT_CHILD_NOTE_ID as string;

if (mode === 'otel-unreachable') {
  require('../../src/native/opentelemetry/bootstrap');
}

const isOtelLoaded = (): boolean =>
  Object.keys(require.cache).some((key) =>
    /[\\/]node_modules[\\/]@opentelemetry[\\/]/.test(key),
  );

async function main(): Promise<void> {
  const {
    buildPersistenceCatalog,
    createMigrationDataSource,
    TypeOrmUnitOfWork,
  } =
    require('../../src/native/persistence-typeorm') as typeof import('../../src/native/persistence-typeorm');
  const { TypeOrmAuditWriter } =
    require('../../src/native/persistence-typeorm/audit') as typeof import('../../src/native/persistence-typeorm/audit');
  const { AuditFixtureNoteOrmEntity } =
    require('./audit-business') as typeof import('./audit-business');
  const { AUDIT_TEST_CONTRIBUTIONS } =
    require('./audit-catalog') as typeof import('./audit-catalog');
  const { createNoopOperationSignals } =
    require('../../src/core/application/observability/operation-signals') as typeof import('../../src/core/application/observability/operation-signals');

  const catalog = buildPersistenceCatalog(AUDIT_TEST_CONTRIBUTIONS);
  const dataSource = createMigrationDataSource(catalog, {
    host: process.env.AUDIT_CHILD_HOST as string,
    port: Number(process.env.AUDIT_CHILD_PORT),
    database: process.env.AUDIT_CHILD_DATABASE as string,
    username: process.env.AUDIT_CHILD_USER as string,
    password: process.env.AUDIT_CHILD_PASSWORD as string,
    applicationName: 'audit-recovery-child',
    poolMax: 1,
  });
  await dataSource.initialize();

  const signals: OperationSignals =
    mode === 'otel-unreachable'
      ? (
          require('../../src/native/opentelemetry') as typeof import('../../src/native/opentelemetry')
        ).createOpenTelemetryOperationSignals()
      : createNoopOperationSignals();

  const uow = new TypeOrmUnitOfWork(dataSource, (manager) => ({
    notes: manager.getRepository(AuditFixtureNoteOrmEntity),
    audit: new TypeOrmAuditWriter(manager),
  }));

  await signals.runActivity({ name: 'contacts.create' }, () =>
    uow.run(async ({ notes, audit }) => {
      await notes.insert({ id: noteId, body: 'child note' });
      await audit.append({
        id: `audit-${noteId}`,
        occurredAt: Date.UTC(2026, 10, 9, 12),
        context: {
          subjectId: 'subject-child',
          tenantId: 'tenant-recovery',
          correlationId,
        },
        action: 'contacts.create',
        target: `notes/${noteId}`,
        outcome: 'succeeded',
      });
    }),
  );
  await dataSource.destroy();

  if (mode === 'otel-unreachable') {
    // Tempo para o exportador tentar e falhar contra o endpoint inalcançável.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  process.stdout.write(
    `${JSON.stringify({ mode, otelLoaded: isOtelLoaded(), committed: true })}\n`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`audit-recovery-child failed: ${message}\n`);
  process.exit(1);
});
