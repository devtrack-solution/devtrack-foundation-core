import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';
import type { OperationContext } from '../src/core/application/context/operation-context';
import {
  AUDIT_READ_PERMISSION,
  readAuditTrail,
} from '../src/core/application/audit/audit-access';
import type { AuditEntry } from '../src/core/application/audit/audit-writer.port';
import { createAuditRetentionPolicy } from '../src/core/application/audit/audit-validation';
import {
  buildPersistenceCatalog,
  createMigrationDataSource,
  TypeOrmUnitOfWork,
  type PersistenceCatalog,
} from '../src/native/persistence-typeorm';
import {
  AUDIT_ENTRIES_TABLE,
  TypeOrmAuditReader,
  TypeOrmAuditRetention,
  TypeOrmAuditWriter,
} from '../src/native/persistence-typeorm/audit';
import { AUDIT_TEST_CONTRIBUTIONS } from './fixtures/audit-catalog';
import { AuditFixtureNoteOrmEntity } from './fixtures/audit-business';

jest.setTimeout(300_000);

const ADMIN_PASSWORD = 'foundation-test-only';
const DATABASE = 'foundation_audit';
const DAY = 86_400_000;
/** Instante fixo dos testes; todas as entradas são relativas a ele. */
const NOW = Date.UTC(2026, 10, 9, 12);
const ROOT = path.resolve(__dirname, '..');
const TS_NODE = path.join(ROOT, 'node_modules/ts-node/register/transpile-only');
const CHILD = path.join(__dirname, 'fixtures', 'audit-recovery-child.ts');

let container: StartedPostgreSqlContainer;
let catalog: PersistenceCatalog;
let dataSource: DataSource;

async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(DATABASE)
      .withUsername('foundation')
      .withPassword(ADMIN_PASSWORD)
      .start();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker did not respond to Testcontainers (PostgreSQL 16). Make sure the Docker daemon is running. Cause: ${cause}`,
    );
  }
}

function auditorContext(
  tenantId: string | undefined,
  permissions: readonly string[] = [AUDIT_READ_PERMISSION],
): OperationContext {
  return {
    correlationId: 'corr-reader',
    deadlineAt: NOW + 60_000,
    principal: {
      subjectId: 'auditor-1',
      ...(tenantId === undefined ? {} : { tenantId }),
      permissions,
    },
  };
}

function entry(
  id: string,
  tenantId: string,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    id,
    occurredAt: NOW - DAY,
    context: {
      subjectId: 'subject-1',
      tenantId,
      correlationId: `corr-${id}`,
    },
    action: 'contacts.create',
    target: `contacts/${id}`,
    outcome: 'succeeded',
    ...overrides,
  };
}

async function count(tenantId: string): Promise<number> {
  const rows: { n: number }[] = await dataSource.query(
    `SELECT count(*)::int AS n FROM ${AUDIT_ENTRIES_TABLE} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0].n;
}

beforeAll(async () => {
  container = await startPostgres();
  catalog = buildPersistenceCatalog(AUDIT_TEST_CONTRIBUTIONS);
  const admin = createMigrationDataSource(catalog, {
    host: container.getHost(),
    port: container.getPort(),
    database: DATABASE,
    username: container.getUsername(),
    password: ADMIN_PASSWORD,
    applicationName: 'audit-admin',
    poolMax: 1,
  });
  await admin.initialize();
  await admin.runMigrations();
  await admin.destroy();

  dataSource = createMigrationDataSource(catalog, {
    host: container.getHost(),
    port: container.getPort(),
    database: DATABASE,
    username: container.getUsername(),
    password: ADMIN_PASSWORD,
    applicationName: 'audit-tests',
    poolMax: 4,
  });
  await dataSource.initialize();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
  await container?.stop();
});

describe('Auditoria durável (PostgreSQL 16)', () => {
  it('applies the audit migration through the catalog', async () => {
    const applied: { name: string }[] = await dataSource.query(
      'SELECT name FROM migrations ORDER BY timestamp, id',
    );
    expect(applied.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'CreateAuditEntries1794345600000',
        'CreateAuditFixtureNotes1794432000000',
      ]),
    );
  });

  it('appends entries and reads them back only inside the requesting tenant', async () => {
    const writer = new TypeOrmAuditWriter(dataSource.manager);
    await writer.append(entry('tenant-a-1', 'tenant-a'));
    await writer.append(entry('tenant-a-2', 'tenant-a'));
    await writer.append(entry('tenant-b-1', 'tenant-b'));

    const reader = new TypeOrmAuditReader(dataSource);
    const fromA = await readAuditTrail(reader, auditorContext('tenant-a'), {
      fromMs: NOW - 2 * DAY,
      toMs: NOW,
    });
    const fromB = await readAuditTrail(reader, auditorContext('tenant-b'), {
      fromMs: NOW - 2 * DAY,
      toMs: NOW,
    });

    expect(fromA.items.map((item) => item.id).sort()).toEqual([
      'tenant-a-1',
      'tenant-a-2',
    ]);
    expect(fromB.items.map((item) => item.id)).toEqual(['tenant-b-1']);
    expect(fromA.items[0].context.tenantId).toBe('tenant-a');
    expect(fromA.items[0].occurredAt).toBe(NOW - DAY);
  });

  it('filters by time range and action, and limits pages', async () => {
    const writer = new TypeOrmAuditWriter(dataSource.manager);
    const tenant = 'tenant-filter';
    await writer.append(entry('f-old', tenant, { occurredAt: NOW - 5 * DAY }));
    await writer.append(entry('f-new', tenant, { occurredAt: NOW - 1000 }));
    await writer.append(
      entry('f-session', tenant, {
        action: 'session.revoke',
        target: 'sessions/9',
        occurredAt: NOW - 2000,
      }),
    );
    const reader = new TypeOrmAuditReader(dataSource);
    const context = auditorContext(tenant);

    const recent = await readAuditTrail(reader, context, {
      fromMs: NOW - DAY,
      toMs: NOW,
    });
    expect(recent.items.map((item) => item.id)).toEqual(['f-new', 'f-session']);

    const onlySessions = await readAuditTrail(reader, context, {
      fromMs: NOW - 10 * DAY,
      toMs: NOW,
      action: 'session.revoke',
    });
    expect(onlySessions.items.map((item) => item.id)).toEqual(['f-session']);

    const firstPage = await readAuditTrail(reader, context, {
      fromMs: NOW - 10 * DAY,
      toMs: NOW,
      limit: 1,
    });
    const secondPage = await readAuditTrail(reader, context, {
      fromMs: NOW - 10 * DAY,
      toMs: NOW,
      limit: 1,
      offset: 1,
    });
    expect(firstPage.items.map((item) => item.id)).toEqual(['f-new']);
    expect(secondPage.items.map((item) => item.id)).toEqual(['f-session']);
  });

  it('denies a reader without audit:read or without tenant', async () => {
    const reader = new TypeOrmAuditReader(dataSource);
    await expect(
      readAuditTrail(reader, auditorContext('tenant-a', ['contacts:write']), {
        fromMs: 0,
        toMs: NOW,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      readAuditTrail(reader, auditorContext(undefined), {
        fromMs: 0,
        toMs: NOW,
      }),
    ).rejects.toMatchObject({ code: 'audit_tenant_required' });
  });

  it('commits business write and audit together in the same unit of work', async () => {
    const uow = new TypeOrmUnitOfWork(dataSource, (manager) => ({
      notes: manager.getRepository(AuditFixtureNoteOrmEntity),
      audit: new TypeOrmAuditWriter(manager),
    }));

    await uow.run(async ({ notes, audit }) => {
      await notes.insert({ id: 'uow-commit-note', body: 'committed' });
      await audit.append(
        entry('uow-commit-audit', 'tenant-uow', {
          target: 'notes/uow-commit-note',
        }),
      );
    });

    const notes: { id: string }[] = await dataSource.query(
      `SELECT id FROM audit_fixture_notes WHERE id = 'uow-commit-note'`,
    );
    expect(notes).toHaveLength(1);
    expect(await count('tenant-uow')).toBe(1);
  });

  it('rolls back business write and audit together when the work fails', async () => {
    const uow = new TypeOrmUnitOfWork(dataSource, (manager) => ({
      notes: manager.getRepository(AuditFixtureNoteOrmEntity),
      audit: new TypeOrmAuditWriter(manager),
    }));

    await expect(
      uow.run(async ({ notes, audit }) => {
        await notes.insert({ id: 'uow-rollback-note', body: 'rolled back' });
        await audit.append(
          entry('uow-rollback-audit', 'tenant-rollback', {
            target: 'notes/uow-rollback-note',
          }),
        );
        throw new Error('business failure after audit append');
      }),
    ).rejects.toThrow('business failure after audit append');

    const notes: { id: string }[] = await dataSource.query(
      `SELECT id FROM audit_fixture_notes WHERE id = 'uow-rollback-note'`,
    );
    expect(notes).toHaveLength(0);
    expect(await count('tenant-rollback')).toBe(0);
  });

  it('blocks UPDATE and DELETE outside the retention purge', async () => {
    await new TypeOrmAuditWriter(dataSource.manager).append(
      entry('immutable-1', 'tenant-immutable'),
    );
    await expect(
      dataSource.query(
        `UPDATE ${AUDIT_ENTRIES_TABLE} SET action = 'session.revoke' WHERE id = 'immutable-1'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      dataSource.query(
        `DELETE FROM ${AUDIT_ENTRIES_TABLE} WHERE id = 'immutable-1'`,
      ),
    ).rejects.toThrow(/append-only/);
    expect(await count('tenant-immutable')).toBe(1);
  });

  it('purges only expired entries, in limited batches', async () => {
    const writer = new TypeOrmAuditWriter(dataSource.manager);
    const tenant = 'tenant-retention';
    for (let index = 0; index < 5; index += 1) {
      await writer.append(
        entry(`expired-${index}`, tenant, {
          occurredAt: NOW - 400 * DAY + index,
        }),
      );
    }
    await writer.append(entry('fresh-1', tenant, { occurredAt: NOW - DAY }));
    await writer.append(
      entry('fresh-2', tenant, { occurredAt: NOW - 10 * DAY }),
    );
    expect(await count(tenant)).toBe(7);

    const retention = new TypeOrmAuditRetention(
      dataSource,
      createAuditRetentionPolicy({ retentionDays: 365 }),
      () => NOW,
    );

    expect(await retention.purgeExpired(2)).toBe(2);
    expect(await count(tenant)).toBe(5);
    expect(await retention.purgeExpired(2)).toBe(2);
    expect(await retention.purgeExpired(2)).toBe(1);
    expect(await retention.purgeExpired(2)).toBe(0);

    const remaining: { id: string }[] = await dataSource.query(
      `SELECT id FROM ${AUDIT_ENTRIES_TABLE} WHERE tenant_id = $1 ORDER BY id`,
      [tenant],
    );
    expect(remaining.map((row) => row.id)).toEqual(['fresh-1', 'fresh-2']);
  });

  it('stores no forbidden data in any row, even when the context carries it', async () => {
    const writer = new TypeOrmAuditWriter(dataSource.manager);
    const polluted = {
      ...entry('sweep-1', 'tenant-sweep'),
      context: {
        subjectId: 'subject-sweep',
        tenantId: 'tenant-sweep',
        correlationId: 'corr-sweep',
        permissions: ['contacts:write', 'audit:read'],
        deadlineAt: NOW + 99_000,
        accessToken:
          'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzd2VlcCJ9.signature-value',
        email: 'maria@example.test',
        password: 'swept-password-value',
      },
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzd2VlcCJ9.signature-value',
    } as unknown as AuditEntry;
    await writer.append(polluted);

    const rows: Record<string, unknown>[] = await dataSource.query(
      `SELECT * FROM ${AUDIT_ENTRIES_TABLE}`,
    );
    const dump = JSON.stringify(rows);
    expect(dump).toContain('sweep-1');
    expect(dump).not.toMatch(
      /eyJ|maria@|swept-password|contacts:write|audit:read|permissions|deadline|accessToken|password|secret/i,
    );

    const columns: { column_name: string }[] = await dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [AUDIT_ENTRIES_TABLE],
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      'action',
      'correlation_id',
      'id',
      'occurred_at',
      'outcome',
      'subject_id',
      'target',
      'tenant_id',
    ]);
  });
});

describe('Recuperação da auditoria com telemetria desligada ou indisponível', () => {
  /** Porta livre sem ninguém escutando: simula Collector inalcançável. */
  function unusedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  function runChild(
    mode: 'no-otel' | 'otel-unreachable',
    correlationId: string,
    noteId: string,
    otlpPort: number,
  ): Promise<{ otelLoaded: boolean; committed: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-r', TS_NODE, CHILD], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          AUDIT_CHILD_MODE: mode,
          AUDIT_CHILD_HOST: container.getHost(),
          AUDIT_CHILD_PORT: String(container.getPort()),
          AUDIT_CHILD_DATABASE: DATABASE,
          AUDIT_CHILD_USER: container.getUsername(),
          AUDIT_CHILD_PASSWORD: ADMIN_PASSWORD,
          AUDIT_CHILD_CORRELATION_ID: correlationId,
          AUDIT_CHILD_NOTE_ID: noteId,
          FOUNDATION_SERVICE_NAME: 'audit-recovery',
          FOUNDATION_SERVICE_VERSION: '0.0.1',
          FOUNDATION_DEPLOYMENT_ENVIRONMENT: 'test',
          FOUNDATION_OTEL_SAMPLING_RATIO: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlpPort}`,
          OTEL_EXPORTER_OTLP_TIMEOUT: '500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child ${mode} timed out`));
      }, 120_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`child ${mode} exited ${code}: ${stderr}`));
          return;
        }
        const line = stdout.trim().split('\n').at(-1) ?? '';
        resolve(
          JSON.parse(line) as { otelLoaded: boolean; committed: boolean },
        );
      });
    });
  }

  it('keeps a confirmed audited operation recoverable in a process without OTel', async () => {
    const result = await runChild(
      'no-otel',
      'corr-child-no-otel',
      'note-no-otel',
      9,
    );
    expect(result).toMatchObject({ otelLoaded: false, committed: true });

    const page = await readAuditTrail(
      new TypeOrmAuditReader(dataSource),
      auditorContext('tenant-recovery'),
      { fromMs: NOW - DAY, toMs: NOW + DAY },
    );
    expect(page.items.map((item) => item.context.correlationId)).toContain(
      'corr-child-no-otel',
    );
  });

  it('keeps the audited operation recoverable when the OTel collector is unreachable', async () => {
    const port = await unusedPort();
    const result = await runChild(
      'otel-unreachable',
      'corr-child-otel',
      'note-otel',
      port,
    );
    expect(result).toMatchObject({ otelLoaded: true, committed: true });

    const page = await readAuditTrail(
      new TypeOrmAuditReader(dataSource),
      auditorContext('tenant-recovery'),
      { fromMs: NOW - DAY, toMs: NOW + DAY },
    );
    expect(page.items.map((item) => item.context.correlationId)).toContain(
      'corr-child-otel',
    );
    const notes: { id: string }[] = await dataSource.query(
      `SELECT id FROM audit_fixture_notes WHERE id = 'note-otel'`,
    );
    expect(notes).toHaveLength(1);
  });
});
