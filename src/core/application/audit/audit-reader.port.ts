import type { AuditEntry } from './audit-writer.port';
import type { AuditTrailQuery } from './audit-validation';

/** Página de leitura. `items` contém apenas `AuditEntry` projetado; nunca o objeto bruto. */
export interface AuditTrailPage {
  readonly items: readonly AuditEntry[];
  readonly limit: number;
  readonly offset: number;
}

/**
 * Porta de leitura separada do writer. Implementações devem filtrar sempre por
 * `tenantId` e validar a consulta antes de executar. Acesso exige `audit:read`,
 * verificado pela função de aplicação `readAuditTrail`.
 */
export interface AuditReader {
  list(query: AuditTrailQuery): Promise<AuditTrailPage>;
}
