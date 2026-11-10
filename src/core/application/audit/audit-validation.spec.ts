import type { AuditEntry } from './audit-writer.port';
import {
  AuditValidationError,
  createAuditRetentionPolicy,
  toAuditRecord,
  validateAuditAction,
  validateAuditTarget,
  validateAuditTrailQuery,
  validatePurgeBatchSize,
} from './audit-validation';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'audit-1',
    occurredAt: 1_000,
    context: {
      subjectId: 'subject-1',
      tenantId: 'tenant-a',
      correlationId: 'corr-1',
    },
    action: 'contacts.create',
    target: 'contacts/123',
    outcome: 'succeeded',
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuditValidationError) return error.code;
    throw error;
  }
  return 'no-error';
}

describe('toAuditRecord (serialização de campos permitidos)', () => {
  it('keeps only the allowed fields even when the input carries extra properties', () => {
    const enriched = {
      ...entry(),
      context: {
        subjectId: 'subject-1',
        tenantId: 'tenant-a',
        correlationId: 'corr-1',
        permissions: ['contacts:write', 'audit:read'],
        deadlineAt: 99_999,
        accessToken: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
        email: 'maria@example.test',
        password: 'never-persist',
      },
      payload: { secret: 'never-persist' },
      accessToken: 'never-persist',
    } as unknown as AuditEntry;

    const record = toAuditRecord(enriched);

    expect(record).toStrictEqual({
      id: 'audit-1',
      occurredAt: 1_000,
      subjectId: 'subject-1',
      tenantId: 'tenant-a',
      correlationId: 'corr-1',
      action: 'contacts.create',
      target: 'contacts/123',
      outcome: 'succeeded',
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(
      /permissions|deadline|eyJ|maria@|never-persist/,
    );
  });

  it('omits tenantId when the context has no tenant', () => {
    const record = toAuditRecord(
      entry({ context: { subjectId: 'subject-1', correlationId: 'corr-1' } }),
    );
    expect(Object.hasOwn(record, 'tenantId')).toBe(false);
  });

  it('rejects an invalid outcome and a negative or non-integer instant', () => {
    expect(
      codeOf(() =>
        toAuditRecord(entry({ outcome: 'maybe' as AuditEntry['outcome'] })),
      ),
    ).toBe('audit_invalid_entry');
    expect(codeOf(() => toAuditRecord(entry({ occurredAt: -1 })))).toBe(
      'audit_invalid_entry',
    );
    expect(codeOf(() => toAuditRecord(entry({ occurredAt: 1.5 })))).toBe(
      'audit_invalid_entry',
    );
  });

  it('rejects a context identifier that looks like an e-mail address', () => {
    expect(
      codeOf(() =>
        toAuditRecord(
          entry({
            context: { subjectId: 'maria@example.test', correlationId: 'c' },
          }),
        ),
      ),
    ).toBe('audit_invalid_context');
  });
});

describe('validateAuditAction', () => {
  it.each(['contacts.create', 'session.revoke', 'a'])('accepts %s', (value) => {
    expect(validateAuditAction(value)).toBe(value);
  });

  it.each([
    ['uppercase', 'Contacts.Create'],
    ['space', 'contacts create'],
    ['leading digit', '1contacts'],
    ['empty', ''],
    ['too long', `a${'b'.repeat(64)}`],
    ['non-string', 42],
  ])('rejects %s', (_label, value) => {
    expect(codeOf(() => validateAuditAction(value))).toBe(
      'audit_invalid_action',
    );
  });
});

describe('validateAuditTarget', () => {
  it.each(['contacts/123', 'session:abc-1', 'tenant.resource_9'])(
    'accepts %s',
    (value) => {
      expect(validateAuditTarget(value)).toBe(value);
    },
  );

  it.each([
    ['e-mail', 'maria@example.test'],
    [
      'bearer-like token',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signaturevalue123456',
    ],
    ['long opaque secret', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'],
    ['sensitive segment', 'auth.token.refresh'],
    ['password segment', 'users/password-reset'],
    ['formatted CPF', '123.456.789-09'],
    ['card-like digits', '4111111111111111'],
    ['whitespace', 'contacts 123'],
    ['empty', ''],
    ['too long', `c${'x'.repeat(128)}`],
  ])('rejects %s', (_label, value) => {
    expect(codeOf(() => validateAuditTarget(value))).toBe(
      'audit_invalid_target',
    );
  });
});

describe('createAuditRetentionPolicy', () => {
  it('defaults to 365 days and converts to milliseconds', () => {
    const policy = createAuditRetentionPolicy();
    expect(policy.retentionDays).toBe(365);
    expect(policy.retentionMs).toBe(365 * 86_400_000);
  });

  it.each([1, 3650])('accepts the boundary %i days', (days) => {
    expect(
      createAuditRetentionPolicy({ retentionDays: days }).retentionDays,
    ).toBe(days);
  });

  it.each([0, -1, 3651, 1.5, Number.NaN])('rejects %s days', (days) => {
    expect(
      codeOf(() => createAuditRetentionPolicy({ retentionDays: days })),
    ).toBe('audit_invalid_policy');
  });
});

describe('validatePurgeBatchSize', () => {
  it('accepts the limits and rejects values outside them', () => {
    expect(validatePurgeBatchSize(1)).toBe(1);
    expect(validatePurgeBatchSize(1000)).toBe(1000);
    expect(codeOf(() => validatePurgeBatchSize(0))).toBe(
      'audit_invalid_policy',
    );
    expect(codeOf(() => validatePurgeBatchSize(1001))).toBe(
      'audit_invalid_policy',
    );
  });
});

describe('validateAuditTrailQuery', () => {
  const base = {
    tenantId: 'tenant-a',
    fromMs: 0,
    toMs: 10,
    limit: 50,
    offset: 0,
  };

  it('accepts a valid query', () => {
    expect(
      validateAuditTrailQuery({ ...base, action: 'contacts.create' }).action,
    ).toBe('contacts.create');
  });

  it.each([
    ['empty range', { fromMs: 10, toMs: 10 }],
    ['limit above page size', { limit: 101 }],
    ['limit zero', { limit: 0 }],
    ['offset above max', { offset: 10_001 }],
  ])('rejects %s', (_label, override) => {
    expect(
      codeOf(() => validateAuditTrailQuery({ ...base, ...override })),
    ).toBe('audit_invalid_query');
  });

  it('rejects an invalid action with the action code', () => {
    expect(
      codeOf(() => validateAuditTrailQuery({ ...base, action: 'Bad Action' })),
    ).toBe('audit_invalid_action');
  });
});
