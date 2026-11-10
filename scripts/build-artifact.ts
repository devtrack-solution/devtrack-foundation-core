/**
 * Build seletivo em área limpa. Uso:
 *
 *   npm run build:artifact -- --profile <perfil.yaml> --out <diretório> [--workdir <diretório vazio>]
 *   npm run build:artifact -- --verify <diretório do artefato>
 *
 * Copia para uma área nova somente core, contratos, composição, bootstrap, os
 * diretórios dos nativos selecionados e, com `native/queue-bullmq`, o entrypoint
 * do worker (`src/worker.ts`); gera a composição nessa área; instala as
 * dependências de runtime nas versões exatas do lock do host; compila; grava
 * `artifact-inventory.json` e verifica o resultado antes de copiar para `--out`.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ArtifactDependencyError,
  type ArtifactDependencyPlan,
  NATIVE_SOURCES,
  TOOLING_PACKAGES,
  TOOLING_SOURCE_FILES,
  resolveArtifactDependencies,
} from '../src/core/infrastructure/composition/native-sources';
import { readCompositionProfile } from '../src/core/infrastructure/composition/composition-profile';

export const ARTIFACT_INVENTORY_FILE = 'artifact-inventory.json';
const INVENTORY_SCHEMA_VERSION = 2;
const HOST_ROOT = path.resolve(__dirname, '..');
/** Arquivos de `src/` (fora dos diretórios) necessários para `node dist/main.js`. */
const BOOTSTRAP_FILES = [
  'main.ts',
  'app.module.ts',
  'app.controller.ts',
  'app.service.ts',
];
/**
 * Entrypoint do processo worker (`node dist/worker.js`). Só entra no artefato quando
 * o nativo de fila está selecionado: ele importa `native/queue-bullmq` e
 * `native/persistence-typeorm`, que sem a fila não existem no artefato.
 */
const WORKER_ENTRYPOINT = 'worker.ts';
const WORKER_REQUIRED_NATIVE = 'native/queue-bullmq';
const COPIED_DIRECTORIES = ['core', 'contracts', 'composition'];
const TEST_FILE = /\.(spec|test)\.ts$/;

export class ArtifactBuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactBuildError';
  }
}

export interface ArtifactPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  /** Caminho no lock, por exemplo `node_modules/jose`; diferencia duplicatas aninhadas. */
  readonly path: string;
  /** Módulos que declaram o pacote como dependência direta (vazio para transitivos). */
  readonly directOf: readonly string[];
}

export interface ArtifactInventory {
  readonly schemaVersion: number;
  readonly foundationApiMajor: number;
  readonly profile: { readonly file: string; readonly sha256: string };
  readonly node: { readonly version: string };
  /** Processos presentes em `dist/`: `main` sempre; `worker` só com `native/queue-bullmq`. */
  readonly entrypoints: readonly string[];
  readonly modules: {
    readonly selected: readonly {
      readonly id: string;
      readonly features: readonly string[];
    }[];
    /** Existe no catálogo, mas não entrou no artefato (ausente fisicamente). */
    readonly excludedFromBuild: readonly string[];
    /**
     * Presente no artefato, mas desligado por configuração de runtime. Hoje vazio:
     * nenhuma funcionalidade é incluída e depois desligada.
     */
    readonly disabledAtRuntime: readonly string[];
  };
  /** Pacotes exclusivos de nativos excluídos: não podem existir no artefato. */
  readonly excludedPackages: readonly {
    readonly name: string;
    readonly owner: string;
  }[];
  /** Pacotes de tooling: nunca existem no artefato. */
  readonly neverInArtifact: readonly string[];
  readonly packages: readonly ArtifactPackage[];
}

function readJson(file: string): unknown {
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface LockEntry {
  readonly version: string;
  readonly integrity?: string;
  /** Opcional de plataforma (ex.: binários nativos de outro SO): o npm pode não instalar. */
  readonly optional?: boolean;
}

export interface PackageLock {
  readonly packages: Readonly<Record<string, LockEntry>>;
}

/** Valida a forma mínima do package-lock.json (mapa `packages` com versão por entrada). */
export function readPackageLock(file: string): PackageLock {
  const data = readJson(file);
  if (!isRecord(data) || !isRecord(data.packages))
    throw new ArtifactBuildError(
      'ARTIFACT_LOCK_INVALID',
      `${file} has no packages map`,
    );
  const packages: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(data.packages)) {
    if (!isRecord(entry))
      throw new ArtifactBuildError(
        'ARTIFACT_LOCK_INVALID',
        `${file} has a malformed entry`,
      );
    packages[key] = {
      version: typeof entry.version === 'string' ? entry.version : '',
      integrity:
        typeof entry.integrity === 'string' ? entry.integrity : undefined,
      optional: entry.optional === true,
    };
  }
  return { packages };
}

/** Valida a forma do inventário lido de disco (campos usados por verifyArtifact). */
function readInventory(file: string): ArtifactInventory {
  const data = readJson(file);
  if (
    !isRecord(data) ||
    !Array.isArray(data.packages) ||
    !Array.isArray(data.excludedPackages) ||
    !Array.isArray(data.neverInArtifact) ||
    !Array.isArray(data.entrypoints) ||
    !isRecord(data.modules) ||
    !Array.isArray(data.modules.selected) ||
    !Array.isArray(data.modules.excludedFromBuild)
  )
    throw new ArtifactBuildError(
      'ARTIFACT_INVENTORY_INVALID',
      `${file} is not a valid artifact inventory`,
    );
  return data as unknown as ArtifactInventory;
}

/** Valida a árvore do `npm ls --json`: versão opcional e filhos como registros. */
function toTreeNode(value: unknown): TreeNode {
  if (!isRecord(value)) return {};
  const version = typeof value.version === 'string' ? value.version : undefined;
  const children: Record<string, TreeNode> = {};
  if (isRecord(value.dependencies))
    for (const [name, child] of Object.entries(value.dependencies))
      children[name] = toTreeNode(child);
  return { version, dependencies: children };
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new ArtifactBuildError(
      'ARTIFACT_COMMAND_FAILED',
      `${path.basename(command)} ${args.slice(0, 2).join(' ')} failed (exit ${result.status}): ${output.slice(-2000)}`,
    );
  }
  return result.stdout;
}

/** Ambiente dos filhos sem a configuração npm herdada de npx/npm run (ex.: allow-scripts do usuário). */
function childEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^npm_config_/i.test(key)) env[key] = value;
  return { ...env, ...extra };
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function prepareWorkdir(requested: string | undefined): {
  readonly dir: string;
  readonly temporary: boolean;
} {
  if (requested === undefined)
    return {
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-artifact-')),
      temporary: true,
    };
  const dir = path.resolve(requested);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0)
    throw new ArtifactBuildError(
      'ARTIFACT_WORKDIR_NOT_EMPTY',
      `Work directory must be new or empty: ${dir}`,
    );
  fs.mkdirSync(dir, { recursive: true });
  return { dir, temporary: false };
}

function copyFiltered(source: string, target: string): void {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (entry) =>
      !TEST_FILE.test(entry) && !entry.includes('node_modules'),
  });
}

/** Caminhos de pacote no lock: o nome vem depois do último `node_modules/`. */
function lockPackageName(lockPath: string): string {
  return lockPath.slice(
    lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length,
  );
}

interface TreeNode {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, TreeNode>>;
}

/**
 * Percorre a árvore do `npm ls` e resolve cada nó para a entrada real do lock.
 * A árvore vem hoistada: um filho pode estar em `node_modules/<nome>` de um
 * ancestral, então o caminho sobe pelos `node_modules` até achar a entrada.
 * Peer opcional ausente aparece sem versão e não está instalado: não entra.
 */
function collectTree(
  dependencies: Readonly<Record<string, TreeNode>> | undefined,
  parentPath: string,
  lockKeys: ReadonlySet<string>,
  out: Map<string, { path: string; name: string; version: string }>,
): void {
  for (const [name, node] of Object.entries(dependencies ?? {})) {
    if (node.version === undefined) continue;
    const lockPath = resolveLockPath(parentPath, name, lockKeys);
    if (!out.has(lockPath))
      out.set(lockPath, { path: lockPath, name, version: node.version });
    collectTree(node.dependencies, lockPath, lockKeys, out);
  }
}

function resolveLockPath(
  parentPath: string,
  name: string,
  lockKeys: ReadonlySet<string>,
): string {
  let base = parentPath;
  for (;;) {
    const candidate =
      base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (lockKeys.has(candidate) || base === '') return candidate;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/** Confere o inventário com o lock e com o conteúdo do diretório (node_modules, se houver). */
export function verifyArtifact(root: string): void {
  const inventory = readInventory(path.join(root, ARTIFACT_INVENTORY_FILE));
  const lock = readPackageLock(path.join(root, 'package-lock.json'));
  const failures: string[] = [];
  const lockEntries = lock.packages;
  const lockNames = new Set(
    Object.keys(lockEntries)
      .filter((key) => key !== '')
      .map(lockPackageName),
  );

  for (const pkg of inventory.packages) {
    const entry = lockEntries[pkg.path];
    if (
      entry === undefined ||
      entry.version !== pkg.version ||
      entry.integrity !== pkg.integrity
    )
      failures.push(`inventory ${pkg.path} does not match package-lock`);
  }
  const inventoryPaths = new Set(inventory.packages.map((pkg) => pkg.path));
  // Opcionais de plataforma que o npm não instalou neste SO ficam no lock sem
  // aparecer em `npm ls`. Só essas são ignoradas; qualquer outro pacote faltando reprova.
  for (const key of Object.keys(lockEntries))
    if (
      key !== '' &&
      !inventoryPaths.has(key) &&
      lockEntries[key]?.optional !== true
    )
      failures.push(`lock ${key} is missing from the inventory`);

  const forbidden = [
    ...inventory.excludedPackages.map((pkg) => ({
      name: pkg.name,
      reason: `excluded-from-build (${pkg.owner})`,
    })),
    ...inventory.neverInArtifact.map((name) => ({ name, reason: 'tooling' })),
  ];
  const distDir = path.join(root, 'dist');
  const distSources = listFiles(distDir).filter((file) =>
    /\.(?:c|m)?js$|\.d\.ts$/.test(file),
  );
  const distText = distSources.map((file) => fs.readFileSync(file, 'utf8'));
  const nodeModules = path.join(root, 'node_modules');
  for (const { name, reason } of forbidden) {
    if (lockNames.has(name))
      failures.push(`${name} (${reason}) is in package-lock`);
    if (fs.existsSync(path.join(nodeModules, name)))
      failures.push(`${name} (${reason}) is in node_modules`);
    const pattern = new RegExp(`['"]${escapeRegExp(name)}(?:/[^'"]*)?['"]`);
    if (distText.some((text) => pattern.test(text)))
      failures.push(`${name} (${reason}) is referenced by dist`);
  }

  const selectedIds = new Set(
    inventory.modules.selected.map((module) => module.id),
  );
  for (const id of inventory.modules.excludedFromBuild) {
    if (selectedIds.has(id))
      failures.push(`${id} is both selected and excluded`);
    if (fs.existsSync(path.join(distDir, id)))
      failures.push(`dist/${id} exists for an excluded module`);
  }
  const workerInDist = fs.existsSync(path.join(distDir, 'worker.js'));
  const workerListed = inventory.entrypoints.includes('worker');
  if (workerInDist !== workerListed)
    failures.push(
      workerInDist
        ? 'dist/worker.js exists but worker is not listed in entrypoints'
        : 'worker is listed in entrypoints but dist/worker.js is missing',
    );
  if (workerListed && !selectedIds.has(WORKER_REQUIRED_NATIVE))
    failures.push(`worker requires ${WORKER_REQUIRED_NATIVE} to be selected`);
  if (!inventory.entrypoints.includes('main'))
    failures.push('main is missing from entrypoints');
  const distNative = path.join(distDir, 'native');
  if (fs.existsSync(distNative))
    for (const entry of fs.readdirSync(distNative))
      if (!selectedIds.has(`native/${entry}`))
        failures.push(`dist/native/${entry} exists without selection`);

  if (failures.length > 0)
    throw new ArtifactBuildError(
      'ARTIFACT_VERIFICATION_FAILED',
      `Artifact verification failed:\n- ${failures.join('\n- ')}`,
    );
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BuildOptions {
  readonly profilePath: string;
  readonly outDir: string;
  /** Área limpa a usar (deve estar vazia ou não existir). Padrão: diretório temporário, removido ao final. */
  readonly workDir?: string;
}

export function buildArtifact(options: BuildOptions): ArtifactInventory {
  const profileSource = fs.readFileSync(options.profilePath, 'utf8');
  const profile = readCompositionProfile(profileSource);
  const selectedIds = profile.natives.map((native) => native.id);
  let plan: ArtifactDependencyPlan;
  try {
    plan = resolveArtifactDependencies({
      selectedNatives: selectedIds,
      catalog: NATIVE_SOURCES,
    });
  } catch (error) {
    if (error instanceof ArtifactDependencyError)
      throw new ArtifactBuildError(error.code, error.message);
    throw error;
  }

  const hostLock = readPackageLock(path.join(HOST_ROOT, 'package-lock.json'));
  const exactVersion = (name: string): string => {
    const version = hostLock.packages[`node_modules/${name}`]?.version;
    if (typeof version !== 'string')
      throw new ArtifactBuildError(
        'ARTIFACT_LOCK_MISSING',
        `${name} has no exact version in the host package-lock.json`,
      );
    return version;
  };

  const owners = new Map<string, string[]>();
  const addOwner = (name: string, owner: string) =>
    owners.set(name, [...(owners.get(name) ?? []), owner].sort());
  for (const name of plan.corePackages) addOwner(name, 'core');
  for (const [id, names] of Object.entries(plan.nativePackages))
    for (const name of names) addOwner(name, id);

  const dependencies: Record<string, string> = {};
  for (const name of plan.runtimePackages)
    dependencies[name] = exactVersion(name);
  for (const extension of profile.extensions) {
    dependencies[extension.packageName] = extension.version;
    addOwner(extension.packageName, `extension:${extension.id}`);
  }

  const work = prepareWorkdir(options.workDir);
  const entrypoints = ['main'];
  try {
    const root = work.dir;
    const srcTarget = path.join(root, 'src');
    fs.mkdirSync(srcTarget, { recursive: true });
    for (const directory of COPIED_DIRECTORIES)
      copyFiltered(
        path.join(HOST_ROOT, 'src', directory),
        path.join(srcTarget, directory),
      );
    for (const file of BOOTSTRAP_FILES)
      fs.copyFileSync(
        path.join(HOST_ROOT, 'src', file),
        path.join(srcTarget, file),
      );
    if (selectedIds.includes(WORKER_REQUIRED_NATIVE)) {
      fs.copyFileSync(
        path.join(HOST_ROOT, 'src', WORKER_ENTRYPOINT),
        path.join(srcTarget, WORKER_ENTRYPOINT),
      );
      entrypoints.push('worker');
    }
    for (const id of selectedIds) {
      const source = path.join(HOST_ROOT, 'src', id);
      if (fs.existsSync(source)) copyFiltered(source, path.join(srcTarget, id));
    }
    for (const file of ['tsconfig.json', 'tsconfig.build.json'])
      fs.copyFileSync(path.join(HOST_ROOT, file), path.join(root, file));
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'composition.yaml'),
      profileSource,
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(HOST_ROOT, 'scripts', 'generate-composition.ts'),
      path.join(root, 'scripts', 'generate-composition.ts'),
    );
    // Lock do host como semente: o npm reaproveita as versões exatas já resolvidas.
    fs.copyFileSync(
      path.join(HOST_ROOT, 'package-lock.json'),
      path.join(root, 'package-lock.json'),
    );
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'foundation-api-artifact',
          version: '0.0.1',
          private: true,
          license: 'UNLICENSED',
          main: 'dist/main.js',
          scripts: { start: 'node dist/main.js' },
          dependencies: sortObject(dependencies),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // Gerador roda na área limpa com o tooling do host: NODE_PATH aponta para os
    // pacotes de desenvolvimento (prettier, yaml); eles nunca entram no artefato.
    const hostModules = path.join(HOST_ROOT, 'node_modules');
    run(
      process.execPath,
      [
        path.join(hostModules, 'ts-node', 'dist', 'bin.js'),
        '--transpile-only',
        'scripts/generate-composition.ts',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_PATH: [hostModules, process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
    );
    for (const file of TOOLING_SOURCE_FILES)
      fs.rmSync(path.join(root, file), { force: true });
    fs.rmSync(path.join(root, 'scripts'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });

    // "--allow-scripts=" anula a allowlist do usuario (npm 11 recusa essa opcao em instalacao de projeto); --ignore-scripts impede qualquer script.
    run(
      npmBin(),
      [
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--allow-scripts=',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: root,
      },
    );

    const tscPath = path.join(hostModules, 'typescript', 'bin', 'tsc');
    run(
      process.execPath,
      [
        tscPath,
        '-p',
        'tsconfig.build.json',
        '--incremental',
        'false',
        '--typeRoots',
        path.join(hostModules, '@types'),
        '--types',
        'node',
      ],
      { cwd: root },
    );

    const lock = readPackageLock(path.join(root, 'package-lock.json'));
    const tree = toTreeNode(JSON.parse(captureNpmTree(root)) as unknown);
    const installedMap = new Map<
      string,
      { path: string; name: string; version: string }
    >();
    collectTree(
      tree.dependencies,
      '',
      new Set(Object.keys(lock.packages)),
      installedMap,
    );
    const installed = [...installedMap.values()];

    const installedNames = new Set(installed.map((entry) => entry.name));
    const excludedPackages = plan.excludedPackages.map((name) => ({
      name,
      owner: nativeOwner(name, selectedIds, Object.keys(NATIVE_SOURCES)),
    }));
    for (const { name } of excludedPackages)
      if (installedNames.has(name))
        throw new ArtifactBuildError(
          'ARTIFACT_EXCLUDED_PRESENT',
          `Excluded package ${name} is present in the artifact tree`,
        );
    for (const name of TOOLING_PACKAGES)
      if (installedNames.has(name))
        throw new ArtifactBuildError(
          'ARTIFACT_TOOLING_PRESENT',
          `Tooling package ${name} is present in the artifact tree`,
        );

    const packages: ArtifactPackage[] = installed
      .map((entry) => {
        const lockEntry = lock.packages[entry.path] as LockEntry | undefined;
        if (lockEntry?.integrity === undefined)
          throw new ArtifactBuildError(
            'ARTIFACT_LOCK_MISSING',
            `${entry.path} has no integrity in the artifact lock`,
          );
        const isDirect = entry.path === `node_modules/${entry.name}`;
        return {
          name: entry.name,
          version: entry.version,
          integrity: lockEntry.integrity,
          path: entry.path,
          directOf: isDirect ? (owners.get(entry.name) ?? []) : [],
        };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    for (const extension of profile.extensions) {
      const pkg = packages.find(
        (item) => item.path === `node_modules/${extension.packageName}`,
      );
      if (pkg === undefined || pkg.integrity !== extension.integrity)
        throw new ArtifactBuildError(
          'ARTIFACT_EXTENSION_INTEGRITY',
          `Extension ${extension.id} integrity does not match the artifact lock`,
        );
    }

    const inventory: ArtifactInventory = {
      schemaVersion: INVENTORY_SCHEMA_VERSION,
      foundationApiMajor: profile.foundationApiMajor,
      profile: {
        file: path.basename(options.profilePath),
        sha256: crypto.createHash('sha256').update(profileSource).digest('hex'),
      },
      node: { version: process.version },
      entrypoints: [...entrypoints].sort(),
      modules: {
        selected: profile.natives.map((native) => ({
          id: native.id,
          features: [...native.features].sort(),
        })),
        excludedFromBuild: Object.keys(NATIVE_SOURCES)
          .filter((id) => !selectedIds.includes(id))
          .sort(),
        disabledAtRuntime: [],
      },
      excludedPackages,
      neverInArtifact: [...TOOLING_PACKAGES].sort(),
      packages,
    };
    fs.writeFileSync(
      path.join(root, ARTIFACT_INVENTORY_FILE),
      `${JSON.stringify(inventory, null, 2)}\n`,
      'utf8',
    );
    verifyArtifact(root);

    const out = path.resolve(options.outDir);
    fs.mkdirSync(out, { recursive: true });
    fs.rmSync(path.join(out, 'dist'), { recursive: true, force: true });
    fs.cpSync(path.join(root, 'dist'), path.join(out, 'dist'), {
      recursive: true,
    });
    for (const file of [
      'package.json',
      'package-lock.json',
      ARTIFACT_INVENTORY_FILE,
    ])
      fs.copyFileSync(path.join(root, file), path.join(out, file));
    verifyArtifact(out);
    return inventory;
  } finally {
    if (work.temporary) fs.rmSync(work.dir, { recursive: true, force: true });
  }
}

function captureNpmTree(root: string): string {
  // `npm ls` sai com código diferente de zero quando há problemas de peer; a saída JSON continua válida.
  const result = spawnSync(npmBin(), ['ls', '--all', '--omit=dev', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!result.stdout)
    throw new ArtifactBuildError(
      'ARTIFACT_COMMAND_FAILED',
      `npm ls produced no output: ${result.stderr}`,
    );
  return result.stdout;
}

function nativeOwner(
  name: string,
  selected: readonly string[],
  all: readonly string[],
): string {
  return (
    all.find(
      (id) =>
        !selected.includes(id) &&
        NATIVE_SOURCES[id]?.runtimePackages.includes(name) === true,
    ) ?? 'unknown'
  );
}

function sortObject(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new ArtifactBuildError(
        'ARGUMENT_INVALID',
        'Use --profile <file> --out <dir> or --verify <dir>',
      );
    values[key.slice(2)] = value;
  }
  return values;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.verify !== undefined) {
      verifyArtifact(path.resolve(args.verify));
      console.log('Artifact inventory verified.');
    } else {
      if (args.profile === undefined || args.out === undefined)
        throw new ArtifactBuildError(
          'ARGUMENT_INVALID',
          'Missing --profile or --out',
        );
      const inventory = buildArtifact({
        profilePath: path.resolve(args.profile),
        outDir: path.resolve(args.out),
        workDir:
          args.workdir === undefined ? undefined : path.resolve(args.workdir),
      });
      console.log(
        `Artifact built: ${inventory.packages.length} packages, modules [${inventory.modules.selected.map((m) => m.id).join(', ')}].`,
      );
    }
  } catch (error: unknown) {
    const code =
      error instanceof Error && 'code' in error ? String(error.code) : 'ERROR';
    const message = error instanceof Error ? error.message : 'Unknown failure';
    console.error(`[${code}] ${message}`);
    process.exitCode = 1;
  }
}
