import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../reports/schema';

const portable = (value: string): string => value.split(path.sep).join('/');

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(full);
        if (!inside(root, target)) throw new Error(`Symlink escapa do pacote: ${portable(path.relative(root, full))}`);
        if (fs.statSync(full).isDirectory()) walk(full);
        else out.push(portable(path.relative(root, full)));
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else out.push(portable(path.relative(root, full)));
    }
  };
  walk(root);
  return out;
}

/** Digest do conteúdo, sem caminhos absolutos. Symlink para fora do pacote é erro. */
export function digestTree(root: string): string {
  const hash = sha256(
    listFiles(root)
      .map((relative) => `${relative}\0${fs.readFileSync(path.join(root, relative)).toString('base64')}`)
      .join('\n'),
  );
  return `sha256:${hash}`;
}

/** Copia o pacote para o destino sem criar symlink, inclusive para o checkout de origem. */
export function copyPackage(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of listFiles(source)) {
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(from);
      if (!inside(source, target)) throw new Error(`Recusa symlink externo: ${relative}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (fs.lstatSync(to).isSymbolicLink()) throw new Error(`Cópia criou symlink: ${relative}`);
  }
}

export function exportTargets(manifest: Record<string, unknown>): string[] {
  const exported = manifest.exports;
  const targets: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push(value.slice(2));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) visit(nested);
    }
  };
  visit(exported);
  return [...new Set(targets)].sort();
}

export function missingExportFiles(root: string, manifest: Record<string, unknown>): string[] {
  return exportTargets(manifest).filter((relative) => !fs.existsSync(path.join(root, relative)));
}

const SPECIFIER = /(?:import|export)\s+(?:[^'";]*from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Import relativo que só resolve fora do pacote empacotado. Não consulta um checkout vizinho. */
export function checkoutDependentSpecifiers(root: string): string[] {
  const found: string[] = [];
  for (const relative of listFiles(root)) {
    if (!/\.(?:[cm]?[jt]s|d\.ts)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined || (!specifier.startsWith('.') && !path.isAbsolute(specifier))) continue;
      const target = path.resolve(path.dirname(path.join(root, relative)), specifier);
      if (!inside(root, target) && !inside(root, `${target}.js`) && !inside(root, `${target}.ts`)) {
        found.push(`${relative} -> ${specifier}`);
      }
    }
  }
  return found;
}

export function hasEscapingSymlink(root: string): string | null {
  const walk = (dir: string): string | null => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(full);
        if (!inside(root, target)) return portable(path.relative(root, full));
      } else if (entry.isDirectory()) {
        const found = walk(full);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(root);
}

const FOUNDATION_PACKAGE = '@devtrack-solution/foundation-api';
const LEGACY_FOUNDATION_PACKAGE = 'foundation-api';
const FOUNDATION_PUBLIC = new Set([`${FOUNDATION_PACKAGE}/contracts`, `${FOUNDATION_PACKAGE}/nest`]);

/**
 * Fronteira de layout `module` (D8): varre `.js`/`.d.ts` do pacote empacotado. A Foundation só
 * pode ser alcançada pelas fachadas `contracts` e `nest`; o nome antigo sem escopo e o import
 * relativo que sai do pacote reprovam. Devolve `arquivo -> especificador`.
 */
export function moduleBoundaryViolations(root: string): string[] {
  const found: string[] = [];
  for (const relative of listFiles(root)) {
    if (relative.startsWith('node_modules/') || !/\.(?:[cm]?js|d\.[cm]?ts)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(path.join(root, relative)), specifier);
        if (!inside(root, target)) found.push(`${relative} -> ${specifier}`);
        continue;
      }
      if (FOUNDATION_PUBLIC.has(specifier)) continue;
      if ([FOUNDATION_PACKAGE, LEGACY_FOUNDATION_PACKAGE].some((name) => specifier === name || specifier.startsWith(`${name}/`)))
        found.push(`${relative} -> ${specifier}`);
    }
  }
  return [...new Set(found)].sort();
}

/** Diretório `node_modules` que resolve as dependências do host: o próprio ou o ancestral que o contém. */
export function hostModulesDir(hostRoot: string): string | null {
  const real = fs.realpathSync(hostRoot);
  const own = path.join(real, 'node_modules');
  if (fs.existsSync(own)) return own;
  let current = path.dirname(real);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === 'node_modules') return current;
    current = path.dirname(current);
  }
  return null;
}

/**
 * Monta um `node_modules` ao lado da cópia do módulo, para boot e fixtures resolverem pacotes
 * como num consumidor instalado (D8): dependências do host por link e `@devtrack-solution/foundation-api`
 * apontando para o host. O próprio módulo não é ligado, para resolver sempre a cópia verificada.
 */
export function linkDependencyRoot(target: string, hostRoot: string, moduleName: string): void {
  fs.mkdirSync(target, { recursive: true });
  const link = (from: string, name: string): void => {
    if (name === moduleName || name === FOUNDATION_PACKAGE) return;
    const to = path.join(target, name);
    if (fs.existsSync(to)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(from, to, 'dir');
  };
  const modules = hostModulesDir(hostRoot);
  if (modules !== null) {
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(modules, entry.name);
      if (entry.name.startsWith('@') && fs.statSync(full).isDirectory()) {
        for (const scoped of fs.readdirSync(full)) link(path.join(full, scoped), `${entry.name}/${scoped}`);
      } else {
        link(full, entry.name);
      }
    }
  }
  const foundation = path.join(target, ...FOUNDATION_PACKAGE.split('/'));
  fs.mkdirSync(path.dirname(foundation), { recursive: true });
  fs.symlinkSync(fs.realpathSync(hostRoot), foundation, 'dir');
}

/** Versão instalada de um pacote no `node_modules` montado, ou undefined. */
export function linkedVersion(target: string, name: string): string | undefined {
  const manifest = path.join(target, ...name.split('/'), 'package.json');
  if (!fs.existsSync(manifest)) return undefined;
  const version = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
  return typeof version === 'string' ? version : undefined;
}
