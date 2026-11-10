import { BadRequestException, type PipeTransform } from '@nestjs/common';

export interface RequestBodyLimits {
  /** Profundidade máxima de objetos/arrays aninhados; o corpo raiz conta como 1. */
  readonly maxDepth: number;
  /** Tamanho máximo do corpo serializado em JSON, em bytes UTF-8. */
  readonly maxBytes: number;
}

function exceedsDepth(root: unknown, maxDepth: number): boolean {
  const stack: { value: unknown; depth: number }[] = [
    { value: root, depth: 1 },
  ];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) return false;
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (item.depth > maxDepth) return true;
    const children = Array.isArray(item.value)
      ? item.value
      : Object.values(item.value);
    for (const child of children)
      stack.push({ value: child, depth: item.depth + 1 });
  }
}

/** Rejeita corpos acima dos limites com 400. Sem dependências externas. */
export class RequestBodyLimitPipe implements PipeTransform<unknown, unknown> {
  constructor(private readonly limits: RequestBodyLimits) {
    if (
      !Number.isSafeInteger(limits.maxDepth) ||
      limits.maxDepth <= 0 ||
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes <= 0
    )
      throw new Error('Invalid request body limits');
  }

  transform(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new BadRequestException('request_body_invalid');
    }
    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, 'utf8') > this.limits.maxBytes
    )
      throw new BadRequestException('request_body_too_large');
    if (exceedsDepth(value, this.limits.maxDepth))
      throw new BadRequestException('request_body_too_deep');
    return value;
  }
}
