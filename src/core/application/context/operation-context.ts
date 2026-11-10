import type { Principal } from '../../domain/security/identity';
/** Constructed by trusted ingress after authentication, never from raw headers. */
export interface OperationContext {
  readonly correlationId: string;
  readonly principal: Principal;
  readonly deadlineAt: number;
}
