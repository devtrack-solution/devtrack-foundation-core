import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedComposition } from '../../application/modules/module-descriptor';
import { NATIVE_SOURCES } from './native-sources';
import type { ExtensionSource } from './composition-profile';
import { resolveCompositionProfile } from './composition-profile';

export type CompositionGenerationErrorCode =
  'GENERATED_STALE' | 'GENERATOR_UNSUPPORTED_MODULE';

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
  jwtAuthOptions: 'jwt-auth.options',
  jobIdentityResolver: 'job-identity-resolver',
  persistenceOptions: 'persistence.options',
  queueBullmqOptions: 'queue-bullmq.options',
  sessions: 'sessions',
  swaggerOptions: 'swagger.options',
} as const;
type HostTokenName = keyof typeof HOST_TOKEN_NAMES;

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
  const hostTokens = new Set<HostTokenName>();
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
      const alias = `${camel(id)}Module`;
      addImport(origin.packageName, `${extension.exportName} as ${alias}`);
      variables.set(id, alias);
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

    if (id === 'native/jwt-auth') {
      // A configuração de chaves vem do host por token; o perfil nunca a contém.
      hostTokens.add('jwtAuthOptions');
      addImport(specifier, 'JwtAuthOptions', true);
      declarations.push(
        `const ${variable} = JwtAuthModule.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.jwtAuthOptions], useFactory: (options: unknown) => options as JwtAuthOptions });`,
      );
    } else if (id === 'native/swagger-adapter') {
      // Título e versão vêm do host por token; o perfil nunca os contém.
      hostTokens.add('swaggerOptions');
      addImport(specifier, 'SwaggerAdapterOptions', true);
      declarations.push(
        `const ${variable} = SwaggerAdapterModule.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.swaggerOptions], useFactory: (options: unknown) => options as SwaggerAdapterOptions });`,
      );
    } else if (id === 'native/aws-s3') {
      // Credenciais ficam na cadeia padrão do SDK; o host fornece região, bucket e limites por token.
      hostTokens.add('awsS3Options');
      addImport(specifier, 'AwsS3Options', true);
      declarations.push(
        `const ${variable} = AwsS3Module.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.awsS3Options], useFactory: (options: unknown) => options as AwsS3Options });`,
      );
    } else if (id === 'native/cache-redis') {
      // Host e credenciais de Redis vêm do host por token; o perfil não os contém.
      hostTokens.add('cacheRedisOptions');
      addImport(specifier, 'RedisCacheConfig', true);
      declarations.push(
        `const ${variable} = CacheRedisModule.registerAsync({ inject: [COMPOSITION_HOST_TOKENS.cacheRedisOptions], useFactory: (config: unknown) => config as RedisCacheConfig });`,
      );
    } else if (id === 'native/persistence-typeorm') {
      // O catálogo é a lista da Foundation; só a configuração de conexão vem do host.
      hostTokens.add('persistenceOptions');
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
      hostTokens.add('queueBullmqOptions');
      hostTokens.add('jobIdentityResolver');
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
      const providerSource =
        tokenBinding === undefined
          ? undefined
          : NATIVE_SOURCES[tokenBinding.providerId];
      const tokenName =
        providerSource?.kind === 'nest'
          ? providerSource.capabilityTokens?.['access-token']
          : undefined;
      if (providerSource?.kind !== 'nest' || tokenName === undefined)
        throw new CompositionGenerationError(
          'GENERATOR_UNSUPPORTED_MODULE',
          `${id} has no access-token token source`,
        );
      addImport(
        specifierFrom(outputPath, providerSource.importPath),
        tokenName,
      );
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
      hostTokens.add('sessions');
      hostTokens.add('identities');
      hostTokens.add('clock');
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

  const tokenEntries = [...hostTokens]
    .sort(compare)
    .map(
      (name) =>
        `${name}: Symbol.for('foundation.api.v1.host.${HOST_TOKEN_NAMES[name]}')`,
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
