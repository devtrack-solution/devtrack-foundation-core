/**
 * Contrato de mapeamento entre o modelo do módulo e o registro persistido.
 * Cada módulo implementa o seu; a Foundation não impõe formato de domínio.
 */
export interface PersistenceMapper<Model, Record> {
  toRecord(model: Model): Record;
  toModel(record: Record): Model;
}
