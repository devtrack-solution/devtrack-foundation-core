import fs from 'node:fs';
import { canonicalJson, sha256 } from '../reports/schema';

export const REQUEST_SCHEMA_VERSION = 1;

export const STANDARD_CHECKS = [
  'integrity',
  'exports',
  'consumer',
  'implementer',
  'boundaries',
  'composition',
  'generation',
  'boot',
  'inventory',
  'install',
] as const;

export const STANDARD_PROFILE = {
  id: 'standard',
  version: 1,
  requiredChecks: STANDARD_CHECKS,
} as const;

export const STANDARD_PROFILE_DIGEST = sha256(canonicalJson(STANDARD_PROFILE));

export class RequestError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface ArtifactPointer {
  readonly path: string;
  readonly version: string;
  readonly digest: string;
}

export interface SelectionInput {
  readonly descriptorFile: string;
  readonly enabledFeatures: readonly string[];
  readonly companions: readonly string[];
  readonly bindings: readonly {
    readonly consumerId: string;
    readonly capabilityId: string;
    readonly providerId: string;
  }[];
}

export interface ParsedRequest {
  readonly schemaVersion: 1;
  readonly host: ArtifactPointer;
  readonly module: ArtifactPointer;
  readonly profile: {
    readonly id: string;
    readonly version: number;
    readonly kind: 'standard' | 'custom';
    readonly digest: string;
    readonly requiredChecks: readonly string[];
  };
  readonly selection: SelectionInput;
  readonly tools: { readonly node: string };
  readonly limits: { readonly timeoutMs: number; readonly maxOutputBytes: number };
  readonly baseline: { readonly host: ArtifactPointer; readonly module: ArtifactPointer } | null;
  readonly migration: {
    readonly decision: string;
    readonly validation: string;
    readonly artifactDigests: readonly string[];
  } | null;
  readonly inventory: ArtifactPointer | null;
  readonly registry: string | null;
  readonly foundationRoot: string | null;
  readonly probeSentinel: string | null;
}

const REQUEST_FIELDS = [
  'schemaVersion',
  'host',
  'module',
  'profile',
  'selection',
  'tools',
  'limits',
  'baseline',
  'migration',
  'inventory',
  'registry',
  'foundationRoot',
  'probeSentinel',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new RequestError(`${field}.${key}`, `Campo não reconhecido: ${key}`);
  }
}

function artifact(value: unknown, field: string): ArtifactPointer {
  if (!isRecord(value)) throw new RequestError(field, `${field} deve ser um objeto`);
  rejectUnknown(value, ['path', 'version', 'digest'], field);
  if (typeof value.path !== 'string' || value.path.trim() === '') {
    throw new RequestError(`${field}.path`, 'Caminho do artefato ausente');
  }
  if (typeof value.version !== 'string' || value.version.trim() === '') {
    throw new RequestError(`${field}.version`, 'Versão do artefato ausente');
  }
  if (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
    throw new RequestError(`${field}.digest`, 'Digest deve ser sha256:<64 hex>');
  }
  return { path: value.path, version: value.version, digest: value.digest };
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new RequestError(field, `${field} deve ser uma lista de strings`);
  }
  return [...value];
}

export function loadProfileDocument(file: string): { readonly id: string; readonly version: number; readonly requiredChecks: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new RequestError('profile.file', 'Perfil ilegível');
  }
  if (!isRecord(parsed)) throw new RequestError('profile.file', 'Perfil inválido');
  rejectUnknown(parsed, ['id', 'version', 'requiredChecks'], 'profile.file');
  if (parsed.id !== 'standard' || parsed.version !== 1) {
    throw new RequestError('profile.file', 'Arquivo de perfil não é o padrão v1');
  }
  const checks = stringList(parsed.requiredChecks, 'profile.file.requiredChecks');
  const document = { id: 'standard', version: 1, requiredChecks: checks };
  if (canonicalJson(document) !== canonicalJson(STANDARD_PROFILE)) {
    throw new RequestError('profile.file', 'Perfil padrão adulterado');
  }
  if (sha256(canonicalJson(document)) !== STANDARD_PROFILE_DIGEST) {
    throw new RequestError('profile.file', 'Digest do perfil padrão não confere');
  }
  return document;
}

export function parseRequest(raw: unknown, profileFile?: string): ParsedRequest {
  if (!isRecord(raw)) throw new RequestError('request', 'Requisição deve ser um objeto');
  rejectUnknown(raw, REQUEST_FIELDS, 'request');
  if (raw.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    throw new RequestError('schemaVersion', `schemaVersion deve ser ${REQUEST_SCHEMA_VERSION}`);
  }
  if (!isRecord(raw.profile)) throw new RequestError('profile', 'profile ausente');
  const profileKeys = Object.keys(raw.profile);
  for (const key of profileKeys) {
    if (!['id', 'version', 'checks', 'kind'].includes(key)) {
      throw new RequestError(`profile.${key}`, `Campo de perfil não reconhecido: ${key}`);
    }
  }
  if (typeof raw.profile.id !== 'string' || !Number.isInteger(raw.profile.version)) {
    throw new RequestError('profile', 'profile.id e profile.version são obrigatórios');
  }

  let profile: ParsedRequest['profile'];
  if (raw.profile.id === 'standard') {
    if (raw.profile.version !== 1) throw new RequestError('profile.version', 'Perfil padrão só existe na versão 1');
    if (raw.profile.kind === 'custom' || raw.profile.checks !== undefined) {
      throw new RequestError('profile', 'Perfil padrão não aceita checks próprios');
    }
    if (profileFile !== undefined) loadProfileDocument(profileFile);
    profile = {
      id: 'standard',
      version: 1,
      kind: 'standard',
      digest: STANDARD_PROFILE_DIGEST,
      requiredChecks: STANDARD_CHECKS,
    };
  } else {
    if (raw.profile.kind !== 'custom') {
      throw new RequestError('profile.kind', 'Perfil que não é o padrão deve declarar kind=custom');
    }
    const checks = stringList(raw.profile.checks, 'profile.checks');
    if (checks.length === 0) throw new RequestError('profile.checks', 'Perfil customizado sem checks');
    const omitted = STANDARD_CHECKS.filter((id) => !checks.includes(id));
    if (omitted.length === 0 && raw.profile.id === 'standard') {
      throw new RequestError('profile', 'Perfil padrão adulterado');
    }
    profile = {
      id: raw.profile.id,
      version: raw.profile.version as number,
      kind: 'custom',
      digest: sha256(canonicalJson({ id: raw.profile.id, version: raw.profile.version, checks })),
      requiredChecks: checks,
    };
  }

  if (!isRecord(raw.selection)) throw new RequestError('selection', 'selection ausente');
  rejectUnknown(raw.selection, ['descriptorFile', 'enabledFeatures', 'companions', 'bindings'], 'selection');
  if (typeof raw.selection.descriptorFile !== 'string' || raw.selection.descriptorFile.trim() === '') {
    throw new RequestError('selection.descriptorFile', 'descriptorFile ausente');
  }
  const bindingsRaw = raw.selection.bindings ?? [];
  if (!Array.isArray(bindingsRaw)) throw new RequestError('selection.bindings', 'bindings deve ser uma lista');
  const bindings = bindingsRaw.map((item, index) => {
    if (!isRecord(item)) throw new RequestError(`selection.bindings[${index}]`, 'binding inválido');
    rejectUnknown(item, ['consumerId', 'capabilityId', 'providerId'], `selection.bindings[${index}]`);
    for (const key of ['consumerId', 'capabilityId', 'providerId'] as const) {
      if (typeof item[key] !== 'string' || item[key].trim() === '') {
        throw new RequestError(`selection.bindings[${index}].${key}`, 'binding incompleto');
      }
    }
    return {
      consumerId: item.consumerId as string,
      capabilityId: item.capabilityId as string,
      providerId: item.providerId as string,
    };
  });

  if (!isRecord(raw.tools) || typeof raw.tools.node !== 'string') {
    throw new RequestError('tools.node', 'tools.node ausente');
  }
  rejectUnknown(raw.tools, ['node'], 'tools');
  if (!isRecord(raw.limits)) throw new RequestError('limits', 'limits ausente');
  rejectUnknown(raw.limits, ['timeoutMs', 'maxOutputBytes'], 'limits');
  if (!Number.isSafeInteger(raw.limits.timeoutMs) || (raw.limits.timeoutMs as number) < 1) {
    throw new RequestError('limits.timeoutMs', 'timeoutMs inválido');
  }
  if (!Number.isSafeInteger(raw.limits.maxOutputBytes) || (raw.limits.maxOutputBytes as number) < 1) {
    throw new RequestError('limits.maxOutputBytes', 'maxOutputBytes inválido');
  }

  return {
    schemaVersion: 1,
    host: artifact(raw.host, 'host'),
    module: artifact(raw.module, 'module'),
    profile,
    selection: {
      descriptorFile: raw.selection.descriptorFile,
      enabledFeatures: stringList(raw.selection.enabledFeatures, 'selection.enabledFeatures'),
      companions: stringList(raw.selection.companions, 'selection.companions'),
      bindings,
    },
    tools: { node: raw.tools.node },
    limits: {
      timeoutMs: raw.limits.timeoutMs as number,
      maxOutputBytes: raw.limits.maxOutputBytes as number,
    },
    baseline: raw.baseline === undefined ? null : parseBaseline(raw.baseline),
    migration: raw.migration === undefined ? null : parseMigration(raw.migration),
    inventory: raw.inventory === undefined ? null : artifact(raw.inventory, 'inventory'),
    registry: optionalString(raw.registry, 'registry'),
    foundationRoot: optionalString(raw.foundationRoot, 'foundationRoot'),
    probeSentinel: optionalString(raw.probeSentinel, 'probeSentinel'),
  };
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new RequestError(field, `${field} inválido`);
  return value;
}

function parseBaseline(value: unknown): ParsedRequest['baseline'] {
  if (!isRecord(value)) throw new RequestError('baseline', 'baseline inválida');
  rejectUnknown(value, ['host', 'module'], 'baseline');
  return { host: artifact(value.host, 'baseline.host'), module: artifact(value.module, 'baseline.module') };
}

function parseMigration(value: unknown): NonNullable<ParsedRequest['migration']> {
  if (!isRecord(value)) throw new RequestError('migration', 'migration inválida');
  rejectUnknown(value, ['decision', 'validation', 'artifactDigests'], 'migration');
  if (typeof value.decision !== 'string' || typeof value.validation !== 'string') {
    throw new RequestError('migration', 'migration precisa de decision e validation');
  }
  const artifactDigests = stringList(value.artifactDigests, 'migration.artifactDigests');
  if (artifactDigests.length === 0) throw new RequestError('migration.artifactDigests', 'Digests da exceção ausentes');
  return { decision: value.decision, validation: value.validation, artifactDigests };
}

export function readRequestFile(file: string, profileFile?: string): ParsedRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new RequestError('request', 'Requisição ilegível');
  }
  return parseRequest(raw, profileFile);
}
