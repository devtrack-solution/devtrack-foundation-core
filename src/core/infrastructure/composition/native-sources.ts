/**
 * Onde o gerador encontra cada capacidade nativa. Fica na infraestrutura porque
 * conhece caminhos e exports Nest; o catálogo de Application continua só com metadata.
 *
 * - `nest`: módulo Nest montado em `composition.generated.ts`.
 * - `instrumentation`: bootstrap importado por `instrumentation.generated.ts`,
 *   antes de qualquer outro módulo; não gera módulo Nest.
 *
 * Todo nativo declara `runtimePackages`: os pacotes npm de runtime que o código
 * dele importa. O build seletivo (`scripts/build-artifact.ts`) usa essa lista para
 * decidir quais dependências entram no artefato; um teste confere a lista contra
 * os imports reais do diretório do nativo.
 */
export type NativeSource = NestNativeSource | InstrumentationNativeSource;

interface NativeSourceBase {
  /** Pacotes npm de runtime importados pelo código do nativo (sem `node:*`). */
  readonly runtimePackages: readonly string[];
}

export interface NestNativeSource extends NativeSourceBase {
  readonly kind: 'nest';
  /** Caminho relativo a `src/composition/`, onde fica o módulo gerado. */
  readonly importPath: string;
  readonly exportName: string;
  /** Tokens de porta que o módulo expõe, por capacidade fornecida. */
  readonly capabilityTokens?: Readonly<Record<string, string>>;
}

export interface InstrumentationNativeSource extends NativeSourceBase {
  readonly kind: 'instrumentation';
  /** Caminho relativo a `src/composition/`; o import tem efeito colateral de inicialização. */
  readonly importPath: string;
}

/**
 * Pacotes que o núcleo (`src/core`, `src/contracts`, `src/composition`, bootstrap
 * da aplicação) precisa em runtime. `@nestjs/platform-express` e `reflect-metadata`
 * não aparecem em `from` do código da Foundation: o Nest os carrega na criação da
 * aplicação. Ficam declarados para que o artefato os tenha.
 */
export const CORE_RUNTIME_PACKAGES: readonly string[] = [
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  'reflect-metadata',
  'rxjs',
];

/**
 * Pacotes de tooling de desenvolvimento (geração, formatação, compilação). Nunca
 * entram no artefato, nem como dependência de core nem de nativo.
 */
export const TOOLING_PACKAGES: readonly string[] = [
  'prettier',
  'ts-node',
  'typescript',
];

export const NATIVE_SOURCES: Readonly<Record<string, NativeSource>> = {
  'native/http-security': {
    kind: 'nest',
    importPath: '../core/infrastructure/modules/foundation-core.module',
    exportName: 'FoundationCoreModule',
    // Código no núcleo; não há pacote npm próprio além do core.
    runtimePackages: [],
  },
  'native/aws-s3': {
    kind: 'nest',
    importPath: '../native/aws-s3',
    exportName: 'AwsS3Module',
    capabilityTokens: { 'object-storage': 'AWS_S3_OBJECT_STORAGE' },
    runtimePackages: ['@aws-sdk/client-s3'],
  },
  'native/cache-redis': {
    kind: 'nest',
    importPath: '../native/cache-redis',
    exportName: 'CacheRedisModule',
    capabilityTokens: { 'shared-rate-limit': 'SHARED_RATE_LIMITER' },
    runtimePackages: ['ioredis'],
  },
  'native/queue-bullmq': {
    kind: 'nest',
    importPath: '../native/queue-bullmq',
    exportName: 'QueueBullmqModule',
    capabilityTokens: { 'job-queue': 'JOB_QUEUE' },
    // `ioredis` não é importado diretamente pelo código do nativo; vem transitivo de `bullmq`.
    runtimePackages: ['bullmq'],
  },
  'native/persistence-typeorm': {
    kind: 'nest',
    importPath: '../native/persistence-typeorm',
    exportName: 'PersistenceTypeOrmModule',
    capabilityTokens: { persistence: 'PERSISTENCE_DATA_SOURCE' },
    // `pg` é carregado pelo TypeORM para o driver PostgreSQL; não é importado diretamente.
    runtimePackages: ['pg', 'typeorm'],
  },
  'native/opentelemetry': {
    kind: 'instrumentation',
    importPath: '../native/opentelemetry/bootstrap',
    runtimePackages: [
      '@opentelemetry/api',
      // Peer obrigatório de @opentelemetry/configuration (transitivo do SDK). Não é tooling:
      // entra no artefato só quando o OTel é selecionado.
      'yaml',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/instrumentation-express',
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-metrics',
      '@opentelemetry/sdk-node',
      '@opentelemetry/sdk-trace',
    ],
  },
};

/** Pacote de runtime declarado por um nativo, na forma mínima usada pelo resolvedor. */
export interface RuntimeDeclaration {
  readonly runtimePackages: readonly string[];
}

export interface ArtifactDependencyPlan {
  /** Pacotes do núcleo, ordenados. */
  readonly corePackages: readonly string[];
  /** Pacotes exigidos por cada nativo selecionado, ordenados por id do nativo. */
  readonly nativePackages: Readonly<Record<string, readonly string[]>>;
  /** União de núcleo e nativos selecionados: o que o artefato deve conter. */
  readonly runtimePackages: readonly string[];
  /**
   * Pacotes exclusivos de nativos NÃO selecionados: não podem aparecer no artefato.
   * Pacote compartilhado com o núcleo ou com um nativo selecionado não entra aqui.
   */
  readonly excludedPackages: readonly string[];
}

export class ArtifactDependencyError extends Error {
  constructor(
    readonly code: 'ARTIFACT_UNKNOWN_NATIVE' | 'ARTIFACT_TOOLING_IN_RUNTIME',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactDependencyError';
  }
}

/**
 * Resolve o conjunto de pacotes do artefato a partir dos nativos selecionados.
 * Puro: recebe o catálogo e as listas como parâmetros, para que o mesmo código
 * sirva ao catálogo real e a catálogos de fixture em teste.
 */
export function resolveArtifactDependencies(input: {
  readonly selectedNatives: readonly string[];
  readonly catalog: Readonly<Record<string, RuntimeDeclaration>>;
  readonly corePackages?: readonly string[];
  readonly toolingPackages?: readonly string[];
}): ArtifactDependencyPlan {
  const corePackages = sortUnique(input.corePackages ?? CORE_RUNTIME_PACKAGES);
  const tooling = new Set(input.toolingPackages ?? TOOLING_PACKAGES);
  const selected = sortUnique(input.selectedNatives);

  for (const id of selected)
    if (input.catalog[id] === undefined)
      throw new ArtifactDependencyError(
        'ARTIFACT_UNKNOWN_NATIVE',
        `Native ${id} has no runtime declaration`,
      );

  const declared = (id: string): readonly string[] => {
    const packages = sortUnique(input.catalog[id].runtimePackages);
    const leaked = packages.filter((name) => tooling.has(name));
    if (leaked.length > 0)
      throw new ArtifactDependencyError(
        'ARTIFACT_TOOLING_IN_RUNTIME',
        `Native ${id} declares tooling package(s) as runtime: ${leaked.join(', ')}`,
      );
    return packages;
  };

  const nativePackages: Record<string, readonly string[]> = {};
  for (const id of selected) nativePackages[id] = declared(id);

  const runtime = new Set<string>([
    ...corePackages,
    ...Object.values(nativePackages).flat(),
  ]);
  const kept = new Set(runtime);
  const excluded = new Set<string>();
  for (const id of Object.keys(input.catalog).sort()) {
    if (selected.includes(id)) continue;
    for (const name of declared(id)) if (!kept.has(name)) excluded.add(name);
  }

  return {
    corePackages,
    nativePackages,
    runtimePackages: sortUnique([...runtime]),
    excludedPackages: sortUnique([...excluded]),
  };
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Arquivos que só existem para gerar e validar a composição. O build em área
 * limpa os usa para gerar `composition.generated.ts` e os remove antes de compilar,
 * de modo que o artefato não depende de nenhum pacote de tooling.
 * Caminhos relativos a `foundation-api/`.
 */
export const TOOLING_SOURCE_FILES: readonly string[] = [
  'src/core/infrastructure/composition/composition-generator.ts',
  'src/core/infrastructure/composition/composition-profile.ts',
  'src/core/infrastructure/composition/native-sources.ts',
  'src/composition/extension-sources.ts',
];
