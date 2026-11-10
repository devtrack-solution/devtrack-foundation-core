import { CreateDateColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

/**
 * Colunas técnicas de auditoria e controle otimista. Herde nas entidades
 * `*.orm-entity.ts` do módulo. Não é entidade e não carrega regra de negócio.
 */
export abstract class TechnicalAuditColumns {
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn({ name: 'version' })
  version!: number;
}
