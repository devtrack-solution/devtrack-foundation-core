import type { EntityManager } from 'typeorm';
import type { AuditEntry } from '../../../core/application/audit/audit-writer.port';
import {
  TypeOrmAuditWriter,
  AUDIT_ENTRIES_TABLE,
} from './typeorm-audit-writer';

function fakeManager() {
  const query = jest
    .fn<Promise<unknown>, [string, unknown[]]>()
    .mockResolvedValue([]);
  return {
    manager: { query } as unknown as Pick<EntityManager, 'query'>,
    query,
  };
}

describe('TypeOrmAuditWriter', () => {
  it('binds only the allowed columns, ignoring extra runtime properties', async () => {
    const { manager, query } = fakeManager();
    const writer = new TypeOrmAuditWriter(manager);
    const enriched = {
      id: 'audit-1',
      occurredAt: 5_000,
      context: {
        subjectId: 'subject-1',
        tenantId: 'tenant-a',
        correlationId: 'corr-1',
        permissions: ['audit:read'],
        deadlineAt: 123,
        accessToken: 'eyJhbGciOiJIUzI1NiJ9.x.y',
      },
      action: 'contacts.create',
      target: 'contacts/9',
      outcome: 'succeeded',
      password: 'never-persist',
      email: 'maria@example.test',
    } as unknown as AuditEntry;

    await writer.append(enriched);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`INSERT INTO ${AUDIT_ENTRIES_TABLE}`);
    expect(params).toStrictEqual([
      'audit-1',
      5_000,
      'subject-1',
      'tenant-a',
      'corr-1',
      'contacts.create',
      'contacts/9',
      'succeeded',
    ]);
    expect(JSON.stringify(params)).not.toMatch(
      /audit:read|deadline|eyJ|never-persist|maria@/,
    );
  });

  it('binds NULL for an absent tenant', async () => {
    const { manager, query } = fakeManager();
    await new TypeOrmAuditWriter(manager).append({
      id: 'audit-2',
      occurredAt: 1,
      context: { subjectId: 'subject-1', correlationId: 'corr-2' },
      action: 'session.revoke',
      target: 'sessions/1',
      outcome: 'denied',
    });
    expect(query.mock.calls[0][1][3]).toBeNull();
  });

  it('rejects an invalid target without touching the database', async () => {
    const { manager, query } = fakeManager();
    await expect(
      new TypeOrmAuditWriter(manager).append({
        id: 'audit-3',
        occurredAt: 1,
        context: { subjectId: 'subject-1', correlationId: 'corr-3' },
        action: 'contacts.create',
        target: 'maria@example.test',
        outcome: 'succeeded',
      }),
    ).rejects.toMatchObject({ code: 'audit_invalid_target' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an invalid action without touching the database', async () => {
    const { manager, query } = fakeManager();
    await expect(
      new TypeOrmAuditWriter(manager).append({
        id: 'audit-4',
        occurredAt: 1,
        context: { subjectId: 'subject-1', correlationId: 'corr-4' },
        action: 'Contacts Create',
        target: 'contacts/1',
        outcome: 'succeeded',
      }),
    ).rejects.toMatchObject({ code: 'audit_invalid_action' });
    expect(query).not.toHaveBeenCalled();
  });
});
