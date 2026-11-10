/** Identificadores de módulo, feature e capacidade. Compartilhado pelo resolvedor e pelo leitor de perfil. */
export const MODULE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[./-][a-z0-9]+)*$/;

export function isModuleIdentifier(value: unknown): value is string {
  return typeof value === 'string' && MODULE_IDENTIFIER_PATTERN.test(value);
}
