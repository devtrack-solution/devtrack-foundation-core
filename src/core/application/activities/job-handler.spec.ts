/* Fakes assincronos sem await: a porta e async, a implementacao de teste e sincrona. */
/* eslint-disable @typescript-eslint/require-await */
import type { JobEnvelope } from '../execution/job-envelope';
import {
  JobHandlerRegistrationError,
  JobHandlerRegistry,
  type JobHandler,
} from './job-handler';

const handler = (type: string, payloadVersion = 1): JobHandler => ({
  type,
  payloadVersion,
  handle: async () => undefined,
});

const envelopeOf = (
  type: string,
  payloadVersion: number,
): Pick<JobEnvelope<unknown>, 'type' | 'payloadVersion'> => ({
  type,
  payloadVersion,
});

describe('JobHandlerRegistry', () => {
  it('resolve o handler pelo type quando a versão de payload confere', () => {
    const registry = new JobHandlerRegistry([handler('contacts.sync', 2)]);

    const lookup = registry.lookup(envelopeOf('contacts.sync', 2));

    expect(lookup.kind).toBe('found');
  });

  it('rejeita registro de type duplicado com código estável', () => {
    const registry = new JobHandlerRegistry([handler('contacts.sync')]);

    expect(() => registry.register(handler('contacts.sync'))).toThrow(
      JobHandlerRegistrationError,
    );
    try {
      registry.register(handler('contacts.sync'));
    } catch (error) {
      expect((error as JobHandlerRegistrationError).code).toBe(
        'job_handler_duplicate_type',
      );
    }
  });

  it('rejeita handler com type ou versão inválidos', () => {
    const registry = new JobHandlerRegistry();

    expect(() => registry.register(handler('Bad Type'))).toThrow(
      JobHandlerRegistrationError,
    );
    expect(() => registry.register(handler('ok.type', 0))).toThrow(
      JobHandlerRegistrationError,
    );
  });

  it('devolve unknown_type para type não registrado', () => {
    const registry = new JobHandlerRegistry([handler('a.b')]);

    expect(registry.lookup(envelopeOf('x.y', 1))).toEqual({
      kind: 'unknown_type',
    });
  });

  it('devolve unsupported_version quando a versão de payload é desconhecida', () => {
    const registry = new JobHandlerRegistry([handler('a.b', 1)]);

    expect(registry.lookup(envelopeOf('a.b', 2))).toEqual({
      kind: 'unsupported_version',
    });
  });
});
