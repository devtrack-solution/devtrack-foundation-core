import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedComposition } from '../../application/modules/module-descriptor';
import { NATIVE_SOURCES } from './native-sources';
import type {
  ExtensionComposition,
  ExtensionSource,
} from './composition-profile';
import { resolveCompositionProfile } from './composition-profile';

export type CompositionGenerationErrorCode =
  | 'GENERATED_STALE'
  | 'GENERATOR_INVALID_EXTENSION'
  | 'GENERATOR_UNSUPPORTED_MODULE';

export class CompositionGenerationError extends Error {
  constructor(
    readonly code: CompositionGenerationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionGenerationError';
  }
}

/** Nomes de token entregues pelo host. Cada um vira `Symbol.for` estável. */
const HOST_TOKEN_NAMES = {
  awsS3Options: 'aws-s3.options',
  cacheRedisOptions: 'cache-redis.options',
  clock: 'clock',
  identities: 'identities',
  jobIdentityResolver: 'job-identity-resolver',
  persistenceOptions: 'persistence.options',
  queueBullmqOptions: 'queue-bullmq.options',
  sessions: 'sessions',
} as const;

const HOST_TOKEN_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Revalida o bloco `composition` de uma extensão antes de emitir qualquer import (D7). */
function validateExtensionComposition(
  source: ExtensionSource,
): ExtensionComposition | undefined {
  const composition = source.composition;
  if (composition === undefined) return undefined;
  const id = source.descriptor.id;
  const invalid = (detail: string) =>
    new CompositionGenerationError(
      'GENERATOR_INVALID_EXTENSION',
      `Extension ${id} has an invalid composition block: ${detail}`,
    );
  const options = composition.hostOptions;
  if (options !== undefined) {
    if (!HOST_TOKEN_PATTERN.test(options.token))
      throw invalid(`host token "${options.token}"`);
    if (!TS_IDENTIFIER.test(options.type))
      throw invalid(`options type "${options.type}"`);
  }
  const provided = new Set(
    source.descriptor.provides.map(({ id: cap }) => cap),
  );
  for (const [capability, token] of Object.entries(
    composition.capabilityTokens ?? {},
  )) {
    if (!provided.has(capability))
      throw invalid(`capability "${capability}" is not provided`);
    if (!TS_IDENTIFIER.test(token))
      throw invalid(`capability token "${token}"`);
  }
  return composition;
}

const HEADER =
  '// gerado — não editar. Fonte: config/composition.yaml. Regenere com `npm run compose`.';

/**
 * Formata com o Prettier do projeto em processo filho (o Prettier 3 é ESM e não
 * carrega sob o Jest CJS). Opções fixas espelham .prettierrc: `--no-config`
 * garante a mesma saída independentemente do diretório do arquivo de destino.
 */
const PRETTIER_CLI = path.join(
  path.dirname(require.resolve('prettier/package.json')),
  'bin',
  'prettier.cjs',
);
function formatTypeScript(source: string): string {
  return execFileSync(
    process.execPath,
    [
      PRETTIER_CLI,
      '--no-config',
      '--single-quote',
      '--trailing-comma',
      'all',
      '--stdin-filepath',
      'composition.generated.ts',
    ],
    { input: source, encoding: 'utf8' },
  );
}

/** Diretório do módulo gerado versionado: `src/composition/`. */
const DEFAULT_OUTPUT = path.resolve(
  __dirname,
  '../../../composition/composition.generated.ts',
);
/** Arquivo gerado de inicialização antecipada, importado primeiro por `src/main.ts`. */
export const DEFAULT_INSTRUMENTATION_OUTPUT = path.resolve(
  __dirname,
  '../../../composition/instrumentation.generated.ts',
);

/** Especificador relativo ao arquivo de saída, sempre com `/` e prefixo `./` ou `../`. */
function specifierFrom(outputPath: string, nativeImportPath: string): string {
  const target = path.resolve(path.dirname(DEFAULT_OUTPUT), nativeImportPath);
  const relative = path
    .relative(path.dirname(outputPath), target)
    .split(path.sep)
    .join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

interface ImportEntry {
  readonly values: Set<string>;
  readonly types: Set<string>;
}

function camel(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part[0].toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join('');
}

/** Renderiza o módulo gerado a partir do texto do perfil. Não escreve nada. */
export function renderComposition(
  profileSource: string,
  extensions: readonly ExtensionSource[],
  outputPath: string = DEFAULT_OUTPUT,
): {
  readonly resolved: ResolvedComposition;
  readonly source: string;
} {
  const resolved = resolveCompositionProfile(profileSource, extensions);

  const imports = new Map<string, ImportEntry>();
  const addImport = (specifier: string, name: string, type = false) => {
    const entry = imports.get(specifier) ?? {
      values: new Set<string>(),
      types: new Set<string>(),
    };
    (type ? entry.types : entry.values).add(name);
    imports.set(specifier, entry);
  };
  // Chave em COMPOSITION_HOST_TOKENS → nome do token e módulo dono.
  const hostTokens = new Map<string, { token: string; owner: string }>();
  const useHostToken = (key: string, token: string, owner: string) => {
    const current = hostTokens.get(key);
    if (
      current !== undefined &&
      (current.token !== token || current.owner !== owner)
    )
      throw new CompositionGenerationError(
        'GENERATOR_INVALID_EXTENSION',
        `Host token ${key} is declared by both ${current.owner} (${current.token}) and ${owner} (${token})`,
      );
    hostTokens.set(key, { token, owner });
    return key;
  };
  const declarations: string[] = [];
  const variables = new Map<string, string>();
  addImport('@nestjs/common', 'Module');

  for (const { id } of resolved.modules) {
    const extension = extensions.find((source) => source.descriptor.id === id);
    if (extension !== undefined) {
      const origin = extension.descriptor.origin;
      if (origin.kind !== 'npm')
        throw new CompositionGenerationError(
          'GENERATOR_UNSUPPORTED_MODULE',
          `Extension ${id} must have npm origin`,
        );
      const composition = validateExtensionComposition(extension);
      const alias = `${camel(id)}Module`;
      addImport(origin.packageName, `${extension.exportName} as ${alias}`);
      const hostOptions = composition?.hostOptions;
      if (hostOptions === undefined) {
        variables.set(id, alias);
        continue;
      }
      // A configuração vem do host por token declarado no descriptor; o perfil nunca a contém.
      const key = useHostToken(camel(hostOptions.token), hostOptions.token, id);
      addImport(origin.packageName, hostOptions.type, true);
      const variable = camel(id);
      declarations.push(
        `const ${variable} = ${alias}.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.${key}], useFactory: (options: unknown) => options as ${hostOptions.type} });`,
      );
      variables.set(id, variable);
      continue;
    }

    const source = NATIVE_SOURCES[id];
    // Instrumentação não monta módulo Nest: é tratada por renderInstrumentation.
    if (source?.kind === 'instrumentation') continue;
    if (source === undefined || source.kind !== 'nest')
      throw new CompositionGenerationError(
        'GENERATOR_UNSUPPORTED_MODULE',
        `No generator source for ${id}`,
      );
    const variable = camel(id);
    const specifier = specifierFrom(outputPath, source.importPath);
    addImport(specifier, source.exportName);

    if (id === 'native/aws-s3') {
      // Credenciais ficam na cadeia padrão do SDK; o host fornece região, bucket e limites por token.
      useHostToken('awsS3Options', HOST_TOKEN_NAMES.awsS3Options, id);
      addImport(specifier, 'AwsS3Options', true);
      declarations.push(
        `const ${variable} = AwsS3Module.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.awsS3Options], useFactory: (options: unknown) => options as AwsS3Options });`,
      );
    } else if (id === 'native/cache-redis') {
      // Host e credenciais de Redis vêm do host por token; o perfil não os contém.
      useHostToken('cacheRedisOptions', HOST_TOKEN_NAMES.cacheRedisOptions, id);
      addImport(specifier, 'RedisCacheConfig', true);
      declarations.push(
        `const ${variable} = CacheRedisModule.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.cacheRedisOptions], useFactory: (config: unknown) => config as RedisCacheConfig });`,
      );
    } else if (id === 'native/persistence-typeorm') {
      // O catálogo é a lista da Foundation; só a configuração de conexão vem do host.
      useHostToken(
        'persistenceOptions',
        HOST_TOKEN_NAMES.persistenceOptions,
        id,
      );
      addImport(specifier, 'PERSISTENCE_CONTRIBUTIONS');
      addImport(specifier, 'PersistenceConfigInput', true);
      declarations.push(
        `const ${variable} = PersistenceTypeOrmModule.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.persistenceOptions], useFactory: (config: unknown) => ({ contributions: PERSISTENCE_CONTRIBUTIONS, config: config as PersistenceConfigInput }) });`,
      );
    } else if (id === 'native/queue-bullmq') {
      // Conexão e limites do Redis vêm do host por token; o perfil nunca os contém.
      // Somente produtor na API: o consumo é do processo worker (src/worker.ts).
      // ActivityStore e identidade ficam no próprio módulo; o DataSource vem do módulo de persistência já montado.
      const ownBindings = resolved.bindings.filter(
        (binding) => binding.consumerId === id,
      );
      const persistenceImports = [
        ...new Set(
          ownBindings.map((binding) => {
            const providerVariable = variables.get(binding.providerId);
            if (providerVariable === undefined)
              throw new CompositionGenerationError(
                'GENERATOR_UNSUPPORTED_MODULE',
                `${id} imports an unordered provider`,
              );
            return providerVariable;
          }),
        ),
      ];
      const activityStoreSpecifier = specifierFrom(
        outputPath,
        `${NATIVE_SOURCES['native/persistence-typeorm'].importPath}/activities`,
      );
      addImport(activityStoreSpecifier, 'TypeOrmActivityStore');
      addImport(specifier, 'ACTIVITY_STORE');
      addImport(specifier, 'JOB_IDENTITY_RESOLVER');
      addImport(specifier, 'QueueBullmqOptions', true);
      useHostToken(
        'queueBullmqOptions',
        HOST_TOKEN_NAMES.queueBullmqOptions,
        id,
      );
      useHostToken(
        'jobIdentityResolver',
        HOST_TOKEN_NAMES.jobIdentityResolver,
        id,
      );
      declarations.push(
        `const ${variable} = QueueBullmqModule.registerAsync({ imports: [${persistenceImports.join(', ')}], inject: [COMPOSITION_HOST_TOKENS.queueBullmqOptions], useFactory: (options: unknown) => options as QueueBullmqOptions, ports: [{ provide: ACTIVITY_STORE, useClass: TypeOrmActivityStore }, { provide: JOB_IDENTITY_RESOLVER, inject: [COMPOSITION_HOST_TOKENS.jobIdentityResolver], useFactory: (identities: unknown) => identities }] });`,
      );
    } else if (id === 'native/http-security') {
      const ownBindings = resolved.bindings.filter(
        (binding) => binding.consumerId === id,
      );
      const tokenBinding = ownBindings.find(
        (binding) => binding.capabilityId === 'access-token',
      );
      const tokenSource =
        tokenBinding === undefined
          ? undefined
          : accessTokenSource(tokenBinding.providerId, extensions, outputPath);
      if (tokenSource === undefined)
        throw new CompositionGenerationError(
          'GENERATOR_UNSUPPORTED_MODULE',
          `${id} has no access-token token source`,
        );
      const tokenName = tokenSource.tokenName;
      addImport(tokenSource.specifier, tokenName);
      // Providers vêm antes do consumidor na ordem resolvida; o mesmo objeto de módulo é reutilizado.
      const providerImports = [
        ...new Set(
          ownBindings.map((binding) => {
            const providerVariable = variables.get(binding.providerId);
            if (providerVariable === undefined)
              throw new CompositionGenerationError(
                'GENERATOR_UNSUPPORTED_MODULE',
                `${id} imports an unordered provider`,
              );
            return providerVariable;
          }),
        ),
      ];
      useHostToken('sessions', HOST_TOKEN_NAMES.sessions, id);
      useHostToken('identities', HOST_TOKEN_NAMES.identities, id);
      useHostToken('clock', HOST_TOKEN_NAMES.clock, id);
      declarations.push(
        `const ${variable} = FoundationCoreModule.withHttpSecurity({ imports: [${providerImports.join(', ')}], ports: { tokens: ${tokenName}, sessions: COMPOSITION_HOST_TOKENS.sessions, identities: COMPOSITION_HOST_TOKENS.identities, clock: COMPOSITION_HOST_TOKENS.clock } });`,
      );
    } else {
      throw new CompositionGenerationError(
        'GENERATOR_UNSUPPORTED_MODULE',
        `No generator template for ${id}`,
      );
    }
    variables.set(id, variable);
  }

  const nestModules = resolved.modules.filter(
    ({ id }) => NATIVE_SOURCES[id]?.kind !== 'instrumentation',
  );
  const moduleVariables = nestModules.map(({ id }) => {
    const variable = variables.get(id);
    if (variable === undefined)
      throw new CompositionGenerationError(
        'GENERATOR_UNSUPPORTED_MODULE',
        `No variable for ${id}`,
      );
    return variable;
  });
  const importLines = [...imports.entries()]
    .sort(([a], [b]) => compare(a, b))
    .flatMap(([specifier, entry]) => {
      const lines: string[] = [];
      if (entry.values.size > 0)
        lines.push(
          `import { ${[...entry.values].sort(compare).join(', ')} } from '${specifier}';`,
        );
      if (entry.types.size > 0)
        lines.push(
          `import type { ${[...entry.types].sort(compare).join(', ')} } from '${specifier}';`,
        );
      return lines;
    });

  const tokenEntries = [...hostTokens.keys()]
    .sort(compare)
    .map(
      (key) =>
        `${key}: Symbol.for('foundation.api.v1.host.${hostTokens.get(key)?.token}')`,
    );
  const metadata = {
    foundationApiMajor: resolved.foundationApiMajor,
    modules: resolved.modules.map((module) => ({
      id: module.id,
      enabledFeatures: module.enabledFeatures,
    })),
    bindings: resolved.bindings.map((binding) => ({
      consumerId: binding.consumerId,
      capabilityId: binding.capabilityId,
      providerId: binding.providerId,
    })),
  };

  const source = [
    HEADER,
    ...importLines,
    `export const COMPOSITION_HOST_TOKENS = { ${tokenEntries.join(', ')} } as const;`,
    `export const COMPOSITION_METADATA = ${JSON.stringify(metadata)} as const;`,
    ...declarations,
    `@Module({ imports: [${moduleVariables.join(', ')}], exports: [${moduleVariables.join(', ')}] })`,
    'export class GeneratedCompositionModule {}',
    '',
  ].join('\n');

  return { resolved, source: formatTypeScript(source) };
}

/** Export que entrega `access-token`, procurado entre nativos e extensões selecionadas. */
function accessTokenSource(
  providerId: string,
  extensions: readonly ExtensionSource[],
  outputPath: string,
): { readonly specifier: string; readonly tokenName: string } | undefined {
  const native = NATIVE_SOURCES[providerId];
  if (native?.kind === 'nest') {
    const tokenName = native.capabilityTokens?.['access-token'];
    return tokenName === undefined
      ? undefined
      : { specifier: specifierFrom(outputPath, native.importPath), tokenName };
  }
  const extension = extensions.find(
    (source) => source.descriptor.id === providerId,
  );
  if (extension === undefined || extension.descriptor.origin.kind !== 'npm')
    return undefined;
  const tokenName =
    validateExtensionComposition(extension)?.capabilityTokens?.['access-token'];
  return tokenName === undefined
    ? undefined
    : { specifier: extension.descriptor.origin.packageName, tokenName };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Renderiza o arquivo de instrumentação. Sem `native/opentelemetry` no perfil,
 * o resultado não contém nenhum import; com ele, importa apenas o bootstrap.
 */
export function renderInstrumentation(
  profileSource: string,
  extensions: readonly ExtensionSource[],
  outputPath: string = DEFAULT_INSTRUMENTATION_OUTPUT,
): {
  readonly resolved: ResolvedComposition;
  readonly source: string;
} {
  const resolved = resolveCompositionProfile(profileSource, extensions);
  const imports = resolved.modules.flatMap(({ id }) => {
    const source = NATIVE_SOURCES[id];
    return source?.kind === 'instrumentation'
      ? [specifierFrom(outputPath, source.importPath)]
      : [];
  });
  const source = [
    HEADER,
    ...[...new Set(imports)]
      .sort(compare)
      .map((specifier) => `import '${specifier}';`),
    'export {};',
    '',
  ].join('\n');
  return { resolved, source: formatTypeScript(source) };
}

interface GenerationOptions {
  readonly profileSource: string;
  readonly extensions: readonly ExtensionSource[];
  readonly outputPath: string;
  readonly check: boolean;
}

function writeGenerated(
  source: string,
  outputPath: string,
  check: boolean,
): { readonly changed: boolean } {
  const current = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf8')
    : undefined;
  if (current === source) return { changed: false };
  if (check)
    throw new CompositionGenerationError(
      'GENERATED_STALE',
      `Generated composition is missing or stale: ${outputPath}`,
    );
  fs.writeFileSync(outputPath, source, 'utf8');
  return { changed: true };
}

/**
 * Modo escrita: grava somente se o conteúdo mudou. Modo verificação: falha se o
 * arquivo estiver ausente ou desatualizado, sem escrever nada.
 */
export function generateCompositionFile(options: GenerationOptions): {
  readonly changed: boolean;
} {
  const { source } = renderComposition(
    options.profileSource,
    options.extensions,
    options.outputPath,
  );
  return writeGenerated(source, options.outputPath, options.check);
}

/** Mesma semântica de `generateCompositionFile`, para `instrumentation.generated.ts`. */
export function generateInstrumentationFile(options: GenerationOptions): {
  readonly changed: boolean;
} {
  const { source } = renderInstrumentation(
    options.profileSource,
    options.extensions,
    options.outputPath,
  );
  return writeGenerated(source, options.outputPath, options.check);
}
