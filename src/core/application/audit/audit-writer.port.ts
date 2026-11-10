import type { AuditContext } from './audit-context';
export interface AuditEntry {
  readonly id: string;
  readonly occurredAt: number;
  readonly context: AuditContext;
  readonly action: string;
  readonly target: string;
  readonly outcome: 'succeeded' | 'denied' | 'failed';
}
/** Durable, access-controlled sink; never a substitute for OTel logging. */
export interface AuditWriter {
  /** No arbitrary payload, credential or provider token metadata. */
  append(entry: AuditEntry): Promise<void>;
}
