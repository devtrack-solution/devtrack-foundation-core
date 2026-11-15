import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RequestError, readRequestFile } from '../profiles/schema';
import { API_CLI_PACKAGE, API_CLI_ROOT_ENV, resolveApiCli } from './api-cli';
import { runConformance } from './run';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}


/**
 * Instalação canônica (D8): roda `api-cli install <nome>@<versão> --registry` na Foundation
 * informada, a partir do registry da requisição. Falha com a cauda da saída do instalador.
 */
function canonicalInstaller(registry: string) {
  return (foundationRoot: string, packageDir: string): void => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { name: string; version: string };
    // Mesmo instalador canônico dos hosts: pasta irmã no monorepo ou `@devtrack-solution/api-cli` instalado.
    const apiCli = resolveApiCli();
    if (apiCli === null) throw new Error(`api-cli não encontrado: instale ${API_CLI_PACKAGE} ou defina ${API_CLI_ROOT_ENV}`);
    if (!fs.existsSync(apiCli.bin)) throw new Error(`api-cli não compilado: ${apiCli.bin}`);
    const result = spawnSync(process.execPath, [
      apiCli.bin, '--foundation', foundationRoot, 'install', `${manifest.name}@${manifest.version}`, '--registry', registry,
    ], { encoding: 'utf8', timeout: 300_000 });
    if (result.status !== 0)
      throw new Error(`api-cli install ${manifest.name}@${manifest.version} falhou: ${`${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-5).join(' | ')}`);
  };
}

async function main(): Promise<number> {
  const requestFile = arg('--request');
  const outDir = arg('--out');
  const profileFile = arg('--profile');
  if (requestFile === undefined || outDir === undefined) {
    process.stderr.write('Uso: conformance --request <arquivo> --out <diretorio> [--profile <perfil.json>]\n');
    return 1;
  }
  try {
    const request = readRequestFile(path.resolve(requestFile), profileFile === undefined ? undefined : path.resolve(profileFile));
    const resolved = {
      ...request,
      host: { ...request.host, path: path.resolve(path.dirname(requestFile), request.host.path) },
      module: { ...request.module, path: path.resolve(path.dirname(requestFile), request.module.path) },
      baseline: request.baseline === null ? null : {
        host: { ...request.baseline.host, path: path.resolve(path.dirname(requestFile), request.baseline.host.path) },
        module: { ...request.baseline.module, path: path.resolve(path.dirname(requestFile), request.baseline.module.path) },
      },
      foundationRoot: request.foundationRoot === null ? null : path.resolve(path.dirname(requestFile), request.foundationRoot),
      inventory: request.inventory === null ? null : {
        ...request.inventory,
        path: path.resolve(path.dirname(requestFile), request.inventory.path),
      },
    };
    const result = await runConformance({
      request: resolved,
      outDir: path.resolve(outDir),
      ...(resolved.registry === null || resolved.foundationRoot === null
        ? {}
        : { installExtension: canonicalInstaller(resolved.registry) }),
    });
    process.stdout.write(fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8'));
    return result.exitCode;
  } catch (error) {
    if (error instanceof RequestError) {
      process.stderr.write(`failed ${error.field}: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
