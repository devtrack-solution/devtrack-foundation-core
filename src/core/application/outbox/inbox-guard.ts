import type { Clock } from '../security/authentication.ports';
import type { UnitOfWork } from '../persistence/unit-of-work.port';
import type { InboxStore } from './outbox.ports';

/** Recursos do consumidor: o registro de entrega participa da mesma transação do efeito. */
export interface InboxResources {
  readonly inbox: InboxStore;
}

export type InboxOutcome<Result> =
  | { readonly applied: true; readonly result: Result }
  | { readonly applied: false };

/**
 * Deduplicação de consumidor. Dentro de uma única transação registra o `messageId`
 * para o `consumerId` e aplica o efeito somente na primeira entrega. A constraint
 * (consumer_id, message_id) torna a decisão atômica mesmo com entregas concorrentes.
 *
 * O efeito recebe os recursos da transação e não deve fazer chamadas de rede.
 */
export class InboxGuard<Resources extends InboxResources> {
  constructor(
    private readonly unitOfWork: UnitOfWork<Resources>,
    private readonly clock: Clock,
  ) {}

  applyOnce<Result>(
    input: { readonly consumerId: string; readonly messageId: string },
    effect: (resources: Resources) => Promise<Result>,
  ): Promise<InboxOutcome<Result>> {
    return this.unitOfWork.run(async (resources) => {
      const first = await resources.inbox.register({
        consumerId: input.consumerId,
        messageId: input.messageId,
        now: this.clock.now(),
      });
      if (!first) return { applied: false } as const;
      const result = await effect(resources);
      return { applied: true, result } as const;
    });
  }
}
