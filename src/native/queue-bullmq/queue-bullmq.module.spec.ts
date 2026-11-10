import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ACTIVITY_STORE,
  JOB_IDENTITY_RESOLVER,
} from '../../core/application/activities/activities.tokens';
import { QueueBullmqModule } from './queue-bullmq.module';
import { QueueBullmqConfigError } from './queue-bullmq.options';

const HOST_OPTIONS = Symbol('test.queue-bullmq.options');
const RETRY = {
  globalMaxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  timeoutMs: 30_000,
};
/** Portas mínimas do host: o erro de configuração deve ocorrer antes de qualquer conexão. */
const PORTS = [
  { provide: ACTIVITY_STORE, useValue: {} },
  { provide: JOB_IDENTITY_RESOLVER, useValue: {} },
];

describe('QueueBullmqModule.registerAsync', () => {
  it('rejeita configuração inválida vinda do host na criação do módulo', async () => {
    @Module({
      providers: [
        {
          provide: HOST_OPTIONS,
          useValue: { connection: { host: '', port: 6379 }, retry: RETRY },
        },
      ],
      exports: [HOST_OPTIONS],
    })
    class HostModule {}

    const moduleRef = QueueBullmqModule.registerAsync({
      imports: [HostModule],
      inject: [HOST_OPTIONS],
      useFactory: (options: unknown) => options as never,
      ports: PORTS,
    });

    await expect(
      Test.createTestingModule({ imports: [moduleRef] }).compile(),
    ).rejects.toThrow('queue_bullmq_config_invalid:connection.host');
  });

  it('exige bloco consumer quando o módulo consome, como o register', async () => {
    const moduleRef = QueueBullmqModule.registerAsync({
      consume: true,
      useFactory: () => ({
        connection: { host: 'localhost', port: 6379 },
        retry: RETRY,
      }),
      ports: PORTS,
    });

    await expect(
      Test.createTestingModule({ imports: [moduleRef] }).compile(),
    ).rejects.toThrow('queue_bullmq_config_invalid:consumer');
  });

  it('exige useFactory', () => {
    expect(() =>
      QueueBullmqModule.registerAsync({
        ports: PORTS,
        useFactory: undefined as unknown as () => never,
      }),
    ).toThrow(QueueBullmqConfigError);
  });
});
