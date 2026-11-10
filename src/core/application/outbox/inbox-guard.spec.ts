import type { InboxStore } from './outbox.ports';
import { InboxGuard } from './inbox-guard';
import type { UnitOfWork } from '../persistence/unit-of-work.port';

interface Resources {
  readonly inbox: InboxStore;
  readonly writes: string[];
}

function memoryUnitOfWork(): {
  uow: UnitOfWork<Resources>;
  seen: Set<string>;
  committed: string[];
} {
  const seen = new Set<string>();
  const committed: string[] = [];
  const uow: UnitOfWork<Resources> = {
    run: async (work) => {
      const writes: string[] = [];
      const pending = new Set<string>();
      const inbox: InboxStore = {
        register: ({ consumerId, messageId }) => {
          const key = `${consumerId}:${messageId}`;
          if (seen.has(key) || pending.has(key)) return Promise.resolve(false);
          pending.add(key);
          return Promise.resolve(true);
        },
      };
      const result = await work({ inbox, writes });
      for (const key of pending) seen.add(key);
      committed.push(...writes);
      return result;
    },
  };
  return { uow, seen, committed };
}

describe('InboxGuard', () => {
  it('aplica o efeito uma única vez para a mesma mensagem e consumidor', async () => {
    const { uow, committed } = memoryUnitOfWork();
    const guard = new InboxGuard(uow, { now: () => 1 });
    const effect = (r: Resources) => {
      r.writes.push('charge');
      return Promise.resolve('done');
    };

    expect(
      await guard.applyOnce({ consumerId: 'c', messageId: 'm' }, effect),
    ).toEqual({ applied: true, result: 'done' });
    expect(
      await guard.applyOnce({ consumerId: 'c', messageId: 'm' }, effect),
    ).toEqual({ applied: false });
    expect(committed).toEqual(['charge']);
  });

  it('a mesma mensagem é processada por outro consumidor', async () => {
    const { uow } = memoryUnitOfWork();
    const guard = new InboxGuard(uow, { now: () => 1 });
    const effect = () => Promise.resolve(null);
    await guard.applyOnce({ consumerId: 'a', messageId: 'm' }, effect);
    expect(
      await guard.applyOnce({ consumerId: 'b', messageId: 'm' }, effect),
    ).toEqual({ applied: true, result: null });
  });
});
