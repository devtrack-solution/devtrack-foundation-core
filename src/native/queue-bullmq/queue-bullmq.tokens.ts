/** Tokens internos do adapter BullMQ (configuração e handlers recebidos do host). */
export const QUEUE_BULLMQ_OPTIONS = Symbol.for(
  'foundation.native.queue-bullmq.options',
);
export const QUEUE_BULLMQ_HANDLERS = Symbol.for(
  'foundation.native.queue-bullmq.handlers',
);
export const JOB_CONSUMER = Symbol.for('foundation.api.v1.jobs.consumer');
