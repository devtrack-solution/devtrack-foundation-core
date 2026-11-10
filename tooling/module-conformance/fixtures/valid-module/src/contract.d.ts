export interface Reading {
  readonly id: string;
  readonly value: number;
}
export function read(input: Reading): number;
