import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { QualifyError, childEnv, highestVersion, parseOptions, qualifyPublished, readModuleManifest } from '../runner/qualify-published';

const created: string[] = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function moduleDir(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualify-module-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

const VALID = {
  name: '@devtrack-solution/sample',
  version: '1.2.3',
  peerDependencies: { '@devtrack-solution/foundation-api': '^0.1.0' },
  exports: { '.': './dist/index.js', './descriptor': './dist/sample.descriptor.json' },
};

describe('qualificação contra a Foundation publicada (pipeline dos módulos)', () => {
  it('opções: registry vem do argumento ou de DEVTRACK_REGISTRY, sem barra final; faltando algo, recusa', () => {
    const options = parseOptions(['--module', 'm', '--out', 'o'], { DEVTRACK_REGISTRY: 'https://r.example/npm/' });
    assert.equal(options.registry, 'https://r.example/npm');
    assert.equal(options.apiCliVersion, 'latest');
    assert.equal(parseOptions(['--module', 'm', '--out', 'o', '--registry', 'http://x', '--api-cli-version', '0.1.0'], {}).apiCliVersion, '0.1.0');
    assert.throws(() => parseOptions(['--module', 'm', '--out', 'o'], {}), QualifyError);
    assert.throws(() => parseOptions(['--module', 'm', '--registry', 'http://x'], {}), QualifyError);
  });

  it('manifesto: exige peer da Foundation e export "./descriptor"', () => {
    assert.deepEqual(readModuleManifest(moduleDir(VALID)), {
      name: '@devtrack-solution/sample', version: '1.2.3', peerRange: '^0.1.0', descriptorFile: 'dist/sample.descriptor.json',
    });
    assert.throws(() => readModuleManifest(moduleDir({ ...VALID, peerDependencies: {} })), /não declara @devtrack-solution\/foundation-api/);
    assert.throws(() => readModuleManifest(moduleDir({ ...VALID, exports: { '.': './dist/index.js' } })), /"\.\/descriptor"/);
  });

  it('versão publicada: a maior estável da saída do npm view; vazio ou só pré-release é nenhuma', () => {
    assert.equal(highestVersion('"0.1.0"'), '0.1.0');
    assert.equal(highestVersion('["0.1.0","0.1.10","0.1.2"]'), '0.1.10');
    assert.equal(highestVersion('["0.2.0-rc.1"]'), null);
    assert.equal(highestVersion(''), null);
  });

  it('ambiente do filho: a chave sobrescrita vence a variante de outra caixa exportada pelo npm run', () => {
    const env = childEnv({ npm_config_userconfig: '/home/u/.npmrc', PATH: '/bin' }, { NPM_CONFIG_USERCONFIG: '/tmp/npmrc' });
    assert.deepEqual(env, { PATH: '/bin', NPM_CONFIG_USERCONFIG: '/tmp/npmrc' });
  });

  it('peer sem versão publicada bloqueia antes de qualquer contêiner', async () => {
    const dir = moduleDir(VALID);
    // Registry sem a Foundation (404 em tudo): a qualificação recusa sem subir o Verdaccio. O
    // servidor roda em outro processo, porque o script chama o npm de forma síncrona.
    const server = spawn(process.execPath, ['-e', `
      const s = require('node:http').createServer((_q, r) => { r.writeHead(404, { 'content-type': 'application/json' }); r.end('{"error":"not_found"}'); });
      s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));`]);
    try {
      const port = await new Promise<string>((resolve, reject) => {
        server.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
        server.once('exit', (code) => reject(new Error(`servidor 404 saiu com ${code}`)));
      });
      await assert.rejects(
        qualifyPublished(parseOptions(['--module', dir, '--out', path.join(dir, 'out'), '--registry', `http://127.0.0.1:${port}`], {})),
        /peer "@devtrack-solution\/foundation-api@\^0\.1\.0" não tem versão publicada/,
      );
    } finally {
      server.kill();
    }
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  });
});
