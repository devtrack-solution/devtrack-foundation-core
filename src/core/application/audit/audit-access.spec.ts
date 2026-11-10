import type { OperationContext } from '../context/operation-context';
import type { AuditReader } from './audit-reader.port';
import type { AuditTrailQuery } from './audit-validation';
import {
  AUDIT_READ_PERMISSION,
  AuditAccessError,
  readAuditTrail,
} from './audit-access';

function context(
  overrides: Partial<OperationContext['principal']> = {},
): OperationContext {
  return {
    correlationId: 'corr-1',
    deadlineAt: 10_000,
    principal: {
      subjectId: 'auditor-1',
      tenantId: 'tenant-a',
      permissions: [AUDIT_READ_PERMISSION],
      ...overrides,
    },
  };
}

function recordingReader(): AuditReader & { queries: AuditTrailQuery[] } {
  const queries: AuditTrailQuery[] = [];
  return {
    queries,
    list: (query) => {
      queries.push(query);
      return Promise.resolve({
        items: [],
        limit: query.limit,
        offset: query.offset,
      });
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuditAccessError) return error.code;
    throw error;
  }
  return 'no-error';
}

describe('readAuditTrail', () => {
  it('requires the dedicated audit:read permission', async () => {
    const reader = recordingReader();
    const code = await codeOf(
      readAuditTrail(reader, context({ permissions: ['contacts:write'] }), {
        fromMs: 0,
        toMs: 10,
      }),
    );
    expect(code).toBe('permission_denied');
    expect(reader.queries).toHaveLength(0);
  });

  it('scopes the query to the principal tenant and ignores any other tenant claim', async () => {
    const reader = recordingReader();
    const input = {
      fromMs: 0,
      toMs: 10,
      tenantId: 'tenant-b',
    } as unknown as Parameters<typeof readAuditTrail>[2];

    await readAuditTrail(reader, context(), input);

    expect(reader.queries[0]).toMatchObject({
      tenantId: 'tenant-a',
      limit: 50,
      offset: 0,
    });
  });

  it('denies a principal without tenant', async () => {
    const reader = recordingReader();
    const code = await codeOf(
      readAuditTrail(reader, context({ tenantId: undefined }), {
        fromMs: 0,
        toMs: 10,
      }),
    );
    expect(code).toBe('audit_tenant_required');
    expect(reader.queries).toHaveLength(0);
  });

  it('rejects an out-of-range page before calling the reader', async () => {
    const reader = recordingReader();
    await expect(
      readAuditTrail(reader, context(), { fromMs: 0, toMs: 10, limit: 500 }),
    ).rejects.toThrow('limit must be an integer between 1 and 100');
    expect(reader.queries).toHaveLength(0);
  });
});
