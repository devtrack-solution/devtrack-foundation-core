import {
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
} from './idempotency.errors';
import { canonicalJson } from './canonical-json';
import {
  IDEMPOTENCY_KEY_PATTERN,
  type IdempotencyCrypto,
} from './idempotency.types';

/**
 * Valida a chave do cliente: string de 1 a 128 caracteres de `A-Z a-z 0-9 . _ : -`.
 * Ausente lança `IdempotencyKeyRequiredError`; qualquer outro valor inválido lança
 * `IdempotencyKeyInvalidError`.
 */
export function validateClientKey(value: unknown): string {
  if (value === undefined || value === null)
    throw new IdempotencyKeyRequiredError();
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value))
    throw new IdempotencyKeyInvalidError();
  return value;
}

export interface ContextualKeyInput {
  readonly tenantId?: string;
  readonly subjectId: string;
  readonly operationId: string;
  readonly clientKey: string;
}

/**
 * Chave contextual: SHA-256 de JSON canônico de (tenant, subject, operação, chave
 * do cliente). Mesmo valor de chave em outro tenant, subject ou operação gera outra
 * intenção. A serialização canônica evita ambiguidade de separadores.
 */
export function contextualKeyOf(
  crypto: IdempotencyCrypto,
  input: ContextualKeyInput,
): string {
  return crypto.sha256Hex(
    canonicalJson({
      v: 1,
      tenantId: input.tenantId ?? null,
      subjectId: input.subjectId,
      operationId: input.operationId,
      clientKey: input.clientKey,
    }),
  );
}

/** Fingerprint: SHA-256 do JSON canônico do conteúdo semântico. */
export function fingerprintOf(
  crypto: IdempotencyCrypto,
  semantic: unknown,
): string {
  return crypto.sha256Hex(canonicalJson(semantic));
}
