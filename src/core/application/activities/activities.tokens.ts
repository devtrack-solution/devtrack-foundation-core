/** Tokens de DI das portas de atividades e jobs. Estáveis entre cópias compatíveis do pacote. */
export const ACTIVITY_STORE = Symbol.for('foundation.api.v1.activities.store');
export const JOB_QUEUE = Symbol.for('foundation.api.v1.jobs.queue');
export const JOB_SUBMITTER = Symbol.for('foundation.api.v1.jobs.submitter');
export const JOB_EXECUTOR = Symbol.for('foundation.api.v1.jobs.executor');
export const JOB_RETRY_POLICY = Symbol.for(
  'foundation.api.v1.jobs.retry-policy',
);
export const JOB_HANDLER_REGISTRY = Symbol.for(
  'foundation.api.v1.jobs.handler-registry',
);
export const JOB_IDENTITY_RESOLVER = Symbol.for(
  'foundation.api.v1.jobs.identity-resolver',
);
