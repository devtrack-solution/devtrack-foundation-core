import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Epoch em ms cabe em inteiro seguro; o driver devolve bigint como string. */
const EPOCH_MS = {
  to: (value: number): number => value,
  from: (value: string | number): number => Number(value),
};

/**
 * Registro de atividade. Esquema definido pela migration própria; o store usa
 * SQL direto para o upsert monotônico por `attempts`.
 */
@Entity({ name: 'activities' })
export class ActivityOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 64 })
  id!: string;

  @Column({ name: 'type', type: 'varchar', length: 128 })
  type!: string;

  @Column({ name: 'state', type: 'varchar', length: 24 })
  state!: string;

  @Column({ name: 'attempts', type: 'integer' })
  attempts!: number;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 128, nullable: true })
  tenantId!: string | null;

  @Column({ name: 'created_at_ms', type: 'bigint', transformer: EPOCH_MS })
  createdAtMs!: number;

  @Column({ name: 'updated_at_ms', type: 'bigint', transformer: EPOCH_MS })
  updatedAtMs!: number;

  @Column({ name: 'version', type: 'integer', default: 1 })
  version!: number;
}
