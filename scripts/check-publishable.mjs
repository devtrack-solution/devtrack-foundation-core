#!/usr/bin/env node
// Verificação de publicação dos pacotes @devtrack (spec foundation-distribution).
// Uso: devtrack-check-publishable [diretório do pacote] [--require-published-peers] [--registry <url>]
//   --require-published-peers: cada peer do escopo @devtrack precisa ter, no registry, uma versão
//   que satisfaça a faixa declarada (publicação ordenada: Foundation antes dos módulos).
// Exit 0 quando publicável; exit 1 com a lista de violações.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SCOPE = '@devtrack/';
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NON_PORTABLE_SPEC =
  /^(?:file:|link:|portal:|workspace:|git\+|git:|git@|github:|gitlab:|bitbucket:|https?:|\.{1,2}\/|\/|~\/)/;
const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'];

/** Lista violações de publicação de um package.json já lido. [] quando publicável. */
export function findPublishViolations(manifest) {
  const violations = [];
  const name = typeof manifest.name === 'string' ? manifest.name : '';
  if (!name.startsWith(REQUIRED_SCOPE) || name.length === REQUIRED_SCOPE.length)
    violations.push(`nome "${name || '(ausente)'}" fora do escopo ${REQUIRED_SCOPE.slice(0, -1)}`);
  if (typeof manifest.version !== 'string' || !EXACT_SEMVER.test(manifest.version))
    violations.push(`versão "${manifest.version ?? '(ausente)'}" não é semver exata`);
  if (manifest.private === true) violations.push('pacote marcado como private');
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = manifest[section];
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [dependency, spec] of Object.entries(entries)) {
      if (typeof spec === 'string' && NON_PORTABLE_SPEC.test(spec.trim()))
        violations.push(`${section} "${dependency}" usa especificador não portável (${spec})`);
    }
  }
  return violations;
}

/**
 * Peers `@devtrack/*` sem versão publicada que satisfaça a faixa. Consulta o registry com
 * `npm view <nome>@<faixa> version --json` (honra o `.npmrc`, inclusive o registry do escopo).
 */
export function findUnpublishedPeers(manifest, { registry, npm = 'npm' } = {}) {
  const missing = [];
  const peers = manifest.peerDependencies && typeof manifest.peerDependencies === 'object' ? manifest.peerDependencies : {};
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith(REQUIRED_SCOPE) || typeof range !== 'string') continue;
    const args = ['view', `${name}@${range}`, 'version', '--json', ...(registry ? ['--registry', registry] : [])];
    const result = spawnSync(npm, args, { encoding: 'utf8' });
    const output = (result.stdout ?? '').trim();
    if (result.status !== 0 || output === '' || output === '[]')
      missing.push(`peer "${name}@${range}" não tem versão publicada no registry${registry ? ` ${registry}` : ''}`);
  }
  return missing;
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--registry');
  const root = resolve(positional[0] ?? process.cwd());
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (error) {
    console.error(`[PUBLISH_CHECK] package.json ilegível em ${root}: ${error.message}`);
    return 1;
  }
  const violations = findPublishViolations(manifest);
  if (flag('--require-published-peers'))
    violations.push(...findUnpublishedPeers(manifest, { registry: valueOf('--registry') }));
  if (violations.length === 0) {
    const message = `[PUBLISH_CHECK] ${manifest.name}@${manifest.version} publicável`;
    // Em hooks do npm (prepack/prepublishOnly) a stdout se mistura com a saída de `npm pack --json`.
    if (process.env.npm_lifecycle_event?.startsWith('pre')) console.error(message);
    else console.log(message);
    return 0;
  }
  for (const violation of violations) console.error(`[PUBLISH_CHECK] ${violation}`);
  return 1;
}

// Executado diretamente (inclusive via symlink de node_modules ou shim de .bin): compara caminhos reais.
const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv));
