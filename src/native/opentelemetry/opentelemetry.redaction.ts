/**
 * Filtragem de dados antes da exportação. Segunda barreira, depois da allowlist
 * de `core/application/observability`: remove chaves proibidas e mascara valores
 * com aparência de segredo ou dado pessoal. Sem dependência de SDK.
 */

export type RedactableValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]
  | undefined;

export interface RedactableAttributes {
  [key: string]: RedactableValue;
}

/** Chaves cujo conteúdo nunca sai do processo: cabeçalhos, credenciais, corpos e identificadores pessoais. */
const FORBIDDEN_KEY =
  /authorization|cookie|set-cookie|x-api-key|api[-_.]?key|token|secret|password|passwd|session|credential|e-?mail|cpf|cnpj|card|\.header\.|body|payload|query/i;

/** Chaves que carregam URL ou alvo HTTP: a query string é removida do valor. */
const URL_KEY = /url|target|referer|referrer|location|path/i;

/** Qualquer valor com pares `?chave=valor` tem a query removida, independente da chave. */
const QUERY_PAIRS = /\?[^\s?]*=/;

const REDACTED = '[redacted]';

const LUHN_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

const SECRET_PATTERNS: readonly RegExp[] = [
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
  /\b\d{11}\b/g,
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Mascara padrões de segredo e dado pessoal em um texto livre. */
export function redactText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result.replace(LUHN_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
      ? REDACTED
      : match;
  });
}

function stripQuery(text: string): string {
  const index = text.indexOf('?');
  return index === -1 ? text : text.slice(0, index);
}

function redactString(key: string, value: string): string {
  const withoutQuery =
    URL_KEY.test(key) || QUERY_PAIRS.test(value) ? stripQuery(value) : value;
  return redactText(withoutQuery);
}

function redactValue(key: string, value: RedactableValue): RedactableValue {
  if (typeof value === 'string') return redactString(key, value);
  if (Array.isArray(value)) {
    return value.map((item: unknown) =>
      typeof item === 'string' ? redactString(key, item) : item,
    ) as RedactableValue;
  }
  return value;
}

/** Remove chaves proibidas e mascara valores de um conjunto de atributos, in place. */
export function redactAttributes(attributes: RedactableAttributes): void {
  for (const key of Object.keys(attributes)) {
    if (FORBIDDEN_KEY.test(key) || redactText(key) !== key) {
      delete attributes[key];
      continue;
    }
    attributes[key] = redactValue(key, attributes[key]);
  }
}

/** Forma mínima de um span finalizado que o redator precisa alterar. */
export interface RedactableSpan {
  name: string;
  attributes: RedactableAttributes;
  events?: readonly { name: string; attributes?: RedactableAttributes }[];
  links?: readonly { attributes?: RedactableAttributes }[];
}

/** Aplica a filtragem ao nome, atributos, eventos e links de um span. */
export function redactSpan(span: RedactableSpan): void {
  span.name = redactText(span.name);
  redactAttributes(span.attributes);
  for (const event of span.events ?? []) {
    event.name = redactText(event.name);
    if (event.attributes !== undefined) redactAttributes(event.attributes);
  }
  for (const link of span.links ?? []) {
    if (link.attributes !== undefined) redactAttributes(link.attributes);
  }
}
