export const PERSISTENCE_ERROR_CODES = [
  'PERSISTENCE_DUPLICATE_MODULE_ID',
  'PERSISTENCE_INVALID_CONTRIBUTION',
  'PERSISTENCE_INVALID_ENTITY',
  'PERSISTENCE_DUPLICATE_ENTITY',
  'PERSISTENCE_DUPLICATE_TABLE',
  'PERSISTENCE_INVALID_MIGRATION',
  'PERSISTENCE_DUPLICATE_MIGRATION',
  'PERSISTENCE_DUPLICATE_MIGRATION_NAME',
  'PERSISTENCE_INVALID_CONFIG',
  'PERSISTENCE_INVALID_POOL_SIZE',
  'PERSISTENCE_SYNCHRONIZE_FORBIDDEN',
  'PERSISTENCE_NESTED_TRANSACTION',
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

/**
 * Erro de configuração ou uso da persistência. O `code` é estável; a mensagem
 * nunca inclui senha nem valor de segredo.
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}
