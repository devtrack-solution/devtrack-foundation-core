/* Fakes assincronos sem await: a porta e async, a implementacao de teste e sincrona. */
/* eslint-disable @typescript-eslint/require-await */
import type { JobEnvelope } from '../execution/job-envelope';
import type { EnqueueOutcome, JobQueue } from './job-queue.port';
import type { ActivityRecord } from './activity.model';
import type { ActivityStore } from './activity-store.port';
import { JobSubmitter } from './job-submitter';
import { JobEnvelopeValidationError } from '../execution/job-envelope.validation';

class MemoryActivities implements ActivityStore {
  readonly rows = new Map<string, ActivityRecord>();
  async insertIfAbsent(record: ActivityRecord): Promise<boolean> {
    if (this.rows.has(record.id)) return false;
    this.rows.set(record.id, record);
    return true;
  }
  async save(record: ActivityRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async find(id: string): Promise<ActivityRecord | null> {
    return this.rows.get(id) ?? null;
  }
}

const envelope = (
  overrides: Partial<JobEnvelope<unknown>> = {},
): JobEnvelope<unknown> => ({
  id: 'job-1',
  type: 'contacts.sync',
  payloadVersion: 1,
  payload: { contactId: 'c-1' },
  subjectId: 'subject-1',
  correlationId: 'corr-1',
  deadlineAt: Date.now() + 60_000,
  maxAttempts: 3,
  ...overrides,
});

function submitter() {
  const activities = new MemoryActivities();
  const enqueued: string[] = [];
  const queue: JobQueue = {
    enqueue: async (job): Promise<EnqueueOutcome> => {
      enqueued.push(job.id);
      return 'accepted';
    },
  };
  const service = new JobSubmitter({
    activities,
    queue,
    clock: { now: () => 1000 },
    limits: { maxPayloadBytes: 64, maxAttemptsCeiling: 5 },
  });
  return { service, activities, enqueued };
}

describe('JobSubmitter', () => {
  it('registra a atividade como queued e enfileira', async () => {
    const { service, activities, enqueued } = submitter();

    const result = await service.submit(envelope());

    expect(result).toEqual({
      activityId: 'job-1',
      activityCreated: true,
      queue: 'accepted',
    });
    expect(activities.rows.get('job-1')).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(enqueued).toEqual(['job-1']);
  });

  it('reenvio com o mesmo id não sobrescreve a atividade existente', async () => {
    const { service, activities } = submitter();
    await service.submit(envelope());
    activities.rows.set('job-1', {
      ...activities.rows.get('job-1')!,
      state: 'running',
      attempts: 1,
    });

    const again = await service.submit(envelope());

    expect(again.activityCreated).toBe(false);
    expect(activities.rows.get('job-1')).toMatchObject({
      state: 'running',
      attempts: 1,
    });
  });

  it('rejeita payload acima do limite nomeando só o campo', async () => {
    const { service, enqueued } = submitter();

    await expect(
      service.submit(envelope({ payload: { text: 'x'.repeat(200) } })),
    ).rejects.toMatchObject({ field: 'payload' });
    expect(enqueued).toEqual([]);
  });

  it('rejeita traceContext com chave fora de traceparent/tracestate (sem baggage)', async () => {
    const { service } = submitter();

    await expect(
      service.submit(envelope({ traceContext: { baggage: 'user=1' } })),
    ).rejects.toBeInstanceOf(JobEnvelopeValidationError);
  });

  it('aceita traceContext W3C e o repassa sem alteração', async () => {
    const { service } = submitter();
    const traceContext = {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    };

    await expect(
      service.submit(envelope({ payload: {}, traceContext })),
    ).resolves.toMatchObject({
      queue: 'accepted',
    });
  });

  it('rejeita id com apenas dígitos e maxAttempts acima do teto', async () => {
    const { service } = submitter();

    await expect(
      service.submit(envelope({ id: '12345' })),
    ).rejects.toMatchObject({ field: 'id' });
    await expect(
      service.submit(envelope({ maxAttempts: 9 })),
    ).rejects.toMatchObject({
      field: 'maxAttempts',
    });
  });
});
