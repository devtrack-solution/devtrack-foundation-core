import type { InjectionToken } from '@nestjs/common';

/** Checks that a binding is a usable Nest injection token. */
export function requireToken(
  value: unknown,
  name: string,
): asserts value is InjectionToken {
  if (!(
    typeof value === 'symbol' ||
    typeof value === 'function' ||
    (typeof value === 'string' && value.length > 0)
  ))
    throw new Error(`Invalid authentication binding: ${name}`);
}

/** Checks shape, not method semantics, return types or external connectivity. */
export function requirePort<T>(
  value: unknown,
  name: string,
  methods: readonly string[],
): T {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    !methods.every(
      (method) =>
        typeof (value as Record<string, unknown>)[method] === 'function',
    )
  )
    throw new Error(`Invalid authentication provider: ${name}`);
  return value as T;
}

/** Checks that a provider is a function (for example an id generator). Shape only. */
export function requireFunction(
  value: unknown,
  name: string,
): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function')
    throw new Error(`Invalid authentication provider: ${name}`);
}
