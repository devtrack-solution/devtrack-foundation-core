import type { AuditEntry } from './audit-writer.port';

/** Limites de auditoria. Valores fora destes intervalos são rejeitados, nunca truncados. */
export const AUDIT_LIMITS = Object.freeze({
  idMaxLength: 64,
  referenceMaxLength: 128,
  actionMaxLength: 64,
  targetMaxLength: 128,
  pageSizeDefault: 50,
  pageSizeMax: 100,
  offsetMax: 10_000,
  retentionDaysDefault: 365,
  retentionDaysMin: 1,
  retentionDaysMax: 3650,
  purgeBatchMax: 1_000,
});

export type AuditOutcome = 'succeeded' | 'denied' | 'failed';
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = Object.freeze([
  'succeeded',
  'denied',
  'failed',
]);

export type AuditValidationCode =
  | 'audit_invalid_entry'
  | 'audit_invalid_action'
  | 'audit_invalid_target'
  | 'audit_invalid_context'
  | 'audit_invalid_query'
  | 'audit_invalid_policy';

/**
 * Erro de validação de auditoria. A mensagem descreve a regra violada e nunca
 * ecoa o valor recebido, para não copiar segredo ou dado pessoal para logs.
 */
export class AuditValidationError extends Error {
  readonly code: AuditValidationCode;

  constructor(code: AuditValidationCode, message: string) {
    super(message);
    this.name = 'AuditValidationError';
    this.code = code;
  }
}

/** Registro durável após a projeção de campos permitidos. Nunca contém objetos recebidos. */
export interface AuditRecord {
  readonly id: string;
  readonly occurredAt: number;
  readonly subjectId: string;
  readonly tenantId?: string;
  readonly correlationId: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: AuditOutcome;
}

const ACTION_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
/** Sequência longa sem separador: forma típica de token, hash de segredo ou JWT. */
const OPAQUE_RUN_PATTERN = /[A-Za-z0-9_-]{32,}/;
/** JWT: três segmentos base64url, o primeiro começando por `eyJ` (cabeçalho JSON). */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{6,}\./;
/** Segmento separado por `.`, `_`, `:`, `/` ou `-` com este tamanho é tratado como token. */
const OPAQUE_SEGMENT_LENGTH = 24;
/** Segmentos de nome que indicam segredo ou dado pessoal (ex.: `auth.token`, `user.cpf`). */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'senha',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  'bearer',
  'authorization',
  'apikey',
  'cookie',
  'email',
  'mail',
  'cpf',
  'cnpj',
  'cvv',
  'permission',
  'permissions',
]);
const SEGMENT_SPLIT = /[._:/-]/;
const DIGIT_RUN_LIMIT = 11;

function invalid(code: AuditValidationCode, message: string): never {
  throw new AuditValidationError(code, message);
}

/** Valida `action` (verbo.recurso em minúsculas). Lança `audit_invalid_action`. */
export function validateAuditAction(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_PATTERN.test(value)) {
    invalid(
      'audit_invalid_action',
      `action must match ${ACTION_PATTERN.source} (max ${AUDIT_LIMITS.actionMaxLength})`,
    );
  }
  return value;
}

/**
 * Valida `target`: identificador curto sem espaços nem e-mail. Rejeita padrões de
 * segredo (sequências opacas longas), nomes de segmento sensíveis e sequências
 * longas de dígitos (CPF, cartão). Lança `audit_invalid_target`.
 */
export function validateAuditTarget(value: unknown): string {
  if (typeof value !== 'string' || !TARGET_PATTERN.test(value)) {
    invalid(
      'audit_invalid_target',
      `target must match ${TARGET_PATTERN.source} (max ${AUDIT_LIMITS.targetMaxLength})`,
    );
  }
  if (OPAQUE_RUN_PATTERN.test(value) || JWT_PATTERN.test(value)) {
    invalid(
      'audit_invalid_target',
      'target must not contain token-like opaque sequences',
    );
  }
  const segments = value.toLowerCase().split(SEGMENT_SPLIT);
  if (segments.some((segment) => segment.length >= OPAQUE_SEGMENT_LENGTH)) {
    invalid(
      'audit_invalid_target',
      'target must not contain token-like opaque sequences',
    );
  }
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    invalid('audit_invalid_target', 'target must not name sensitive data');
  }
  if (value.replace(/\D/g, '').length >= DIGIT_RUN_LIMIT) {
    invalid(
      'audit_invalid_target',
      'target must not contain personal or card-like number sequences',
    );
  }
  return value;
}

function requireReference(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !ID_PATTERN.test(value)
  ) {
    invalid(
      'audit_invalid_context',
      `${field} must be a non-empty identifier of up to ${maxLength} characters`,
    );
  }
  return value;
}

function requireEntryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > AUDIT_LIMITS.idMaxLength ||
    !ID_PATTERN.test(value)
  ) {
    invalid(
      'audit_invalid_entry',
      `id must be a non-empty identifier of up to ${AUDIT_LIMITS.idMaxLength} characters`,
    );
  }
  return value;
}

function requireMillis(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(
      'audit_invalid_entry',
      `${field} must be a non-negative safe integer in epoch milliseconds`,
    );
  }
  return value;
}

/**
 * Projeção permitida de `AuditEntry`. Copia apenas id, instante, outcome, action,
 * target e os três campos de `AuditContext`. Propriedades extras (permissões,
 * deadline, tokens, e-mails) são ignoradas em runtime, não apenas pelo tipo.
 */
export function toAuditRecord(entry: AuditEntry): AuditRecord {
  if (entry === null || typeof entry !== 'object') {
    invalid('audit_invalid_entry', 'audit entry must be an object');
  }
  const context: unknown = entry.context;
  if (context === null || typeof context !== 'object') {
    invalid('audit_invalid_context', 'audit entry requires a context object');
  }
  const scope = context as Partial<
    Record<keyof AuditEntry['context'], unknown>
  >;
  const outcome: unknown = entry.outcome;
  if (
    typeof outcome !== 'string' ||
    !(AUDIT_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    invalid(
      'audit_invalid_entry',
      'outcome must be succeeded, denied or failed',
    );
  }

  const record: AuditRecord = {
    id: requireEntryId(entry.id),
    occurredAt: requireMillis(entry.occurredAt, 'occurredAt'),
    subjectId: requireReference(
      scope.subjectId,
      'subjectId',
      AUDIT_LIMITS.referenceMaxLength,
    ),
    ...(scope.tenantId === undefined
      ? {}
      : {
          tenantId: requireReference(
            scope.tenantId,
            'tenantId',
            AUDIT_LIMITS.referenceMaxLength,
          ),
        }),
    correlationId: requireReference(
      scope.correlationId,
      'correlationId',
      AUDIT_LIMITS.referenceMaxLength,
    ),
    action: validateAuditAction(entry.action),
    target: validateAuditTarget(entry.target),
    outcome: outcome as AuditOutcome,
  };
  return Object.freeze(record);
}

/** Consulta de leitura. `tenantId` vem do principal autenticado, nunca do chamador bruto. */
export interface AuditTrailQuery {
  readonly tenantId: string;
  /** Instante inicial, inclusivo, em epoch ms. */
  readonly fromMs: number;
  /** Instante final, exclusivo, em epoch ms. */
  readonly toMs: number;
  readonly action?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Valida a consulta de leitura. Lança `audit_invalid_query` com faixas explícitas. */
export function validateAuditTrailQuery(
  input: AuditTrailQuery,
): AuditTrailQuery {
  const tenantId = requireReference(
    input.tenantId,
    'tenantId',
    AUDIT_LIMITS.referenceMaxLength,
  );
  if (
    !Number.isSafeInteger(input.fromMs) ||
    !Number.isSafeInteger(input.toMs) ||
    input.fromMs < 0 ||
    input.toMs <= input.fromMs
  ) {
    invalid(
      'audit_invalid_query',
      'time range requires fromMs < toMs as non-negative safe integers',
    );
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > AUDIT_LIMITS.pageSizeMax
  ) {
    invalid(
      'audit_invalid_query',
      `limit must be an integer between 1 and ${AUDIT_LIMITS.pageSizeMax}`,
    );
  }
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > AUDIT_LIMITS.offsetMax
  ) {
    invalid(
      'audit_invalid_query',
      `offset must be an integer between 0 and ${AUDIT_LIMITS.offsetMax}`,
    );
  }
  const action =
    input.action === undefined ? undefined : validateAuditAction(input.action);
  return Object.freeze({
    tenantId,
    fromMs: input.fromMs,
    toMs: input.toMs,
    limit: input.limit,
    offset: input.offset,
    ...(action === undefined ? {} : { action }),
  });
}

/** Política de retenção própria da auditoria, independente de logs e traces. */
export interface AuditRetentionPolicy {
  readonly retentionDays: number;
  readonly retentionMs: number;
}

/** Cria a política validada. Ausente usa o padrão; fora da faixa lança `audit_invalid_policy`. */
export function createAuditRetentionPolicy(
  input: { readonly retentionDays?: number } = {},
): AuditRetentionPolicy {
  const retentionDays =
    input.retentionDays ?? AUDIT_LIMITS.retentionDaysDefault;
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < AUDIT_LIMITS.retentionDaysMin ||
    retentionDays > AUDIT_LIMITS.retentionDaysMax
  ) {
    invalid(
      'audit_invalid_policy',
      `retentionDays must be an integer between ${AUDIT_LIMITS.retentionDaysMin} and ${AUDIT_LIMITS.retentionDaysMax}`,
    );
  }
  return Object.freeze({
    retentionDays,
    retentionMs: retentionDays * 86_400_000,
  });
}

/** Limite de lote de `purgeExpired`. Fora da faixa lança `audit_invalid_policy`. */
export function validatePurgeBatchSize(batchSize: number): number {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > AUDIT_LIMITS.purgeBatchMax
  ) {
    invalid(
      'audit_invalid_policy',
      `batchSize must be an integer between 1 and ${AUDIT_LIMITS.purgeBatchMax}`,
    );
  }
  return batchSize;
}
