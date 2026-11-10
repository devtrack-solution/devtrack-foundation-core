import crypto from 'node:crypto';

export const REPORT_SCHEMA_VERSION = 1;
export const KIT_VERSION = '0.1.0';

export type CheckStatus = 'passed' | 'failed' | 'not-run' | 'not-applicable';
export type GlobalResult = 'passed' | 'failed' | 'incomplete';

export interface CheckRecord {
  readonly id: string;
  readonly status: CheckStatus;
  readonly reason?: string;
  readonly evidence?: readonly string[];
}

export interface ConformanceReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly kitVersion: string;
  readonly kitDigest: string;
  readonly foundationApiMajor: number;
  readonly host: { readonly version: string; readonly digest: string };
  readonly module: { readonly version: string; readonly digest: string };
  readonly profile: {
    readonly id: string;
    readonly version: number;
    readonly digest: string;
    readonly kind: 'standard' | 'custom';
  };
  readonly selection: {
    readonly modules: readonly { readonly id: string; readonly enabledFeatures: readonly string[] }[];
    readonly bindings: readonly {
      readonly consumerId: string;
      readonly capabilityId: string;
      readonly providerId: string;
    }[];
  };
  readonly runtime: { readonly node: string; readonly platform: string; readonly arch: string };
  readonly prerequisites: readonly {
    readonly id: string;
    readonly present: boolean;
    readonly digest: string | null;
  }[];
  readonly checks: readonly CheckRecord[];
  readonly limitations: readonly string[];
  readonly exception: {
    readonly decision: string;
    readonly validation: string;
    readonly artifactDigests: readonly string[];
    readonly accepted: boolean;
    readonly breaks: readonly string[];
  } | null;
  readonly identity: string;
  readonly result: GlobalResult;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly claims: {
    readonly standardProfile: boolean;
    readonly crossVersionCompatibility: boolean;
    readonly productionCapacity: false;
    readonly securityAudit: false;
  };
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function exitCode(result: GlobalResult): 0 | 1 | 2 {
  if (result === 'failed') return 1;
  if (result === 'incomplete') return 2;
  return 0;
}

/** failed wins, then incomplete, then passed. not-applicable does not block. */
export function combineResult(
  checks: readonly CheckRecord[],
  required: readonly string[],
): GlobalResult {
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  const byId = new Map(checks.map((check) => [check.id, check]));
  for (const id of required) {
    const check = byId.get(id);
    if (check === undefined || check.status === 'not-run') return 'incomplete';
  }
  return 'passed';
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/\/Users\/[^\s'"]+/g, '<home>')
    .replace(/\/home\/[^\s'"]+/g, '<home>');
}

export interface IdentityInput {
  readonly schemaVersion: number;
  readonly kitVersion: string;
  readonly kitDigest: string;
  readonly foundationApiMajor: number;
  readonly host: { readonly version: string; readonly digest: string };
  readonly module: { readonly version: string; readonly digest: string };
  readonly profile: ConformanceReport['profile'];
  readonly selection: ConformanceReport['selection'];
  readonly tools: { readonly node: string };
  readonly limits: { readonly timeoutMs: number; readonly maxOutputBytes: number };
  readonly baseline: { readonly hostDigest: string; readonly moduleDigest: string } | null;
  readonly migration: { readonly decision: string; readonly validation: string; readonly artifactDigests: readonly string[] } | null;
}

export function executionIdentity(input: IdentityInput): string {
  return sha256(canonicalJson(input));
}

export function renderSummary(report: ConformanceReport): string {
  const lines = [
    `result: ${report.result}`,
    `exit: ${exitCode(report.result)}`,
    `identity: ${report.identity}`,
    `profile: ${report.profile.id}@${report.profile.version} (${report.profile.kind})`,
    `standardApproval: ${report.claims.standardProfile ? 'yes' : 'no'}`,
    `crossVersionCompatibility: ${report.claims.crossVersionCompatibility ? 'yes' : 'no'}`,
    'checks:',
    ...report.checks.map(
      (check) => `  - ${check.id}: ${check.status}${check.reason ? ` (${check.reason})` : ''}`,
    ),
    'limitations:',
    ...report.limitations.map((item) => `  - ${item}`),
  ];
  return `${lines.join('\n')}\n`;
}
