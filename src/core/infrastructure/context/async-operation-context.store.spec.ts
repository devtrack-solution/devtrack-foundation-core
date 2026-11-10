import type { OperationContext } from '../../application/context/operation-context';
import { OperationContextUnavailableError } from '../../application/context/operation-context.accessor';
import { AsyncOperationContextStore } from './async-operation-context.store';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function contextFor(index: number): OperationContext {
  return {
    correlationId: `corr-${index}`,
    principal: {
      subjectId: `subject-${index}`,
      tenantId: index % 2 === 0 ? 'tenant-a' : 'tenant-b',
      permissions: [],
    },
    deadlineAt: 1_000_000 + index,
  };
}

describe('AsyncOperationContextStore', () => {
  it('lança quando não há contexto estabelecido', () => {
    const store = new AsyncOperationContextStore();
    expect(() => store.current()).toThrow(OperationContextUnavailableError);
  });

  it('restaura o contexto externo após um run aninhado', async () => {
    const store = new AsyncOperationContextStore();
    const outer = contextFor(1);
    const inner = contextFor(2);
    await store.run(outer, async () => {
      await delay(1);
      await store.run(inner, async () => {
        await delay(1);
        expect(store.current()).toBe(inner);
      });
      expect(store.current()).toBe(outer);
    });
    expect(() => store.current()).toThrow(OperationContextUnavailableError);
  });

  it('isola atores e tenants em execuções concorrentes intercaladas', async () => {
    const store = new AsyncOperationContextStore();
    const executions = Array.from({ length: 80 }, (_, index) => {
      const context = contextFor(index);
      return store.run(context, async () => {
        const seen: OperationContext[] = [];
        for (let step = 0; step < 6; step += 1) {
          await delay(Math.floor(Math.random() * 4));
          seen.push(store.current());
        }
        return seen.every((current) => current === context);
      });
    });
    const results = await Promise.all(executions);
    expect(results.every(Boolean)).toBe(true);
  });

  it('preserva a correlação através de awaits encadeados', async () => {
    const store = new AsyncOperationContextStore();
    const context = contextFor(7);
    const correlation = await store.run(context, async () => {
      await delay(2);
      await Promise.resolve();
      await delay(1);
      return store.current().correlationId;
    });
    expect(correlation).toBe('corr-7');
  });
});
