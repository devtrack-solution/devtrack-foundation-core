import type { OperationContext } from '../context/operation-context';
import type { AuditReader, AuditTrailPage } from './audit-reader.port';
import {
  AUDIT_LIMITS,
  validateAuditTrailQuery,
  type AuditTrailQuery,
} from './audit-validation';

/** Permissão dedicada para ler a trilha. Não é concedida por papéis de negócio. */
export const AUDIT_READ_PERMISSION = 'audit:read';

/** Negação de acesso à auditoria. Código estável; não revela o motivo além dele. */
export class AuditAccessError extends Error {
  readonly code: 'permission_denied' | 'audit_tenant_required';

  constructor(code: 'permission_denied' | 'audit_tenant_required') {
    super(code);
    this.name = 'AuditAccessError';
    this.code = code;
  }
}

/** Entrada da leitura. Não aceita `tenantId`: o tenant vem do principal autenticado. */
export interface ReadAuditTrailInput {
  readonly fromMs: number;
  readonly toMs: number;
  readonly action?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Função de aplicação para consultar a trilha de auditoria. Exige a permissão
 * `audit:read` e um tenant no principal; a consulta fica restrita a esse tenant,
 * inclusive quando o chamador tenta indicar outro. Não é exposta por rota de negócio.
 */
export async function readAuditTrail(
  reader: AuditReader,
  context: OperationContext,
  input: ReadAuditTrailInput,
): Promise<AuditTrailPage> {
  const principal = context.principal;
  if (!principal.permissions.includes(AUDIT_READ_PERMISSION)) {
    throw new AuditAccessError('permission_denied');
  }
  if (principal.tenantId === undefined || principal.tenantId === '') {
    throw new AuditAccessError('audit_tenant_required');
  }
  const query: AuditTrailQuery = validateAuditTrailQuery({
    tenantId: principal.tenantId,
    fromMs: input.fromMs,
    toMs: input.toMs,
    ...(input.action === undefined ? {} : { action: input.action }),
    limit: input.limit ?? AUDIT_LIMITS.pageSizeDefault,
    offset: input.offset ?? 0,
  });
  return reader.list(query);
}
