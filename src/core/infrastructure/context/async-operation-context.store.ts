import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationContext } from '../../application/context/operation-context';
import {
  OperationContextUnavailableError,
  type OperationContextAccessor,
} from '../../application/context/operation-context.accessor';

/**
 * Contexto por requisição via AsyncLocalStorage. Cada execução assíncrona
 * enxerga apenas o contexto com que foi iniciada por `run`.
 */
export class AsyncOperationContextStore implements OperationContextAccessor {
  private readonly storage = new AsyncLocalStorage<OperationContext>();

  current(): OperationContext {
    const context = this.storage.getStore();
    if (context === undefined) throw new OperationContextUnavailableError();
    return context;
  }

  run<T>(context: OperationContext, work: () => T): T {
    return this.storage.run(context, work);
  }
}
