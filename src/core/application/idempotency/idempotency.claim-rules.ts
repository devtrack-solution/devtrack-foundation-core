import type { IdempotencyRecord } from './idempotency.types';

/**
 * Regra única de reivindicabilidade. Os stores devem aplicá-la numa única operação
 * atômica (o store TypeORM a traduz para a cláusula WHERE do upsert).
 *
 * - `failed_retryable`: sempre reivindicável, com qualquer fingerprint.
 * - `in_progress`: reivindicável só com lease vencido e, cumulativamente, ou o mesmo
 *   fingerprint (recuperação do mesmo intento) ou retenção vencida (novo intento).
 *   Lease vigente nunca é tomado.
 * - demais estados: reivindicáveis só após a retenção vencer.
 */
export function isClaimable(
  record: Pick<
    IdempotencyRecord,
    'state' | 'expiresAt' | 'leaseExpiresAt' | 'fingerprint'
  >,
  now: number,
  fingerprint: string,
): boolean {
  switch (record.state) {
    case 'failed_retryable':
      return true;
    case 'in_progress':
      return (
        record.leaseExpiresAt !== null &&
        record.leaseExpiresAt <= now &&
        (record.fingerprint === fingerprint || record.expiresAt <= now)
      );
    default:
      return record.expiresAt <= now;
  }
}
