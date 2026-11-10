import type {
  RefreshRotationDecision,
  RefreshRotationSnapshot,
} from './authentication.ports';

export interface RefreshRotationContext {
  readonly now: number;
  /** Digest of the client binding presented by this request. */
  readonly bindingDigest: string;
  readonly successorDigest: string;
  readonly graceWindowMs: number;
  readonly idleTtlMs: number;
}

/**
 * Política D2 de rotação de refresh. Pura: a decisão é aplicada pelo store sob
 * o lock atômico. Qualquer caso não listado como conflito ou rotação é rejeitado.
 *
 * - Sessão inativa ou absolutamente expirada: rejeita (sem efeito).
 * - Ativo: rotaciona se não expirou por ociosidade e o binding confere.
 * - Consumido dentro da janela de graça, mesmo binding e sucessor ainda ativo:
 *   conflito (sem novo sucessor, sessão preservada).
 * - Consumido fora da janela, outro binding ou sucessor já usado: reuso (revoga
 *   a família inteira).
 */
export function decideRotation(
  snapshot: RefreshRotationSnapshot | null,
  context: RefreshRotationContext,
): RefreshRotationDecision {
  if (snapshot === null) return { kind: 'reject' };
  if (
    snapshot.sessionState !== 'active' ||
    context.now >= snapshot.sessionExpiresAt
  )
    return { kind: 'reject' };

  if (snapshot.refreshState === 'active') {
    if (
      context.now >= snapshot.idleExpiresAt ||
      snapshot.clientBindingDigest !== context.bindingDigest
    )
      return { kind: 'reject' };
    return {
      kind: 'rotate',
      successorDigest: context.successorDigest,
      successorIdleExpiresAt: Math.min(
        context.now + context.idleTtlMs,
        snapshot.sessionExpiresAt,
      ),
    };
  }

  if (snapshot.refreshState === 'consumed') {
    if (snapshot.consumedAt === null) return { kind: 'reject' };
    const withinGrace =
      context.now < snapshot.consumedAt + context.graceWindowMs;
    const sameBinding = snapshot.clientBindingDigest === context.bindingDigest;
    const successorUnused = snapshot.successorState === 'active';
    if (withinGrace && sameBinding && successorUnused)
      return { kind: 'conflict' };
    return { kind: 'reuse' };
  }

  return { kind: 'reject' };
}
