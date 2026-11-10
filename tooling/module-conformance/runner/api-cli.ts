import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Onde o kit encontrou o instalador canônico (`@devtrack/api-cli`).
 *
 * - `source`: checkout do api-cli (monorepo), com `src/*.ts` e o bin compilado em `dist/src`.
 * - `package`: pacote publicado, só com `dist/src/*.js`.
 */
export interface ApiCliLocation {
  readonly root: string;
  readonly layout: 'source' | 'package';
  readonly validation: string;
  readonly extensions: string;
  readonly bin: string;
}

export const API_CLI_ROOT_ENV = 'DEVTRACK_API_CLI_ROOT';
export const API_CLI_PACKAGE = '@devtrack/api-cli';

/** Raiz da Foundation que contém o kit (`foundation-api/tooling/module-conformance/runner`). */
const FOUNDATION_ROOT = path.resolve(__dirname, '..', '..', '..');

function locate(root: string): ApiCliLocation | null {
  const bin = path.join(root, 'dist', 'src', 'bin.js');
  if (fs.existsSync(path.join(root, 'src', 'validation.ts'))) {
    return { root, layout: 'source', validation: path.join(root, 'src', 'validation.ts'), extensions: path.join(root, 'src', 'extensions.ts'), bin };
  }
  const validation = path.join(root, 'dist', 'src', 'validation.js');
  if (fs.existsSync(validation)) {
    return { root, layout: 'package', validation, extensions: path.join(root, 'dist', 'src', 'extensions.js'), bin };
  }
  return null;
}

function installedPackageRoot(from: string): string | null {
  try {
    return path.dirname(createRequire(path.join(from, 'package.json')).resolve(`${API_CLI_PACKAGE}/package.json`));
  } catch {
    return null;
  }
}

/**
 * Resolve o api-cli, nesta ordem: caminho explícito, variável `DEVTRACK_API_CLI_ROOT`, pasta irmã
 * da Foundation (monorepo) e pacote `@devtrack/api-cli` instalado no `node_modules` da Foundation
 * (repositório isolado e CI). Caminho explícito ou variável que não aponte para um api-cli válido
 * resulta em `null`, sem cair nas demais opções, para que a configuração errada apareça no relatório.
 */
export function resolveApiCli(explicit?: string, env: NodeJS.ProcessEnv = process.env, foundationRoot = FOUNDATION_ROOT): ApiCliLocation | null {
  if (explicit !== undefined) return locate(path.resolve(explicit));
  const fromEnv = env[API_CLI_ROOT_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return locate(path.resolve(fromEnv));
  const sibling = locate(path.resolve(foundationRoot, '..', 'api-cli'));
  if (sibling !== null) return sibling;
  const installed = installedPackageRoot(foundationRoot);
  return installed === null ? null : locate(installed);
}
