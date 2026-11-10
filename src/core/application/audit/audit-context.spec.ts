import { createAuditContext } from './audit-context';

describe('createAuditContext', () => {
  it('copies only audit fields from enriched context without changing the input', () => {
    const permissions = Object.freeze(['contacts:write']);
    const principal = Object.freeze({
      subjectId: 'subject-1',
      tenantId: 'tenant-1',
      permissions,
      password: 'never-copy-this',
      profile: Object.freeze({ email: 'private@example.test' }),
    });
    const context = Object.freeze({
      principal,
      correlationId: 'correlation-1',
      deadlineAt: 1000,
      accessToken: 'never-copy-token',
      password: 'never-copy-password',
      metadata: Object.freeze({ clientSecret: 'never-copy-secret' }),
    });

    const result = createAuditContext(context);

    expect(result).toStrictEqual({
      subjectId: 'subject-1',
      tenantId: 'tenant-1',
      correlationId: 'correlation-1',
    });
    expect(result).not.toBe(context);
    expect(result).not.toBe(principal);
    expect(
      Object.values(result).every((value) => typeof value === 'string'),
    ).toBe(true);
    expect(context.principal).toBe(principal);
    expect(context.principal.permissions).toBe(permissions);
    expect(context.password).toBe('never-copy-password');
    expect(context.metadata.clientSecret).toBe('never-copy-secret');
    expect(context.deadlineAt).toBe(1000);
  });

  it('omits the tenant property when no tenant exists', () => {
    const result = createAuditContext({
      principal: { subjectId: 'subject-1', permissions: [] },
      correlationId: 'correlation-1',
      deadlineAt: 1000,
    });

    expect(result).toStrictEqual({
      subjectId: 'subject-1',
      correlationId: 'correlation-1',
    });
    expect(Object.hasOwn(result, 'tenantId')).toBe(false);
  });

  it('omits an explicitly undefined tenant instead of copying an undefined key', () => {
    const result = createAuditContext({
      principal: {
        subjectId: 'subject-1',
        tenantId: undefined,
        permissions: [],
      },
      correlationId: 'correlation-1',
      deadlineAt: 1000,
    });

    expect(Object.hasOwn(result, 'tenantId')).toBe(false);
  });

  it('preserves a defined empty tenant without inventing a validation policy', () => {
    const result = createAuditContext({
      principal: { subjectId: 'subject-1', tenantId: '', permissions: [] },
      correlationId: 'correlation-1',
      deadlineAt: 1000,
    });

    expect(result).toStrictEqual({
      subjectId: 'subject-1',
      tenantId: '',
      correlationId: 'correlation-1',
    });
  });

  it('does not retain references affected by later input mutations', () => {
    const context = {
      principal: {
        subjectId: 'subject-1',
        tenantId: 'tenant-1',
        permissions: ['contacts:write'],
      },
      correlationId: 'correlation-1',
      deadlineAt: 1000,
    };
    const result = createAuditContext(context);

    context.principal.subjectId = 'subject-2';
    context.principal.tenantId = 'tenant-2';
    context.principal.permissions.push('admin');
    context.correlationId = 'correlation-2';
    context.deadlineAt = 2000;

    expect(result).toStrictEqual({
      subjectId: 'subject-1',
      tenantId: 'tenant-1',
      correlationId: 'correlation-1',
    });
  });

  it('does not inspect fields outside the explicit allowlist', () => {
    const context = {
      principal: {
        subjectId: 'subject-1',
        permissions: [],
        get password(): string {
          throw new Error('Password must not be accessed');
        },
      },
      correlationId: 'correlation-1',
      deadlineAt: 1000,
      get accessToken(): string {
        throw new Error('Token must not be accessed');
      },
    };

    expect(createAuditContext(context)).toStrictEqual({
      subjectId: 'subject-1',
      correlationId: 'correlation-1',
    });
  });
});
