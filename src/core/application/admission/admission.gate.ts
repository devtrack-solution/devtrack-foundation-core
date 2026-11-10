import type { AdmissionLimits } from './admission.config';

export type AdmissionRejection = 'queue_full' | 'queue_timeout' | 'draining';

export class AdmissionRejectedError extends Error {
  constructor(readonly reason: AdmissionRejection) {
    super(`admission_rejected:${reason}`);
    this.name = 'AdmissionRejectedError';
  }
}

export interface AdmissionPermit {
  /** Libera a vaga. Chamadas repetidas não têm efeito. */
  release(): void;
}

export interface AdmissionSnapshot {
  readonly inFlight: number;
  readonly queueDepth: number;
  readonly maxInFlight: number;
  readonly maxQueue: number;
  readonly draining: boolean;
  readonly admitted: number;
  readonly queued: number;
  readonly rejectedQueueFull: number;
  readonly rejectedQueueTimeout: number;
  readonly rejectedDraining: number;
}

/** Vaga concedida, com indicação e tempo de espera na fila. */
export interface AdmissionGrant {
  readonly permit: AdmissionPermit;
  /** Verdadeiro quando a requisição esperou na fila antes da vaga. */
  readonly queued: boolean;
  readonly waitedMs: number;
}

interface Waiter {
  readonly enqueuedAt: number;
  readonly resolve: (grant: AdmissionGrant) => void;
  readonly reject: (error: AdmissionRejectedError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Controle de admissão por processo: no máximo `maxInFlight` vagas ativas e até
 * `maxQueue` esperas, cada uma com prazo. A fila é limitada por construção, então
 * saturação nunca acumula memória ilimitada. Pura: o relógio é injetado.
 */
export class AdmissionGate {
  private inFlight = 0;
  private readonly queue: Waiter[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private isDraining = false;
  private counters = {
    admitted: 0,
    queued: 0,
    rejectedQueueFull: 0,
    rejectedQueueTimeout: 0,
    rejectedDraining: 0,
  };

  constructor(
    private readonly limits: AdmissionLimits,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get draining(): boolean {
    return this.isDraining;
  }

  acquire(): Promise<AdmissionGrant> {
    if (this.isDraining) {
      this.counters.rejectedDraining += 1;
      return Promise.reject(new AdmissionRejectedError('draining'));
    }
    if (this.inFlight < this.limits.maxInFlight) {
      this.inFlight += 1;
      this.counters.admitted += 1;
      return Promise.resolve({
        permit: this.permitFor(),
        queued: false,
        waitedMs: 0,
      });
    }
    if (this.queue.length >= this.limits.maxQueue) {
      this.counters.rejectedQueueFull += 1;
      return Promise.reject(new AdmissionRejectedError('queue_full'));
    }
    return new Promise<AdmissionGrant>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: this.clock(),
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        this.counters.rejectedQueueTimeout += 1;
        reject(new AdmissionRejectedError('queue_timeout'));
      }, this.limits.maxQueueWaitMs);
      this.queue.push(waiter);
      this.counters.queued += 1;
    });
  }

  /** Para de aceitar entradas; esperas na fila são rejeitadas agora. */
  beginDrain(): void {
    if (this.isDraining) return;
    this.isDraining = true;
    for (const waiter of this.queue.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      this.counters.rejectedDraining += 1;
      waiter.reject(new AdmissionRejectedError('draining'));
    }
  }

  /**
   * Aguarda as vagas ativas serem liberadas. Resolve `true` quando ociosa e
   * `false` quando o prazo expira com trabalho ainda em voo.
   */
  drain(deadlineMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = this.idleWaiters.indexOf(onIdle);
        if (index !== -1) this.idleWaiters.splice(index, 1);
        resolve(false);
      }, deadlineMs);
      this.idleWaiters.push(onIdle);
    });
  }

  snapshot(): AdmissionSnapshot {
    return {
      inFlight: this.inFlight,
      queueDepth: this.queue.length,
      maxInFlight: this.limits.maxInFlight,
      maxQueue: this.limits.maxQueue,
      draining: this.isDraining,
      ...this.counters,
    };
  }

  private permitFor(): AdmissionPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.handOff();
      },
    };
  }

  /** Transfere a vaga liberada ao próximo da fila ou reduz a ocupação. */
  private handOff(): void {
    const next = this.queue.shift();
    if (next !== undefined && !this.isDraining) {
      if (next.timer !== undefined) clearTimeout(next.timer);
      this.counters.admitted += 1;
      next.resolve({
        permit: this.permitFor(),
        queued: true,
        waitedMs: Math.max(0, this.clock() - next.enqueuedAt),
      });
      return;
    }
    this.inFlight -= 1;
    if (this.inFlight === 0) {
      for (const notify of this.idleWaiters.splice(0)) notify();
    }
  }
}
