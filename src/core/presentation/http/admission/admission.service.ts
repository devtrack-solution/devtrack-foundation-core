import { createHmac } from 'node:crypto';
import type {
  AdmissionGate,
  AdmissionGrant,
  AdmissionRejection,
  AdmissionSnapshot,
} from '../../../application/admission/admission.gate';
import type {
  AdmissionLimits,
  RateLimitPolicy,
} from '../../../application/admission/admission.config';
import {
  rateLimitKeyFor,
  type RateLimitResult,
  type RateLimitSubject,
  type ResilientRateLimiter,
} from '../../../application/admission/rate-limit';
import {
  evaluateReadiness,
  type ReadinessCheck,
} from '../../../application/admission/readiness';
import type { OperationSignals } from '../../../application/observability/signal-contracts';
import {
  ADMISSION_SIGNAL,
  recordAdmissionRejection,
  recordRateLimitRejection,
  recordSignal,
  type AdmissionRejectionReason,
} from './admission.signals';

export interface AdmissionServiceDeps {
  readonly limits: AdmissionLimits;
  readonly gate: AdmissionGate;
  readonly exemptPaths: readonly string[];
  readonly checks: readonly ReadinessCheck[];
  readonly readinessTimeoutMs: number;
  readonly signals: OperationSignals;
  readonly rateLimit?: {
    readonly limiter: ResilientRateLimiter;
    readonly policy: RateLimitPolicy;
    readonly digestSecret: string;
  };
}

const REJECTION_REASON: Record<AdmissionRejection, AdmissionRejectionReason> = {
  queue_full: 'queue-full',
  queue_timeout: 'queue-timeout',
  draining: 'draining',
};

/**
 * Ponto único da admissão, rate limit, prontidão e drenagem de um processo. É
 * um provider opt-in: sem `AdmissionModule.register`, nada disso existe.
 */
export class AdmissionService {
  constructor(private readonly deps: AdmissionServiceDeps) {}

  /** Pede uma vaga; rejeita com `AdmissionRejectedError` quando saturado ou drenando. */
  admit(): Promise<AdmissionGrant> {
    return this.deps.gate.acquire();
  }

  isExempt(path: string): boolean {
    return this.deps.exemptPaths.includes(path);
  }

  snapshot(): AdmissionSnapshot {
    return this.deps.gate.snapshot();
  }

  get retryAfterSeconds(): number {
    return this.deps.limits.retryAfterSeconds;
  }

  get rateLimitEnabled(): boolean {
    return this.deps.rateLimit !== undefined;
  }

  /** Aplica o rate limit à chave do principal ou do IP (digest; o IP bruto não é guardado). */
  async rateLimit(
    subject: { tenantId?: string; subjectId?: string } | { address: string },
  ): Promise<RateLimitResult | undefined> {
    const limit = this.deps.rateLimit;
    if (limit === undefined) return undefined;
    const identity: RateLimitSubject =
      'address' in subject
        ? { addressDigest: this.digestAddress(subject.address) }
        : {
            ...(subject.tenantId === undefined
              ? {}
              : { tenantId: subject.tenantId }),
            subjectId: subject.subjectId,
          };
    const result = await limit.limiter.consume(
      rateLimitKeyFor(identity),
      limit.policy,
    );
    if (result.outcome === 'allowed')
      recordSignal(
        this.deps.signals,
        ADMISSION_SIGNAL.rateAllowed,
        'succeeded',
      );
    else if (result.outcome === 'limited')
      recordRateLimitRejection(this.deps.signals, 'limit-exceeded');
    else recordRateLimitRejection(this.deps.signals, 'store-unavailable');
    return result;
  }

  /** Readiness: falso durante drenagem ou com dependência obrigatória indisponível. */
  isReady(): Promise<boolean> {
    return evaluateReadiness({
      draining: this.deps.gate.draining,
      checks: this.deps.checks,
      timeoutMs: this.deps.readinessTimeoutMs,
    });
  }

  /**
   * Marca não pronto, rejeita novas entradas e aguarda as em voo até o prazo.
   * Resolve `true` quando nada restou em voo, `false` quando o prazo expirou.
   */
  beginDrain(
    deadlineMs: number = this.deps.limits.drainDeadlineMs,
  ): Promise<boolean> {
    this.deps.gate.beginDrain();
    return this.deps.gate.drain(deadlineMs);
  }

  /** Gancho do Nest no encerramento: drena antes de o servidor HTTP fechar. */
  async drainOnShutdown(): Promise<void> {
    await this.beginDrain();
  }

  recordAdmitted(queued: boolean, waitedMs: number): void {
    recordSignal(this.deps.signals, ADMISSION_SIGNAL.admitted, 'succeeded');
    if (!queued) return;
    recordSignal(this.deps.signals, ADMISSION_SIGNAL.queued, 'succeeded');
    recordSignal(
      this.deps.signals,
      ADMISSION_SIGNAL.queueWait,
      'succeeded',
      waitedMs,
    );
  }

  recordRejected(reason: AdmissionRejection | 'unknown'): void {
    recordAdmissionRejection(
      this.deps.signals,
      reason === 'unknown' ? 'draining' : REJECTION_REASON[reason],
    );
  }

  private digestAddress(address: string): string {
    const secret = this.deps.rateLimit?.digestSecret ?? '';
    return createHmac('sha256', secret)
      .update(address)
      .digest('hex')
      .slice(0, 32);
  }
}
