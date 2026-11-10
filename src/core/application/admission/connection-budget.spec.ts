import {
  ConnectionBudgetError,
  evaluateConnectionBudget,
  type ConnectionBudgetInput,
} from './connection-budget';

const base: ConnectionBudgetInput = {
  maxDatabaseConnections: 100,
  apiReplicas: 2,
  poolMaxPerReplica: 20,
  workerProcesses: 1,
  poolMaxPerWorker: 10,
  reservedConnections: 5,
};

describe('evaluateConnectionBudget', () => {
  it('aceita combinação dentro do orçamento e informa folga', () => {
    expect(evaluateConnectionBudget(base)).toEqual({
      requested: 2 * 20 + 1 * 10 + 5,
      limit: 100,
      headroom: 100 - 55,
    });
  });

  it('aceita orçamento exato no limite do banco', () => {
    expect(
      evaluateConnectionBudget({ ...base, maxDatabaseConnections: 55 })
        .headroom,
    ).toBe(0);
  });

  it('rejeita soma acima do limite do banco ao escalar réplicas', () => {
    expect(() => evaluateConnectionBudget({ ...base, apiReplicas: 5 })).toThrow(
      ConnectionBudgetError,
    );
  });

  it('sem workers, o pool do worker não entra na soma', () => {
    const result = evaluateConnectionBudget({
      ...base,
      workerProcesses: 0,
      poolMaxPerWorker: 0,
    });
    expect(result.requested).toBe(45);
  });

  it.each([
    ['apiReplicas', { apiReplicas: 0 }],
    ['poolMaxPerReplica', { poolMaxPerReplica: 0 }],
    ['maxDatabaseConnections', { maxDatabaseConnections: 0 }],
    ['reservedConnections', { reservedConnections: -1 }],
    ['poolMaxPerWorker', { poolMaxPerWorker: 0 }],
  ])('rejeita valor inválido em %s', (field, patch) => {
    let caught: unknown;
    try {
      evaluateConnectionBudget({ ...base, ...patch });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConnectionBudgetError);
    expect((caught as ConnectionBudgetError).issues.join(' ')).toContain(field);
  });
});
