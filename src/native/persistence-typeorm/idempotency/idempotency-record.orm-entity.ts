import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Epoch em ms cabe em inteiro seguro; o driver devolve bigint como string. */
const EPOCH_MS = {
  to: (value: number): number => value,
  from: (value: string | number): number => Number(value),
};

const NULLABLE_EPOCH_MS = {
  to: (value: number | null): number | null => value,
  from: (value: string | number | null): number | null =>
    value === null ? null : Number(value),
};

/**
 * Registro de intenção idempotente. Esquema definido pela migration própria;
 * o store usa SQL direto nas operações de reivindicação e de fencing para garantir atomicidade.
 */
@Entity({ name: 'idempotency_records' })
export class IdempotencyRecordOrmEntity {
  @PrimaryGeneratedColumn({ name: 'id', type: 'integer' })
  id!: number;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 64,
    unique: true,
  })
  key!: string;

  @Column({ name: 'operation_id', type: 'varchar', length: 64 })
  operationId!: string;

  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 128, nullable: true })
  tenantId!: string | null;

  @Column({ name: 'fingerprint', type: 'varchar', length: 64 })
  fingerprint!: string;

  @Column({ name: 'state', type: 'varchar', length: 24 })
  state!: string;

  @Column({ name: 'claim_token', type: 'varchar', length: 64 })
  claimToken!: string;

  @Column({ name: 'result', type: 'jsonb', nullable: true })
  result!: unknown;

  @Column({
    name: 'failure_class',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  failureClass!: string | null;

  @Column({ name: 'created_at_ms', type: 'bigint', transformer: EPOCH_MS })
  createdAtMs!: number;

  @Column({ name: 'updated_at_ms', type: 'bigint', transformer: EPOCH_MS })
  updatedAtMs!: number;

  @Column({ name: 'expires_at_ms', type: 'bigint', transformer: EPOCH_MS })
  expiresAtMs!: number;

  /** Fim do lease do executor; nulo fora de `in_progress`. */
  @Column({
    name: 'lease_expires_at_ms',
    type: 'bigint',
    nullable: true,
    transformer: NULLABLE_EPOCH_MS,
  })
  leaseExpiresAtMs!: number | null;

  /** Incrementa a cada reivindicação e transição; fencing token da etapa 4.2. */
  @Column({ name: 'version', type: 'integer', default: 1 })
  version!: number;
}
