/**
 * Qualificação de um módulo contra a Foundation publicada (change split-foundation-repositories,
 * D5). É o passo de conformidade do CI dos módulos e roda a partir do checkout da
 * Foundation na tag da versão publicada, que fornece o kit e o host de instalação.
 *
 * Sequência:
 * 1. Resolve no registry real (`--registry`, o DEVTRACK_REGISTRY) a maior versão publicada da
 *    Foundation dentro da faixa do peer do módulo e exige que este checkout seja essa versão.
 * 2. Sobe um Verdaccio efêmero (Docker): `@devtrack-solution/*` sem uplink, demais pacotes do npmjs.
 * 3. Copia para ele o tarball publicado da Foundation, com a integrity conferida contra o registry
 *    real, e publica nele o `npm pack` do módulo. Nada é publicado no registry real.
 * 4. Instala `@devtrack-solution/api-cli` do registry real num prefixo separado (DEVTRACK_API_CLI_ROOT).
 * 5. Monta o inventário num host limpo (api-cli install + build:artifact), escreve a requisição
 *    do perfil padrão e roda o kit. O código de saída é o do kit: 0 passed, 1 failed, 2 incomplete.
 *
 * Uso: npm run -s conformance:published -- --module <checkout do módulo> --registry <url>
 *        --out <diretório do relatório> [--api-cli-version <versão>] [--work <dir>] [--keep]
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { digestTree } from '../checks/artifacts';
import { API_CLI_PACKAGE, API_CLI_ROOT_ENV, resolveApiCli } from './api-cli';

const FOUNDATION_ROOT = path.resolve(__dirname, '..', '..', '..');
const FOUNDATION_PACKAGE = '@devtrack-solution/foundation-api';
const VERDACCIO_IMAGE = 'verdaccio/verdaccio:6';
/** Prazo dos comandos docker: um daemon travado não pode prender o job até o timeout do CI. */
const DOCKER_TIMEOUT_MS = 120_000;

export class QualifyError extends Error {}

interface Options {
  readonly module: string;
  readonly registry: string;
  readonly out: string;
  readonly apiCliVersion: string;
  readonly work: string | null;
  readonly keep: boolean;
}

interface ModuleManifest {
  readonly name: string;
  readonly version: string;
  readonly peerRange: string;
  readonly descriptorFile: string;
}

function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  const module = arg(argv, '--module');
  const registry = arg(argv, '--registry') ?? env.DEVTRACK_REGISTRY;
  const out = arg(argv, '--out');
  if (module === undefined || out === undefined || registry === undefined || registry === '')
    throw new QualifyError('Uso: conformance:published --module <dir> --registry <url> --out <dir> [--api-cli-version <v>] [--work <dir>] [--keep]');
  return {
    module: path.resolve(module),
    registry: registry.replace(/\/+$/, ''),
    out: path.resolve(out),
    apiCliVersion: arg(argv, '--api-cli-version') ?? env.API_CLI_VERSION ?? 'latest',
    work: arg(argv, '--work') ?? null,
    keep: argv.includes('--keep'),
  };
}

/** Lê do `package.json` do módulo o que a qualificação precisa, recusando o que falta. */
export function readModuleManifest(moduleRoot: string): ModuleManifest {
  const file = path.join(moduleRoot, 'package.json');
  if (!fs.existsSync(file)) throw new QualifyError(`package.json ausente em ${moduleRoot}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    name?: string;
    version?: string;
    peerDependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
  };
  const peerRange = manifest.peerDependencies?.[FOUNDATION_PACKAGE];
  if (peerRange === undefined) throw new QualifyError(`${manifest.name ?? moduleRoot} não declara ${FOUNDATION_PACKAGE} em peerDependencies`);
  const descriptor = manifest.exports?.['./descriptor'];
  if (typeof descriptor !== 'string') throw new QualifyError(`${manifest.name ?? moduleRoot} não exporta "./descriptor" no package.json`);
  if (manifest.name === undefined || manifest.version === undefined) throw new QualifyError(`package.json de ${moduleRoot} sem name ou version`);
  return { name: manifest.name, version: manifest.version, peerRange, descriptorFile: descriptor.replace(/^\.\//, '') };
}

/** Maior versão estável da lista devolvida por `npm view <pacote>@<faixa> version --json`. */
export function highestVersion(viewOutput: string): string | null {
  const trimmed = viewOutput.trim();
  if (trimmed === '') return null;
  const parsed = JSON.parse(trimmed) as string | string[];
  const versions = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  if (versions.length === 0) return null;
  const key = (v: string): number[] => v.split('.').map(Number);
  return versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  })[versions.length - 1];
}

/**
 * Ambiente do filho: as chaves de `extra` substituem as do processo sem distinção de caixa. Sob
 * `npm run`, o npm exporta `npm_config_userconfig` em minúsculas, que disputaria com o
 * `NPM_CONFIG_USERCONFIG` do registry efêmero.
 */
export function childEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overridden = new Set(Object.keys(extra).map((key) => key.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!overridden.has(key.toLowerCase())) env[key] = value;
  return { ...env, ...extra };
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: childEnv(process.env, env), maxBuffer: 64 * 1024 * 1024 });
}

function requireOk(result: SpawnSyncReturns<string>, label: string): string {
  if (result.status !== 0)
    throw new QualifyError(`${label} falhou (exit ${result.status ?? 'sinal'}):\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-3000)}`);
  return result.stdout;
}

function log(message: string): void {
  process.stdout.write(`[conformance:published] ${message}\n`);
}

function sha512Sri(file: string): string {
  return `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

function copyTree(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // `cp -c` clona no APFS (macOS); fora dele cai na cópia comum.
  if (spawnSync('cp', ['-cR', source, destination]).status === 0) return;
  fs.rmSync(destination, { recursive: true, force: true });
  execFileSync('cp', ['-R', source, destination], { stdio: 'pipe' });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

interface EphemeralRegistry {
  readonly url: string;
  readonly userconfig: string;
  stop(): void;
}

async function startEphemeralRegistry(dir: string): Promise<EphemeralRegistry> {
  if (spawnSync('docker', ['info'], { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS }).status !== 0)
    throw new QualifyError('Docker indisponível: o Verdaccio efêmero da qualificação roda em contêiner');
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  // O processo do contêiner não roda como o usuário do host: o storage precisa ser gravável.
  fs.chmodSync(data, 0o777);
  const config = path.join(dir, 'config.yaml');
  fs.writeFileSync(config, [
    'storage: /verdaccio/storage/data',
    'auth:',
    '  htpasswd:',
    '    file: /verdaccio/storage/data/htpasswd',
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    '    timeout: 60s',
    'packages:',
    "  '@devtrack-solution/*':",
    '    access: $all',
    '    publish: $all',
    "  '**':",
    '    access: $all',
    '    proxy: npmjs',
    'log: { type: stdout, format: pretty, level: warn }',
    '',
  ].join('\n'));
  fs.chmodSync(config, 0o644);
  const port = await freePort();
  const name = `devtrack-qualify-${randomUUID().slice(0, 8)}`;
  requireOk(spawnSync('docker', [
    'run', '-d', '--name', name, '-p', `127.0.0.1:${port}:4873`,
    '-v', `${config}:/verdaccio/conf/config.yaml:ro`, '-v', `${data}:/verdaccio/storage/data`, VERDACCIO_IMAGE,
  ], { cwd: dir, encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS }), 'docker run do Verdaccio efêmero');
  const url = `http://127.0.0.1:${port}`;
  const stop = (): void => {
    const removed = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
    if (removed.status !== 0) process.stderr.write(`[conformance:published] não consegui remover o contêiner ${name}; remova com docker rm -f ${name}\n`);
  };
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${url}/-/ping`)).ok) {
        const userconfig = path.join(dir, 'npmrc');
        fs.writeFileSync(userconfig, `@devtrack-solution:registry=${url}/\n//127.0.0.1:${port}/:_authToken=ephemeral\n`);
        return { url, userconfig, stop };
      }
    } catch {
      // Contêiner ainda inicializando.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  stop();
  throw new QualifyError(`Verdaccio efêmero não respondeu: ${`${logs.stdout}${logs.stderr}`.slice(-800)}`);
}

function packJson(stdout: string, destination: string): string {
  // Scripts de ciclo de vida podem escrever antes do JSON; o array é o último bloco da saída.
  const start = stdout.lastIndexOf('\n[');
  const json = JSON.parse(start >= 0 ? stdout.slice(start + 1) : stdout) as { filename: string }[];
  return path.join(destination, json[0].filename);
}

export async function qualifyPublished(options: Options): Promise<number> {
  const manifest = readModuleManifest(options.module);
  const real = `--@devtrack-solution:registry=${options.registry}/`;
  log(`${manifest.name}@${manifest.version}, peer ${FOUNDATION_PACKAGE}@${manifest.peerRange}, registry ${options.registry}`);

  // 1. Foundation publicada dentro da faixa do peer, e este checkout precisa ser ela.
  const view = run('npm', ['view', `${FOUNDATION_PACKAGE}@${manifest.peerRange}`, 'version', '--json', real], FOUNDATION_ROOT);
  const published = view.status === 0 ? highestVersion(view.stdout) : null;
  if (published === null)
    throw new QualifyError(`peer "${FOUNDATION_PACKAGE}@${manifest.peerRange}" não tem versão publicada em ${options.registry}`);
  const checkoutVersion = (JSON.parse(fs.readFileSync(path.join(FOUNDATION_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  if (checkoutVersion !== published)
    throw new QualifyError(`checkout da Foundation está na versão ${checkoutVersion}, mas a publicada na faixa ${manifest.peerRange} é ${published}: use a tag v${published}`);
  const integrity = requireOk(run('npm', ['view', `${FOUNDATION_PACKAGE}@${published}`, 'dist.integrity', real], FOUNDATION_ROOT), 'npm view da integrity').trim();
  log(`host: ${FOUNDATION_PACKAGE}@${published} (${integrity.slice(0, 24)}…)`);

  const work = fs.realpathSync(fs.mkdtempSync(path.join(options.work ?? os.tmpdir(), 'qualify-')));
  const registry = await startEphemeralRegistry(path.join(work, 'verdaccio'));
  const ephemeral = { NPM_CONFIG_USERCONFIG: registry.userconfig };
  try {
    // 2. Tarball publicado da Foundation e pacote do módulo no registry efêmero.
    const packs = path.join(work, 'packs');
    fs.mkdirSync(packs);
    const hostTarball = packJson(requireOk(run('npm', ['pack', `${FOUNDATION_PACKAGE}@${published}`, '--pack-destination', packs, '--json', real], packs), 'npm pack da Foundation publicada'), packs);
    if (sha512Sri(hostTarball) !== integrity) throw new QualifyError(`integrity do tarball da Foundation diverge do registry ${options.registry}`);
    requireOk(run('npm', ['publish', hostTarball, '--registry', `${registry.url}/`], packs, ephemeral), 'publish da Foundation no registry efêmero');
    const moduleTarball = packJson(requireOk(run('npm', ['pack', '--pack-destination', packs, '--json'], options.module), `npm pack de ${manifest.name}`), packs);
    requireOk(run('npm', ['publish', moduleTarball, '--registry', `${registry.url}/`], packs, ephemeral), `publish de ${manifest.name} no registry efêmero`);
    log(`registry efêmero ${registry.url}: ${FOUNDATION_PACKAGE}@${published} e ${manifest.name}@${manifest.version}`);

    // 3. Instalador canônico do registry real, num prefixo separado.
    const apiCliPrefix = path.join(work, 'api-cli');
    fs.mkdirSync(apiCliPrefix);
    fs.writeFileSync(path.join(apiCliPrefix, 'package.json'), JSON.stringify({ name: 'qualify-api-cli', version: '1.0.0', private: true }));
    requireOk(run('npm', ['install', `${API_CLI_PACKAGE}@${options.apiCliVersion}`, '--no-audit', '--no-fund', real], apiCliPrefix), `install de ${API_CLI_PACKAGE}@${options.apiCliVersion}`);
    const apiCli = resolveApiCli(path.join(apiCliPrefix, 'node_modules', API_CLI_PACKAGE));
    if (apiCli === null) throw new QualifyError(`${API_CLI_PACKAGE}@${options.apiCliVersion} instalado não tem o layout de pacote esperado`);
    const apiCliVersion = (JSON.parse(fs.readFileSync(path.join(apiCli.root, 'package.json'), 'utf8')) as { version: string }).version;
    log(`api-cli: ${API_CLI_PACKAGE}@${apiCliVersion}`);
    const kitEnv = { ...ephemeral, API_CLI_REGISTRY_ALLOWLIST: registry.url, [API_CLI_ROOT_ENV]: apiCli.root };

    // 4. Host publicado e módulo, como num consumidor instalado (sem link para checkout).
    const envDir = path.join(work, 'conformance-env');
    fs.mkdirSync(envDir);
    fs.writeFileSync(path.join(envDir, 'package.json'), JSON.stringify({ name: 'conformance-env', version: '1.0.0', private: true }));
    requireOk(run('npm', ['install', `${FOUNDATION_PACKAGE}@${published}`, `${manifest.name}@${manifest.version}`, '--ignore-scripts', '--no-audit', '--no-fund'], envDir, ephemeral), 'install do ambiente de conformidade');
    const host = path.join(envDir, 'node_modules', '@devtrack-solution', 'foundation-api');
    const moduleRoot = path.join(work, 'module');
    fs.mkdirSync(moduleRoot);
    execFileSync('tar', ['-xzf', moduleTarball, '-C', moduleRoot]);
    const modulePackage = path.join(moduleRoot, 'package');

    // 5. Inventário: host limpo com o módulo instalado pelo api-cli e build seletivo.
    const inventoryHost = path.join(work, 'host-inventory', 'foundation-api');
    copyTree(FOUNDATION_ROOT, inventoryHost);
    requireOk(run(process.execPath, [apiCli.bin, '--foundation', inventoryHost, 'install', `${manifest.name}@${manifest.version}`, '--registry', registry.url], inventoryHost, kitEnv), `api-cli install de ${manifest.name} no host do inventário`);
    const artifact = path.join(work, 'artifact');
    requireOk(run('npm', ['run', 'build:artifact', '--', '--profile', path.join(inventoryHost, 'config', 'composition.yaml'), '--out', artifact], inventoryHost, kitEnv), 'build:artifact do host do inventário');
    const inventoryFile = path.join(artifact, 'artifact-inventory.json');

    // 6. Requisição do perfil padrão e execução do kit (mesmo runner do autor).
    const foundationRoot = path.join(work, 'host-install', 'foundation-api');
    copyTree(FOUNDATION_ROOT, foundationRoot);
    const request = {
      schemaVersion: 1,
      host: { path: host, version: published, digest: digestTree(host) },
      module: { path: modulePackage, version: manifest.version, digest: digestTree(modulePackage) },
      profile: { id: 'standard', version: 1 },
      selection: { descriptorFile: manifest.descriptorFile, enabledFeatures: [], companions: [], bindings: [] },
      tools: { node: process.version },
      limits: { timeoutMs: 60_000, maxOutputBytes: 16_384 },
      inventory: { path: inventoryFile, version: '1', digest: `sha256:${createHash('sha256').update(fs.readFileSync(inventoryFile)).digest('hex')}` },
      registry: registry.url,
      foundationRoot,
    };
    const requestFile = path.join(work, 'request.json');
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
    fs.rmSync(options.out, { recursive: true, force: true });
    const kit = run(process.execPath, ['--require', 'ts-node/register/transpile-only', path.join(__dirname, 'cli.ts'), '--request', requestFile, '--out', options.out], FOUNDATION_ROOT, kitEnv);
    process.stdout.write(kit.stdout);
    process.stderr.write(kit.stderr);
    fs.writeFileSync(path.join(options.out, 'qualification.json'), `${JSON.stringify({
      module: `${manifest.name}@${manifest.version}`,
      host: `${FOUNDATION_PACKAGE}@${published}`,
      hostIntegrity: integrity,
      apiCli: `${API_CLI_PACKAGE}@${apiCliVersion}`,
      registry: options.registry,
      exitCode: kit.status,
    }, null, 2)}\n`);
    return kit.status ?? 1;
  } finally {
    registry.stop();
    if (!options.keep) fs.rmSync(work, { recursive: true, force: true });
    else log(`área de trabalho preservada em ${work}`);
  }
}

if (require.main === module) {
  qualifyPublished(parseOptions(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
