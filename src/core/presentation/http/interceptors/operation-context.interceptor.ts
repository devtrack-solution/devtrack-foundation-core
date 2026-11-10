import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AsyncOperationContextStore } from '../../../infrastructure/context/async-operation-context.store';
import { operationContextOf, type HttpRequestLike } from '../request-state';

/**
 * Estabelece o contexto autorizado pelo guard no AsyncLocalStorage. `run` cobre o
 * próprio handler e as continuações assíncronas dele; requisições sem contexto
 * seguem sem contexto, e `current()` lança.
 */
@Injectable()
export class OperationContextInterceptor implements NestInterceptor {
  constructor(private readonly store: AsyncOperationContextStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const operationContext = operationContextOf(request);
    if (operationContext === undefined) return next.handle();
    return this.store.run(operationContext, () => next.handle());
  }
}
