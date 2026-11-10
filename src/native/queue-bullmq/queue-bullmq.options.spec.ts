import {
  QueueBullmqConfigError,
  validateQueueBullmqOptions,
  type QueueBullmqOptions,
} from './queue-bullmq.options';

const base: QueueBullmqOptions = {
  connection: { host: 'redis.local', port: 6379, password: 'segredo-123' },
  retry: {
    globalMaxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    timeoutMs: 5000,
  },
  consumer: {
    concurrency: 4,
    lockDurationMs: 30_000,
    stalledIntervalMs: 30_000,
    maxStalledCount: 3,
    drainDeadlineMs: 30_000,
  },
};

function fieldOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueueBullmqConfigError) return error.field;
    throw error;
  }
  return '';
}

describe('validateQueueBullmqOptions', () => {
  it('aceita configuração válida e aplica padrões', () => {
    const validated = validateQueueBullmqOptions(base, { consume: true });

    expect(validated.queueName).toBe('foundation-jobs');
    expect(validated.maxPayloadBytes).toBe(65_536);
    expect(validated.consumer.concurrency).toBe(4);
  });

  it('rejeita concorrência fora do intervalo com o nome do campo', () => {
    const field = fieldOf(() =>
      validateQueueBullmqOptions(
        { ...base, consumer: { ...base.consumer!, concurrency: 0 } },
        { consume: true },
      ),
    );

    expect(field).toBe('consumer.concurrency');
  });

  it('exige bloco consumer quando o módulo consome jobs', () => {
    expect(
      fieldOf(() =>
        validateQueueBullmqOptions(
          { ...base, consumer: undefined },
          { consume: true },
        ),
      ),
    ).toBe('consumer');
  });

  it('não exige consumer para produtor puro', () => {
    expect(() =>
      validateQueueBullmqOptions(
        { ...base, consumer: undefined },
        { consume: false },
      ),
    ).not.toThrow();
  });

  it('nunca inclui o valor informado (senha) na mensagem de erro', () => {
    try {
      validateQueueBullmqOptions(
        {
          ...base,
          connection: { host: '', port: 6379, password: 'segredo-123' },
        },
        { consume: false },
      );
      throw new Error('esperado erro');
    } catch (error) {
      expect((error as Error).message).toBe(
        'queue_bullmq_config_invalid:connection.host',
      );
      expect((error as Error).message).not.toContain('segredo-123');
    }
  });

  it('rejeita baseDelayMs maior que maxDelayMs', () => {
    expect(
      fieldOf(() =>
        validateQueueBullmqOptions(
          { ...base, retry: { ...base.retry, baseDelayMs: 5000 } },
          { consume: false },
        ),
      ),
    ).toBe('retry.baseDelayMs');
  });
});
