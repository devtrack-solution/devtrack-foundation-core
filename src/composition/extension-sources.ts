import type { ExtensionSource } from '../core/infrastructure/composition/composition-profile';

/**
 * Registro explícito das extensões npm que o gerador conhece. Cada entrada traz
 * o descriptor com origem npm completa e o export do módulo Nest do pacote.
 * Vazio enquanto nenhuma extensão for instalada e selecionada.
 */
export const EXTENSION_SOURCES: readonly ExtensionSource[] = [];
