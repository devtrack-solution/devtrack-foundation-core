import { canonicalJson } from './canonical-json';
import { IdempotencyContentError } from './idempotency.errors';

describe('canonicalJson', () => {
  it('produces the same text regardless of object key order', () => {
    const a = { z: 1, a: { y: [1, 2], b: 'x' } };
    const b = { a: { b: 'x', y: [1, 2] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"b":"x","y":[1,2]},"z":1}');
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('is sensitive to values', () => {
    expect(canonicalJson({ amount: 10 })).not.toBe(
      canonicalJson({ amount: 11 }),
    );
    expect(canonicalJson({ n: null })).not.toBe(canonicalJson({ n: 0 }));
  });

  it('omits undefined object properties, as JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it.each([
    ['undefined in array', [1, undefined]],
    ['NaN', { n: Number.NaN }],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', { at: new Date(0) }],
    ['function', { f: () => 1 }],
    ['class instance', new (class Box {})()],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(IdempotencyContentError);
  });

  it('rejects cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(IdempotencyContentError);
  });
});
