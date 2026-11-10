import { createHash, randomUUID } from 'node:crypto';
import {
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
} from './idempotency.errors';
import {
  contextualKeyOf,
  fingerprintOf,
  validateClientKey,
} from './idempotency.key';
import type { IdempotencyCrypto } from './idempotency.types';

const testCrypto: IdempotencyCrypto = {
  sha256Hex: (input) =>
    createHash('sha256').update(input, 'utf8').digest('hex'),
  randomToken: () => randomUUID(),
};

const BASE = {
  tenantId: 'tenant-a',
  subjectId: 'subject-a',
  operationId: 'contacts.create',
  clientKey: 'req-1',
};

describe('validateClientKey', () => {
  it.each(['a', 'req-1', 'A.B_c:9', 'x'.repeat(128)])('accepts %s', (key) => {
    expect(validateClientKey(key)).toBe(key);
  });

  it.each([
    '',
    'x'.repeat(129),
    'has space',
    'slash/not-allowed',
    'ação',
    'semi;colon',
  ])('rejects invalid charset or length: %j', (key) => {
    expect(() => validateClientKey(key)).toThrow(IdempotencyKeyInvalidError);
  });

  it('reports absence as required', () => {
    expect(() => validateClientKey(undefined)).toThrow(
      IdempotencyKeyRequiredError,
    );
    expect(() => validateClientKey(null)).toThrow(IdempotencyKeyRequiredError);
  });

  it('rejects non-string values', () => {
    expect(() => validateClientKey(['a', 'b'])).toThrow(
      IdempotencyKeyInvalidError,
    );
    expect(() => validateClientKey(42)).toThrow(IdempotencyKeyInvalidError);
  });
});

describe('contextualKeyOf', () => {
  it('is stable for the same context', () => {
    expect(contextualKeyOf(testCrypto, BASE)).toBe(
      contextualKeyOf(testCrypto, { ...BASE }),
    );
    expect(contextualKeyOf(testCrypto, BASE)).toHaveLength(64);
  });

  it.each([
    ['tenant', { tenantId: 'tenant-b' }],
    ['subject', { subjectId: 'subject-b' }],
    ['operation', { operationId: 'contacts.update' }],
    ['client key', { clientKey: 'req-2' }],
  ])('changes when %s changes', (_label, change) => {
    expect(contextualKeyOf(testCrypto, { ...BASE, ...change })).not.toBe(
      contextualKeyOf(testCrypto, BASE),
    );
  });

  it('distinguishes a missing tenant from a tenant with the same text', () => {
    const withoutTenant = {
      subjectId: BASE.subjectId,
      operationId: BASE.operationId,
      clientKey: BASE.clientKey,
    };
    expect(contextualKeyOf(testCrypto, withoutTenant)).not.toBe(
      contextualKeyOf(testCrypto, { ...withoutTenant, tenantId: '' }),
    );
  });
});

describe('fingerprintOf', () => {
  it('is independent of key order and sensitive to values', () => {
    const first = fingerprintOf(testCrypto, { name: 'Ana', age: 3 });
    expect(first).toBe(fingerprintOf(testCrypto, { age: 3, name: 'Ana' }));
    expect(first).not.toBe(fingerprintOf(testCrypto, { name: 'Ana', age: 4 }));
  });
});
