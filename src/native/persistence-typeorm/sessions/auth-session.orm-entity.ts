import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Epoch em ms cabe em inteiro seguro; o driver devolve bigint como string. */
const EPOCH_MS = {
  to: (value: number | null): number | null => value,
  from: (value: string | number | null): number | null =>
    value === null ? null : Number(value),
};

/** Sessão compartilhada entre réplicas. Esquema definido pela migration própria. */
@Entity({ name: 'auth_sessions' })
export class AuthSessionOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 64 })
  id!: string;

  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 128, nullable: true })
  tenantId!: string | null;

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state!: string;

  /** `password` ou `federated:<providerId>`. */
  @Column({ name: 'method', type: 'varchar', length: 160 })
  method!: string;

  @Column({ name: 'created_at', type: 'bigint', transformer: EPOCH_MS })
  createdAt!: number;

  /** Expiração absoluta. Renovar nunca a estende. */
  @Column({ name: 'expires_at', type: 'bigint', transformer: EPOCH_MS })
  expiresAt!: number;

  @Column({
    name: 'revoked_at',
    type: 'bigint',
    nullable: true,
    transformer: EPOCH_MS,
  })
  revokedAt!: number | null;
}
