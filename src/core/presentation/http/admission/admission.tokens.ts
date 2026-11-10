/** Tokens internos do registro de admissão. Estáveis entre cópias compatíveis do pacote. */
export const ADMISSION_SERVICE = Symbol.for(
  'foundation.api.v1.admission.service',
);
export const ADMISSION_CHECKS = Symbol.for(
  'foundation.api.v1.admission.checks',
);
export const ADMISSION_RATE_STORE = Symbol.for(
  'foundation.api.v1.admission.rate-store',
);
export const ADMISSION_SIGNALS_PORT = Symbol.for(
  'foundation.api.v1.admission.signals',
);
