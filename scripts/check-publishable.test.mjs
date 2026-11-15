import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPublishViolations, findUnpublishedPeers } from './check-publishable.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-publishable.mjs');
const VALID = {
  name: '@devtrack-solution/jwt-auth',
  version: '0.1.0',
  peerDependencies: { '@devtrack-solution/foundation-api': '^0.1.0' },
  dependencies: { jose: '5.10.0' },
};

function runOn(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-check-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('aceita pacote com escopo, semver exata e dependências portáveis', () => {
  assert.deepEqual(findPublishViolations(VALID), []);
  const result = runOn(VALID);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /@devtrack-solution\/jwt-auth@0\.1\.0 publicável/);
});

test('recusa nome sem escopo e identifica o nome divergente', () => {
  const result = runOn({ ...VALID, name: 'foundation-api' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nome "foundation-api" fora do escopo @devtrack-solution/);
});

test('recusa dependência file:, link e caminho relativo antes de empacotar', () => {
  for (const spec of ['file:../foundation-api', 'link:../x', '../foundation-api', 'git+https://h/r.git']) {
    const violations = findPublishViolations({ ...VALID, dependencies: { other: spec } });
    assert.equal(violations.length, 1, spec);
    assert.match(violations[0], /não portável/);
  }
  assert.equal(runOn({ ...VALID, peerDependencies: { '@devtrack-solution/foundation-api': 'file:../foundation-api' } }).status, 1);
});

test('recusa pacote private e versão não exata', () => {
  assert.match(findPublishViolations({ ...VALID, private: true }).join('\n'), /private/);
  assert.match(findPublishViolations({ ...VALID, version: '^0.1.0' }).join('\n'), /semver exata/);
});

test('roda quando invocado por symlink (node_modules e shim de .bin) e reprova de verdade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-check-link-'));
  try {
    const link = join(dir, 'check-publishable.mjs');
    symlinkSync(SCRIPT, link);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...VALID, name: 'sem-escopo' }));
    const result = spawnSync(process.execPath, [link, dir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fora do escopo @devtrack-solution/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o package.json da própria Foundation é publicável', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const output = execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.match(output, /@devtrack-solution\/foundation-api@\d+\.\d+\.\d+ publicável/);
});

/** npm falso: responde `npm view` com as versões publicadas informadas, como o registry faria. */
function fakeNpm(published) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  const script = join(dir, 'npm');
  writeFileSync(script, `#!${process.execPath}
const published = ${JSON.stringify(published)};
const spec = process.argv[3];
const name = spec.slice(0, spec.lastIndexOf('@'));
const versions = published[name] ?? [];
if (versions.length === 0) { process.stderr.write('E404'); process.exit(1); }
process.stdout.write(JSON.stringify(versions));
`, { mode: 0o755 });
  return { dir, npm: script };
}

test('publicação ordenada: peer @devtrack-solution sem versão publicada é recusado; com versão publicada passa', () => {
  const empty = fakeNpm({});
  assert.deepEqual(findUnpublishedPeers(VALID, { npm: empty.npm }), [
    'peer "@devtrack-solution/foundation-api@^0.1.0" não tem versão publicada no registry',
  ]);
  const published = fakeNpm({ '@devtrack-solution/foundation-api': ['0.1.0'] });
  assert.deepEqual(findUnpublishedPeers(VALID, { npm: published.npm, registry: 'http://registry.test' }), []);
  for (const fake of [empty, published]) rmSync(fake.dir, { recursive: true, force: true });
});

test('publicação ordenada ignora peers fora do escopo @devtrack-solution', () => {
  const empty = fakeNpm({});
  assert.deepEqual(findUnpublishedPeers({ ...VALID, peerDependencies: { '@nestjs/common': '^11.0.0' } }, { npm: empty.npm }), []);
  rmSync(empty.dir, { recursive: true, force: true });
});

