import type { ActivityRecord } from './activity.model';

export interface ActivityStore {
  /** Insere somente se a id ainda não existir. Devolve false em duplicata (não sobrescreve). */
  insertIfAbsent(record: ActivityRecord): Promise<boolean>;
  /** Grava o estado da atividade. Adapter ignora escrita com `attempts` menor que a gravada. */
  save(record: ActivityRecord): Promise<void>;
  /** `tenantId` null consulta somente atividades sem tenant. Nunca cruza tenants. */
  find(id: string, tenantId: string | null): Promise<ActivityRecord | null>;
}
