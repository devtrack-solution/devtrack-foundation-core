export type SessionState = 'pending' | 'active' | 'revoked' | 'expired';
/** All timestamps in core contracts are Unix epoch milliseconds. */
export interface SessionReference {
  readonly id: string;
  readonly expiresAt: number;
}
