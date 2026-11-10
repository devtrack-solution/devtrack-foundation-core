import type { Reading } from '../domain/reading';

export function accept(input: Reading): number {
  return input.value;
}
