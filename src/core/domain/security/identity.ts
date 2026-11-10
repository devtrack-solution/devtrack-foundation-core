/** Internal identity: never a username, email or provider-specific subject. */
export interface Principal {
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly permissions: readonly string[];
}
export type AuthenticationMethod =
  | { readonly kind: 'password' }
  | { readonly kind: 'federated'; readonly providerId: string };
export interface ExternalIdentity {
  readonly providerId: string;
  readonly issuer: string;
  readonly subject: string;
}
