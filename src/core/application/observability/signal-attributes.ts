import type {
  SignalAttributeValue,
  SignalAttributes,
} from './signal-contracts';
import { findSignalMetric } from './signal-catalog';

/**
 * Chaves aceitas em sinais (união do catálogo, mais atributos automáticos de
 * HTTP). Ampliar a lista exige revisão de cardinalidade e de dados pessoais.
 * IDs ilimitados, tokens, emails e payloads ficam de fora.
 */
export const SIGNAL_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  'activity.name',
  'activity.outcome',
  'http.route',
  'http.request.method',
  'operation.kind',
  'reason',
  'signal',
];

const MAX_VALUE_LENGTH = 64;
const SAFE_VALUE = /^[A-Za-z0-9._:/{}*-]+$/;
const SECRET_HINTS = /bearer|token|secret|password|@/i;

function isSafeValue(value: SignalAttributeValue): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    value.length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    SAFE_VALUE.test(value) &&
    !SECRET_HINTS.test(value)
  );
}

function keepAllowed(
  attributes: SignalAttributes | undefined,
  keys: readonly string[],
): SignalAttributes {
  if (attributes === undefined) return {};
  const result: Record<string, SignalAttributeValue> = {};
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && isSafeValue(value)) result[key] = value;
  }
  return result;
}

/** Mantém somente chaves permitidas com valores curtos e sem aparência de segredo ou email. */
export function sanitizeSignalAttributes(
  attributes: SignalAttributes | undefined,
): SignalAttributes {
  return keepAllowed(attributes, SIGNAL_ATTRIBUTE_ALLOWLIST);
}

/**
 * Filtra pelo catálogo: só chaves declaradas para a métrica `metricName` e
 * ainda na allowlist global. Métrica fora do catálogo não recebe atributo algum.
 */
export function sanitizeMetricAttributes(
  metricName: string,
  attributes: SignalAttributes | undefined,
): SignalAttributes {
  const definition = findSignalMetric(metricName);
  if (definition === undefined) return {};
  const allowed = definition.attributes.filter((key) =>
    SIGNAL_ATTRIBUTE_ALLOWLIST.includes(key),
  );
  return keepAllowed(attributes, allowed);
}
