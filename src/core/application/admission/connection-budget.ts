import { AdmissionConfigError, requireInteger } from './admission.config';

/**
 * Orçamento de conexões do banco. Soma os pools de todos os processos que
 * acessam o mesmo banco: réplicas da API, workers e a reserva para operações
 * administrativas. Aumentar réplicas aumenta a soma, não só um processo.
 */
export interface ConnectionBudgetInput {
  /** Limite de conexões do servidor de banco (max_connections ou equivalente). */
  readonly maxDatabaseConnections: number;
  readonly apiReplicas: number;
  /** Pool máximo de cada réplica da API. */
  readonly poolMaxPerReplica: number;
  readonly workerProcesses: number;
  /** Pool máximo de cada processo worker. Ignorado quando não há workers. */
  readonly poolMaxPerWorker: number;
  /** Conexões reservadas para migrações, manutenção e monitoração. */
  readonly reservedConnections: number;
}

export interface ConnectionBudget {
  readonly requested: number;
  readonly limit: number;
  readonly headroom: number;
}

export class ConnectionBudgetError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid connection budget: ${issues.join('; ')}`);
    this.name = 'ConnectionBudgetError';
  }
}

/** Calcula e verifica o orçamento. Lança `ConnectionBudgetError` com os campos inválidos ou o excesso. */
export function evaluateConnectionBudget(
  input: ConnectionBudgetInput,
): ConnectionBudget {
  if (input === null || typeof input !== 'object')
    throw new AdmissionConfigError('connectionBudget');
  const issues: string[] = [];
  const check = (field: string, min: number, max: number): number | null => {
    try {
      return requireInteger(
        input[field as keyof ConnectionBudgetInput],
        field,
        min,
        max,
      );
    } catch {
      issues.push(`${field} fora da faixa ${min}-${max}`);
      return null;
    }
  };
  const limit = check('maxDatabaseConnections', 1, 100_000);
  const replicas = check('apiReplicas', 1, 1_000);
  const poolReplica = check('poolMaxPerReplica', 1, 1_000);
  const workers = check('workerProcesses', 0, 1_000);
  const poolWorker =
    input.workerProcesses === 0 ? 0 : check('poolMaxPerWorker', 1, 1_000);
  const reserved = check('reservedConnections', 0, 1_000);
  if (issues.length > 0) throw new ConnectionBudgetError(issues);

  const requested =
    (replicas as number) * (poolReplica as number) +
    (workers as number) * (poolWorker ?? 0) +
    (reserved as number);
  if (requested > (limit as number))
    throw new ConnectionBudgetError([
      `soma ${requested} excede o limite do banco ${limit}`,
    ]);
  return {
    requested,
    limit: limit as number,
    headroom: (limit as number) - requested,
  };
}
