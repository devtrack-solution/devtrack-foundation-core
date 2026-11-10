/** Verificação de dependência obrigatória. Implementações devem ser rápidas e sem efeito colateral. */
export interface ReadinessCheck {
  check(): Promise<boolean>;
}

/**
 * Pronto somente sem drenagem e com todas as dependências obrigatórias
 * respondendo dentro do prazo. Falha, exceção ou timeout contam como não pronto.
 */
export async function evaluateReadiness(input: {
  readonly draining: boolean;
  readonly checks: readonly ReadinessCheck[];
  readonly timeoutMs: number;
}): Promise<boolean> {
  if (input.draining) return false;
  const results = await Promise.all(
    input.checks.map((check) => runWithTimeout(check, input.timeoutMs)),
  );
  return results.every((ok) => ok);
}

async function runWithTimeout(
  check: ReadinessCheck,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      check.check().then(
        (ok) => ok === true,
        () => false,
      ),
      expired,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
