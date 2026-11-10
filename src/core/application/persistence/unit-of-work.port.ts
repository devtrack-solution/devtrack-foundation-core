/** Adapter binds transaction-scoped repositories/audit/outbox to Resources. */
export interface UnitOfWork<Resources> {
  /** Commits all resources together or rolls back; no network calls in work. */
  run<Result>(work: (resources: Resources) => Promise<Result>): Promise<Result>;
}
