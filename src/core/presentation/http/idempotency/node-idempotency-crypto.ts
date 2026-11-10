import { createHash, randomUUID } from 'node:crypto';
import type { IdempotencyCrypto } from '../../../application/idempotency/idempotency.types';

/** Implementação técnica do hash e dos tokens, fora da camada Application. */
export const NODE_IDEMPOTENCY_CRYPTO: IdempotencyCrypto = Object.freeze({
  sha256Hex: (input: string): string =>
    createHash('sha256').update(input, 'utf8').digest('hex'),
  randomToken: (): string => randomUUID(),
});
