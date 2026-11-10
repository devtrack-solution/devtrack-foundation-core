import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

const EPOCH_MS = {
  to: (value: number | null): number | null => value,
  from: (value: string | number | null): number | null =>
    value === null ? null : Number(value),
};

/** Refresh token persistido apenas como digest SHA-256. Família = sessão. */
@Entity({ name: 'auth_refresh_tokens' })
export class AuthRefreshTokenOrmEntity {
  @PrimaryGeneratedColumn({ name: 'id', type: 'integer' })
  id!: number;

  @Column({ name: 'digest', type: 'varchar', length: 64, unique: true })
  digest!: string;

  @Column({ name: 'session_id', type: 'varchar', length: 64 })
  sessionId!: string;

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state!: string;

  @Column({
    name: 'successor_digest',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  successorDigest!: string | null;

  @Column({
    name: 'consumed_at',
    type: 'bigint',
    nullable: true,
    transformer: EPOCH_MS,
  })
  consumedAt!: number | null;

  @Column({ name: 'client_binding_digest', type: 'varchar', length: 64 })
  clientBindingDigest!: string;

  @Column({ name: 'idle_expires_at', type: 'bigint', transformer: EPOCH_MS })
  idleExpiresAt!: number;

  @Column({ name: 'created_at', type: 'bigint', transformer: EPOCH_MS })
  createdAt!: number;
}
