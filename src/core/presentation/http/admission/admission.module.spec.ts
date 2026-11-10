import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  AdmissionModule,
  type AdmissionRegistration,
} from './admission.module';
import { AdmissionConfigError } from '../../../application/admission/admission.config';

const TOKEN = Symbol.for('test.rate-store');
const SECRET = 'a'.repeat(16);

function registration(
  patch: Partial<AdmissionRegistration> = {},
): AdmissionRegistration {
  return {
    admission: { maxInFlight: 2, maxQueue: 2, maxQueueWaitMs: 100 },
    ...patch,
  };
}

describe('AdmissionModule.register (validação do registro)', () => {
  it('monta o módulo com health e sem rate limit quando não configurado', () => {
    const dynamic = AdmissionModule.register(registration());
    expect(dynamic.module).toBe(AdmissionModule);
    expect(dynamic.controllers).toHaveLength(1);
    expect(
      dynamic.providers?.some(
        (p) =>
          typeof p === 'object' &&
          'provide' in p &&
          p.provide === 'APP_INTERCEPTOR',
      ),
    ).toBe(false);
  });

  it('registra o interceptor de rate limit somente quando configurado', () => {
    const dynamic = AdmissionModule.register(
      registration({
        rateLimit: {
          store: TOKEN,
          policy: { limit: 5, windowMs: 60_000 },
          keyDigestSecret: SECRET,
        },
      }),
    );
    const interceptor = dynamic.providers?.find(
      (p) =>
        typeof p === 'object' &&
        'provide' in p &&
        p.provide === APP_INTERCEPTOR,
    );
    expect(interceptor).toBeDefined();
  });

  it('rejeita limites inválidos antes de montar qualquer provider', () => {
    expect(() =>
      AdmissionModule.register(
        registration({
          admission: { maxInFlight: 0, maxQueue: 1, maxQueueWaitMs: 1 },
        }),
      ),
    ).toThrow(new AdmissionConfigError('maxInFlight'));
  });

  it('exige segredo de digest com pelo menos 16 caracteres', () => {
    expect(() =>
      AdmissionModule.register(
        registration({
          rateLimit: {
            store: TOKEN,
            policy: { limit: 5, windowMs: 60_000 },
            keyDigestSecret: 'curto',
          },
        }),
      ),
    ).toThrow('Invalid admission configuration: rateLimit.keyDigestSecret');
  });

  it('rejeita política de falha desconhecida e fração de fallback fora de (0, 1]', () => {
    const base = {
      store: TOKEN,
      policy: { limit: 5, windowMs: 60_000 },
      keyDigestSecret: SECRET,
    };
    expect(() =>
      AdmissionModule.register(
        registration({
          rateLimit: { ...base, failurePolicy: 'open' as never },
        }),
      ),
    ).toThrow('rateLimit.failurePolicy');
    expect(() =>
      AdmissionModule.register(
        registration({ rateLimit: { ...base, localFallbackRatio: 0 } }),
      ),
    ).toThrow('rateLimit.localFallbackRatio');
  });

  it('rejeita caminhos de exceção que não começam com barra', () => {
    expect(() =>
      AdmissionModule.register(registration({ exemptPaths: ['health/live'] })),
    ).toThrow('exemptPaths[0]');
  });
});
