import type { OperationContext } from '../context/operation-context';

/** Minimal actor and correlation references allowed in durable audit entries. */
export interface AuditContext {
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
}

/** Project trusted context explicitly; never copy credentials or arbitrary metadata. */
export function createAuditContext(context: OperationContext): AuditContext {
  const subjectId = context.principal.subjectId;
  const tenantId = context.principal.tenantId;
  const correlationId = context.correlationId;

  if (tenantId === undefined) {
    return { subjectId, correlationId };
  }

  return { subjectId, tenantId, correlationId };
}
