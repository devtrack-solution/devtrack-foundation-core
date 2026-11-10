import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TechnicalAuditColumns } from '../../../src/native/persistence-typeorm';

@Entity({ name: 'alpha_items' })
export class AlphaItemOrmEntity extends TechnicalAuditColumns {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  label!: string;
}
