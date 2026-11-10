import fs from 'node:fs';
import path from 'node:path';
import { RequestError, readRequestFile } from '../profiles/schema';
import { runConformance } from './run';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
      inventory: request.inventory === null ? null : {
        ...request.inventory,
        path: path.resolve(path.dirname(requestFile), request.inventory.path),
      },
    };
    const result = await runConformance({ request: resolved, outDir: path.resolve(outDir) });
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
