import { OUTBOX_LIMITS, type OutboxIntent } from './outbox.model';
import {
  OutboxValidationError,
  validateOutboxIntent,
} from './outbox.validation';

const valid: OutboxIntent = {
  id: 'msg-1',
  type: 'orders.created',
  payloadVersion: 1,
  payload: { ok: true },
  subjectId: 'subject-1',
  correlationId: 'corr-1',
};

describe('validateOutboxIntent', () => {
  it('aceita intenção válida', () => {
    expect(() => validateOutboxIntent(valid)).not.toThrow();
  });

  it.each([
    ['id', { id: '123' }],
    ['type', { type: 'Orders' }],
    ['payloadVersion', { payloadVersion: 0 }],
    ['subjectId', { subjectId: 'bad id' }],
    ['correlationId', { correlationId: '' }],
    ['tenantId', { tenantId: 'x'.repeat(200) }],
    ['traceContext', { traceContext: { baggage: 'k=v' } }],
  ])('rejeita campo inválido %s nomeando só o campo', (field, change) => {
    expect(() => validateOutboxIntent({ ...valid, ...change })).toThrow(
      new OutboxValidationError(field),
    );
  });

  it('rejeita payload acima do limite', () => {
    const payload = { blob: 'x'.repeat(OUTBOX_LIMITS.maxPayloadBytes) };
    expect(() => validateOutboxIntent({ ...valid, payload })).toThrow(
      'outbox_invalid:payload',
    );
  });
});
