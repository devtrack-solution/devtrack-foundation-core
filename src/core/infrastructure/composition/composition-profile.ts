import { parseDocument } from 'yaml';
import type {
  CompositionInput,
  ModuleDescriptor,
  ModuleSelection,
  ResolvedComposition,
} from '../../application/modules/module-descriptor';
import { isModuleIdentifier } from '../../application/modules/module-identifier';
import { findNativeDescriptor } from '../../application/modules/native-catalog';
import { resolveComposition } from '../../application/modules/resolve-composition';

export type CompositionProfileErrorCode =
  | 'PROFILE_MALFORMED'
  | 'PROFILE_UNKNOWN_FIELD'
  | 'PROFILE_MISSING_FIELD'
  | 'PROFILE_INVALID_VALUE'
  | 'PROFILE_DUPLICATE_ENTRY'
  | 'PROFILE_SECRET_FIELD'
  | 'PROFILE_UNKNOWN_NATIVE'
  | 'PROFILE_UNKNOWN_EXTENSION'
  | 'PROFILE_EXTENSION_MISMATCH';

/**
 * Erro de leitura do perfil. A mensagem cita apenas caminhos de campo, nunca
 * valores do arquivo: um perfil inválido pode conter dados sensíveis por engano.
 */
export class CompositionProfileError extends Error {
  constructor(
    readonly code: CompositionProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionProfileError';
  }
}

export interface NativeProfileEntry {
  readonly id: string;
  readonly features: readonly string[];
}

export interface ExtensionProfileEntry {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly features: readonly string[];
}

export interface BindingProfileEntry {
  readonly consumer: string;
  readonly capability: string;
  readonly provider: string;
}

/** Perfil validado e normalizado: listas ordenadas por identificador. */
export interface CompositionProfile {
  readonly foundationApiMajor: 1;
  readonly natives: readonly NativeProfileEntry[];
  readonly extensions: readonly ExtensionProfileEntry[];
  readonly bindings: readonly BindingProfileEntry[];
}

/**
 * Extensão npm conhecida pelo gerador. O descriptor vem do registro explícito
 * do host, nunca do perfil; `exportName` é o módulo Nest exportado pelo pacote.
 */
export interface ExtensionSource {
  readonly descriptor: ModuleDescriptor;
  readonly exportName: string;
  /** Como montar o módulo; ausente = import simples do `exportName`. */
  readonly composition?: ExtensionComposition;
}

/**
 * Metadata de montagem declarada no descriptor do pacote (D7). Nunca é código
 * executável: o gerador só lê nomes e emite imports estáticos.
 */
export interface ExtensionComposition {
  /** Configuração entregue pelo host por token; gera `registerAsync`. */
  readonly hostOptions?: {
    /** Nome do token de host (`Symbol.for('foundation.api.v1.host.<token>')`). */
    readonly token: string;
    /** Tipo exportado pelo pacote para as opções. */
    readonly type: string;
  };
  /** Export do pacote que entrega cada capacidade fornecida, por id de capacidade. */
  readonly capabilityTokens?: Readonly<Record<string, string>>;
}

const TOP_LEVEL_FIELDS = [
  'foundationApiMajor',
  'natives',
  'extensions',
  'bindings',
] as const;
const NATIVE_FIELDS = ['id', 'features'] as const;
const EXTENSION_FIELDS = [
  'id',
  'packageName',
  'version',
  'integrity',
  'features',
] as const;
const BINDING_FIELDS = ['consumer', 'capability', 'provider'] as const;

/** Nomes de chave normalizados (minúsculas, sem separadores) que indicam segredo. */
const SECRET_KEY =
  /secret|password|passwd|privatekey|token|keymaterial|apikey|credential/;

/** Valores com aparência de segredo. Integridade (`integrity`) é excluída da varredura. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /^[A-Fa-f0-9]{40,}$/,
];

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Versão exata. Intervalos SemVer não são aceitos no perfil. */
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SUBRESOURCE_INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

type ProfileRecord = Readonly<Record<string, unknown>>;

function fail(code: CompositionProfileErrorCode, message: string): never {
  throw new CompositionProfileError(code, message);
}

function isRecord(value: unknown): value is ProfileRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, path: string): ProfileRecord {
  if (!isRecord(value))
    fail('PROFILE_INVALID_VALUE', `${path} must be a mapping`);
  return value;
}

function assertFields(
  value: ProfileRecord,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      fail('PROFILE_UNKNOWN_FIELD', `Unknown field at ${path}.${key}`);
  }
}

function required(value: ProfileRecord, key: string, path: string): unknown {
  if (value[key] === undefined)
    fail('PROFILE_MISSING_FIELD', `Missing field ${path}.${key}`);
  return value[key];
}

function identifier(value: unknown, path: string): string {
  if (!isModuleIdentifier(value))
    fail('PROFILE_INVALID_VALUE', `Invalid identifier at ${path}`);
  return value;
}

function pattern(value: unknown, path: string, expected: RegExp): string {
  if (typeof value !== 'string' || !expected.test(value))
    fail('PROFILE_INVALID_VALUE', `Invalid value at ${path}`);
  return value;
}

function listOf(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    fail('PROFILE_INVALID_VALUE', `${path} must be a list`);
  return value;
}

function readFeatures(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  const features = listOf(value, path).map((item, index) =>
    identifier(item, `${path}[${index}]`),
  );
  if (new Set(features).size !== features.length)
    fail('PROFILE_DUPLICATE_ENTRY', `Duplicate feature at ${path}`);
  return features.sort(compare);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Varredura antes da validação de forma: qualquer chave ou valor com cara de segredo é recusado. */
function scanForSecrets(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some((expected) => expected.test(value)))
      fail('PROFILE_SECRET_FIELD', `Secret-like value at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SECRET_KEY.test(normalized))
      fail('PROFILE_SECRET_FIELD', `Forbidden secret field at ${path}.${key}`);
    if (key !== 'integrity') scanForSecrets(item, `${path}.${key}`);
  }
}

function readNatives(value: unknown): NativeProfileEntry[] {
  return listOf(value, 'natives').map((item, index) => {
    const path = `natives[${index}]`;
    const entry = asRecord(item, path);
    assertFields(entry, NATIVE_FIELDS, path);
    return {
      id: identifier(required(entry, 'id', path), `${path}.id`),
      features: readFeatures(entry.features, `${path}.features`),
    };
  });
}

function readExtensions(value: unknown): ExtensionProfileEntry[] {
  return listOf(value, 'extensions').map((item, index) => {
    const path = `extensions[${index}]`;
    const entry = asRecord(item, path);
    assertFields(entry, EXTENSION_FIELDS, path);
    const id = identifier(required(entry, 'id', path), `${path}.id`);
    if (id.startsWith('native/'))
      fail(
        'PROFILE_INVALID_VALUE',
        `Extension ${path}.id uses native namespace`,
      );
    return {
      id,
      packageName: pattern(
        required(entry, 'packageName', path),
        `${path}.packageName`,
        NPM_PACKAGE_NAME,
      ),
      version: pattern(
        required(entry, 'version', path),
        `${path}.version`,
        EXACT_VERSION,
      ),
      integrity: pattern(
        required(entry, 'integrity', path),
        `${path}.integrity`,
        SUBRESOURCE_INTEGRITY,
      ),
      features: readFeatures(entry.features, `${path}.features`),
    };
  });
}

function readBindings(value: unknown): BindingProfileEntry[] {
  return listOf(value, 'bindings').map((item, index) => {
    const path = `bindings[${index}]`;
    const entry = asRecord(item, path);
    assertFields(entry, BINDING_FIELDS, path);
    return {
      consumer: identifier(
        required(entry, 'consumer', path),
        `${path}.consumer`,
      ),
      capability: identifier(
        required(entry, 'capability', path),
        `${path}.capability`,
      ),
      provider: identifier(
        required(entry, 'provider', path),
        `${path}.provider`,
      ),
    };
  });
}

/**
 * Lê e valida o texto do perfil. Entrada não confiável: YAML com aliases, tags
 * e chaves duplicadas é recusado; nada é executado nem resolvido aqui.
 */
export function readCompositionProfile(source: string): CompositionProfile {
  const document = parseDocument(source, { schema: 'core', uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    // Mensagens do parser podem citar trechos do arquivo: só a linha é exposta.
    const line =
      document.errors[0]?.linePos?.[0]?.line ??
      document.warnings[0]?.linePos?.[0]?.line;
    fail(
      'PROFILE_MALFORMED',
      `Malformed composition profile${line === undefined ? '' : ` at line ${line}`}`,
    );
  }
  let value: unknown;
  try {
    // Aliases são recusados: nenhum valor é reaproveitado por referência.
    value = document.toJS({ maxAliasCount: 0 }) ?? {};
  } catch {
    fail(
      'PROFILE_MALFORMED',
      'Malformed composition profile: aliases are not allowed',
    );
  }
  const root = asRecord(value, 'profile');
  scanForSecrets(root, 'profile');
  assertFields(root, TOP_LEVEL_FIELDS, 'profile');

  const version = required(root, 'foundationApiMajor', 'profile');
  if (version !== 1)
    fail('PROFILE_INVALID_VALUE', 'profile.foundationApiMajor must be 1');

  const natives = readNatives(required(root, 'natives', 'profile'));
  const extensions = readExtensions(required(root, 'extensions', 'profile'));
  const bindings =
    root.bindings === undefined ? [] : readBindings(root.bindings);

  const moduleIds = new Set<string>();
  for (const id of [
    ...natives.map((native) => native.id),
    ...extensions.map((extension) => extension.id),
  ]) {
    if (moduleIds.has(id))
      fail('PROFILE_DUPLICATE_ENTRY', `Duplicate module entry ${id}`);
    moduleIds.add(id);
  }
  const bindingKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.consumer}\u0000${binding.capability}`;
    if (bindingKeys.has(key))
      fail('PROFILE_DUPLICATE_ENTRY', 'Duplicate binding entry');
    bindingKeys.add(key);
  }

  return {
    foundationApiMajor: 1,
    natives: [...natives].sort((a, b) => compare(a.id, b.id)),
    extensions: [...extensions].sort((a, b) => compare(a.id, b.id)),
    bindings: [...bindings].sort(
      (a, b) =>
        compare(a.consumer, b.consumer) ||
        compare(a.capability, b.capability) ||
        compare(a.provider, b.provider),
    ),
  };
}

/** Monta a entrada do resolvedor a partir do perfil validado e do registro do host. */
export function buildCompositionInput(
  profile: CompositionProfile,
  extensions: readonly ExtensionSource[],
): CompositionInput {
  const sources = new Map<string, ExtensionSource>();
  for (const source of extensions) {
    if (sources.has(source.descriptor.id))
      fail('PROFILE_DUPLICATE_ENTRY', 'Duplicate extension source');
    sources.set(source.descriptor.id, source);
  }

  const modules: ModuleSelection[] = [];
  for (const native of profile.natives) {
    const descriptor = findNativeDescriptor(native.id);
    if (descriptor === undefined)
      fail('PROFILE_UNKNOWN_NATIVE', `Unknown native module ${native.id}`);
    modules.push({ descriptor, enabledFeatures: native.features });
  }
  for (const extension of profile.extensions) {
    const source = sources.get(extension.id);
    if (source === undefined)
      fail(
        'PROFILE_UNKNOWN_EXTENSION',
        `Unknown extension ${extension.id}: install ${extension.packageName}@${extension.version} before composing`,
      );
    const origin = source.descriptor.origin;
    if (
      origin.kind !== 'npm' ||
      origin.packageName !== extension.packageName ||
      origin.version !== extension.version ||
      origin.integrity !== extension.integrity
    )
      fail(
        'PROFILE_EXTENSION_MISMATCH',
        `Extension ${extension.id} does not match its registered origin`,
      );
    modules.push({
      descriptor: source.descriptor,
      enabledFeatures: extension.features,
    });
  }

  return {
    modules,
    bindings: profile.bindings.map((binding) => ({
      consumerId: binding.consumer,
      capabilityId: binding.capability,
      providerId: binding.provider,
    })),
  };
}

/** Lê, valida e resolve o perfil. Erros do resolvedor mantêm seus códigos estáveis. */
export function resolveCompositionProfile(
  source: string,
  extensions: readonly ExtensionSource[],
): ResolvedComposition {
  const profile = readCompositionProfile(source);
  return resolveComposition(buildCompositionInput(profile, extensions));
}
