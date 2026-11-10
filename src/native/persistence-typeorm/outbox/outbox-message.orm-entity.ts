import { Column, Entity, PrimaryColumn } from 'typeorm';

const EPOCH_MS = {
  to: (value: number): number => value,
  from: (value: string | number): number => Number(value),
};

/** Schema definido pela migration própria; o acesso usa SQL direto nas operações de lote. */
@Entity({ name: 'outbox_messages' })
export class OutboxMessageOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 128 })
  id!: string;

  @Column({ name: 'type', type: 'varchar', length: 128 })
  type!: string;

  @Column({ name: 'payload_version', type: 'integer' })
  payloadVersion!: number;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: unknown;

  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 128, nullable: true })
  tenantId!: string | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @Column({ name: 'trace_context', type: 'jsonb', nullable: true })
  traceContext!: Record<string, string> | null;

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state!: string;

  @Column({ name: 'attempts', type: 'integer' })
  attempts!: number;

  @Column({ name: 'next_attempt_at_ms', type: 'bigint', transformer: EPOCH_MS })
  nextAttemptAtMs!: number;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @Column({ name: 'created_at_ms', type: 'bigint', transformer: EPOCH_MS })
  createdAtMs!: number;

  @Column({
    name: 'published_at_ms',
    type: 'bigint',
    nullable: true,
    transformer: EPOCH_MS,
  })
  publishedAtMs!: number | null;

  @Column({ name: 'updated_at_ms', type: 'bigint', transformer: EPOCH_MS })
  updatedAtMs!: number;
}
