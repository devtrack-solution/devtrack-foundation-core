import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TechnicalAuditColumns } from '../../../src/native/persistence-typeorm';

@Entity({ name: 'beta_notes' })
export class BetaNoteOrmEntity extends TechnicalAuditColumns {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  body!: string;
}
