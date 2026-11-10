import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Epoch em ms cabe em inteiro seguro; o driver devolve bigint como string. */
const EPOCH_MS = {
  to: (value: number): number => value,
  from: (value: string | number): number => Number(value),
};

/**
 * Linha de auditoria append-only. O esquema vem da migration própria, que também
 * cria o trigger que bloqueia UPDATE e DELETE fora da purga de retenção. As
 * operações de escrita e leitura usam SQL explícito em `typeorm-audit-writer.ts`.
 */
@Entity({ name: 'audit_entries' })
export class AuditEntryOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 64 })
  id!: string;

  @Column({ name: 'occurred_at', type: 'bigint', transformer: EPOCH_MS })
  occurredAt!: number;

  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 128, nullable: true })
  tenantId!: string | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @Column({ name: 'action', type: 'varchar', length: 64 })
  action!: string;

  @Column({ name: 'target', type: 'varchar', length: 128 })
  target!: string;

  @Column({ name: 'outcome', type: 'varchar', length: 16 })
  outcome!: string;
}
