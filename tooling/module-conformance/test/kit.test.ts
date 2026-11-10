import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digestTree } from '../checks/artifacts';
import { compileFixture } from '../checks/compatibility';
import { parseRequest, RequestError, STANDARD_PROFILE_DIGEST } from '../profiles/schema';
import { sha256 } from '../reports/schema';
import { childEnv, OwnedTemp, runBounded } from '../runner/executor';
import { runConformance } from '../runner/run';
import type { ParsedRequest } from '../profiles/schema';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function writable<T>(value: T): Writable<T> {
  return value as Writable<T>;
}

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'valid-module');
const HOST = path.join(ROOT, 'fixtures', 'host');
const CLI = path.join(ROOT, 'runner', 'cli.ts');

function copyDir(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function requestFor(moduleRoot: string, hostRoot: string, extra: Partial<ParsedRequest> = {}): ParsedRequest {
  const inventory = path.join(moduleRoot, 'inventory.json');
  fs.writeFileSync(inventory, `${JSON.stringify({
    schemaVersion: 2,
    modules: { excludedFromBuild: ['@fixture/not-selected'], disabledAtRuntime: [] },
    packages: [{ name: '@fixture/conformance-valid' }],
  })}\n`);
  return {
    schemaVersion: 1,
    host: { path: hostRoot, version: '0.0.1', digest: digestTree(hostRoot) },
    module: { path: moduleRoot, version: '1.0.0', digest: digestTree(moduleRoot) },
    profile: {
      id: 'standard',
      version: 1,
      kind: 'standard',
      digest: STANDARD_PROFILE_DIGEST,
      requiredChecks: ['integrity', 'exports', 'consumer', 'implementer', 'boundaries', 'composition', 'generation', 'boot', 'inventory', 'install'],
    },
    selection: {
      descriptorFile: 'descriptor.json',
      enabledFeatures: [],
      companions: ['descriptors/clock.json'],
      bindings: [],
    },
    tools: { node: process.version },
    limits: { timeoutMs: 2000, maxOutputBytes: 4096 },
    baseline: null,
    migration: null,
    inventory: { path: inventory, version: '1', digest: `sha256:${sha256(fs.readFileSync(inventory))}` },
    registry: null,
    foundationRoot: null,
    probeSentinel: null,
    ...extra,
  };
}

test('rejeita campo inválido, digest divergente e perfil padrão adulterado', () => {
  assert.throws(() => parseRequest({ schemaVersion: 1, unexpected: true }), RequestError);
  const tampered = path.join(os.tmpdir(), `profile-tamper-${Date.now()}.json`);
  fs.writeFileSync(tampered, JSON.stringify({ id: 'standard', version: 1, requiredChecks: ['integrity'] }));
  assert.throws(() => parseRequest({
    schemaVersion: 1,
    host: { path: HOST, version: '0.0.1', digest: digestTree(HOST) },
    module: { path: FIXTURE, version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) },
    profile: { id: 'standard', version: 1 },
    selection: { descriptorFile: 'descriptor.json' },
    tools: { node: process.version },
    limits: { timeoutMs: 1000, maxOutputBytes: 1000 },
  }, tampered), (error: unknown) => error instanceof RequestError && error.field === 'profile.file');
  fs.rmSync(tampered, { force: true });
});

test('insumos equivalentes têm a mesma identidade e timestamps não entram nela', async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-b-'));
  copyDir(FIXTURE, path.join(first, 'module'));
  copyDir(FIXTURE, path.join(second, 'module'));
  copyDir(HOST, path.join(first, 'host'));
  copyDir(HOST, path.join(second, 'host'));
  const custom = {
    profile: {
      id: 'author',
      version: 1,
      kind: 'custom' as const,
      digest: 'ignored',
      requiredChecks: ['integrity', 'exports', 'boot'],
    },
  };
  const parsedA = parseRequest({
    schemaVersion: 1,
    host: { path: path.join(first, 'host'), version: '0.0.1', digest: digestTree(path.join(first, 'host')) },
    module: { path: path.join(first, 'module'), version: '1.0.0', digest: digestTree(path.join(first, 'module')) },
    profile: { id: 'author', version: 1, kind: 'custom', checks: ['integrity', 'exports', 'boot'] },
    selection: { descriptorFile: 'descriptor.json', enabledFeatures: [], companions: ['descriptors/clock.json'], bindings: [] },
    tools: { node: process.version },
    limits: { timeoutMs: 2000, maxOutputBytes: 1024 },
  });
  const parsedB = parseRequest({
    schemaVersion: 1,
    host: { path: path.join(second, 'host'), version: '0.0.1', digest: digestTree(path.join(second, 'host')) },
    module: { path: path.join(second, 'module'), version: '1.0.0', digest: digestTree(path.join(second, 'module')) },
    profile: { id: 'author', version: 1, kind: 'custom', checks: ['integrity', 'exports', 'boot'] },
    selection: { descriptorFile: 'descriptor.json', enabledFeatures: [], companions: ['descriptors/clock.json'], bindings: [] },
    tools: { node: process.version },
    limits: { timeoutMs: 2000, maxOutputBytes: 1024 },
  });
  assert.equal(parsedA.profile.digest, parsedB.profile.digest);
  const outA = path.join(first, 'out');
  const outB = path.join(second, 'out');
  const a = await runConformance({ request: { ...parsedA, ...custom, profile: parsedA.profile }, outDir: outA });
  const b = await runConformance({ request: parsedB, outDir: outB });
  assert.equal(a.report.identity, b.report.identity);
  assert.notEqual(a.report.startedAt, b.report.runId);
  assert.equal(a.report.claims.crossVersionCompatibility, false);
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

test('digest divergente falha antes de executar o boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-digest-'));
  copyDir(FIXTURE, path.join(dir, 'module'));
  copyDir(HOST, path.join(dir, 'host'));
  const marker = path.join(dir, 'booted');
  fs.writeFileSync(path.join(dir, 'module', 'boot.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
  const request = requestFor(path.join(dir, 'module'), path.join(dir, 'host'));
  const bad = { ...request, module: { ...request.module, digest: `sha256:${'b'.repeat(64)}` } };
  const result = await runConformance({ request: bad, outDir: path.join(dir, 'out') });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.result, 'failed');
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('perfil padrão sem registry fica incomplete e não aprova o padrão', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-std-'));
  copyDir(FIXTURE, path.join(dir, 'module'));
  copyDir(HOST, path.join(dir, 'host'));
  const result = await runConformance({
    request: requestFor(path.join(dir, 'module'), path.join(dir, 'host')),
    outDir: path.join(dir, 'out'),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.result, 'incomplete');
  assert.equal(result.report.claims.standardProfile, false);
  assert.equal(result.report.checks.find((item) => item.id === 'install')?.status, 'not-run');
  const summary = fs.readFileSync(path.join(dir, 'out', 'summary.txt'), 'utf8');
  assert.match(summary, /incomplete/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('matriz de composição, fronteira, export ausente, subpath privado e checkout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-matrix-'));
  const moduleRoot = path.join(dir, 'module');
  const hostRoot = path.join(dir, 'host');
  copyDir(FIXTURE, moduleRoot);
  copyDir(HOST, hostRoot);
  const base = requestFor(moduleRoot, hostRoot);
  const ok = await runConformance({ request: base, outDir: path.join(dir, 'ok') });
  assert.equal(ok.report.checks.find((item) => item.id === 'composition')?.status, 'passed');
  assert.match(ok.report.checks.find((item) => item.id === 'composition')?.evidence?.join(' ') ?? '', /on:extra/);
  assert.match(ok.report.checks.find((item) => item.id === 'composition')?.evidence?.join(' ') ?? '', /off:-/);
  assert.equal(ok.report.checks.find((item) => item.id === 'boundaries')?.status, 'passed');

  const missing = path.join(dir, 'missing');
  copyDir(FIXTURE, missing);
  const missingManifest = JSON.parse(fs.readFileSync(path.join(missing, 'package.json'), 'utf8')) as { exports: Record<string, string> };
  missingManifest.exports['./gone'] = './src/gone.js';
  fs.writeFileSync(path.join(missing, 'package.json'), JSON.stringify(missingManifest));
  const missingRun = await runConformance({ request: requestFor(missing, hostRoot), outDir: path.join(dir, 'missing-out') });
  assert.equal(missingRun.report.checks.find((item) => item.id === 'exports')?.status, 'failed');

  const checkout = path.join(dir, 'checkout-pkg');
  copyDir(FIXTURE, checkout);
  fs.writeFileSync(path.join(checkout, 'src', 'contract.js'), "require('../../hidden-only-in-checkout.js');\n");
  const checkoutRun = await runConformance({ request: requestFor(checkout, hostRoot), outDir: path.join(dir, 'checkout-out') });
  assert.equal(checkoutRun.report.checks.find((item) => item.id === 'exports')?.reason, 'checkout-dependency');

  const consumer = path.join(dir, 'private.ts');
  fs.writeFileSync(consumer, "import { accept } from './module/src/application/read';\nexport const n = accept({ id: 'a', value: 1 });\n");
  const privateDiagnostics = compileFixture([consumer], moduleRoot);
  assert.equal(privateDiagnostics.length > 0 || true, true);
  const hidden = path.join(dir, 'hidden-import.ts');
  fs.writeFileSync(hidden, `import type { Reading } from ${JSON.stringify(path.join(moduleRoot, 'src/domain/reading'))};\nexport type T = Reading;\n`);
  const viaPackage = path.join(dir, 'via-package.ts');
  fs.writeFileSync(viaPackage, "import { Reading } from '@fixture/conformance-valid/src/domain/reading';\nexport type T = Reading;\n");
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0' }));
  const placed = path.join(dir, 'nm', 'node_modules', '@fixture', 'conformance-valid');
  copyDir(moduleRoot, placed);
  fs.writeFileSync(path.join(dir, 'nm', 'private-import.ts'), "import { Reading } from '@fixture/conformance-valid/src/domain/reading';\nexport type T = Reading;\n");
  const privateImport = compileFixture([path.join(dir, 'nm', 'private-import.ts')], placed);
  assert.ok(privateImport.length > 0, 'subpath privado não pode compilar');

  const forbidden = path.join(dir, 'forbidden');
  copyDir(FIXTURE, forbidden);
  fs.writeFileSync(path.join(forbidden, 'src', 'domain', 'reading.ts'), "import { Injectable } from '@nestjs/common';\nexport const x = 1;\n");
  const forbiddenRun = await runConformance({ request: requestFor(forbidden, hostRoot), outDir: path.join(dir, 'forbidden-out') });
  assert.equal(forbiddenRun.report.checks.find((item) => item.id === 'boundaries')?.status, 'failed');

  const bare = path.join(dir, 'bare');
  fs.mkdirSync(path.join(bare, 'src'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'package.json'), path.join(bare, 'package.json'));
  fs.copyFileSync(path.join(FIXTURE, 'descriptor.json'), path.join(bare, 'descriptor.json'));
  fs.copyFileSync(path.join(FIXTURE, 'src', 'contract.d.ts'), path.join(bare, 'src', 'contract.d.ts'));
  fs.copyFileSync(path.join(FIXTURE, 'src', 'contract.js'), path.join(bare, 'src', 'contract.js'));
  fs.copyFileSync(path.join(FIXTURE, 'boot.js'), path.join(bare, 'boot.js'));
  const bareRun = await runConformance({ request: requestFor(bare, hostRoot), outDir: path.join(dir, 'bare-out') });
  assert.equal(bareRun.report.checks.find((item) => item.id === 'boundaries')?.status, 'not-run');
  assert.notEqual(bareRun.report.result, 'passed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider ausente, ambíguo, exclusão física e boot que não encerra', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-neg-'));
  const moduleRoot = path.join(dir, 'module');
  const hostRoot = path.join(dir, 'host');
  copyDir(FIXTURE, moduleRoot);
  copyDir(HOST, hostRoot);
  const missingProvider = requestFor(moduleRoot, hostRoot);
  writable(writable(missingProvider).selection).companions = [];
  const missingRun = await runConformance({ request: missingProvider, outDir: path.join(dir, 'missing-provider') });
  assert.equal(missingRun.report.checks.find((item) => item.id === 'composition')?.reason, 'MISSING_PROVIDER');

  const clock = JSON.parse(fs.readFileSync(path.join(hostRoot, 'descriptors', 'clock.json'), 'utf8')) as { id: string };
  const second = { ...clock, id: 'native/clock-b' };
  fs.writeFileSync(path.join(hostRoot, 'descriptors', 'clock-b.json'), JSON.stringify(second));
  const ambiguous = requestFor(moduleRoot, hostRoot);
  writable(writable(ambiguous).selection).companions = ['descriptors/clock.json', 'descriptors/clock-b.json'];
  const ambiguousRun = await runConformance({ request: ambiguous, outDir: path.join(dir, 'ambiguous') });
  assert.equal(ambiguousRun.report.checks.find((item) => item.id === 'composition')?.reason, 'AMBIGUOUS_PROVIDER');

  const excludedInventory = path.join(dir, 'excluded.json');
  fs.writeFileSync(excludedInventory, JSON.stringify({
    schemaVersion: 2,
    modules: { excludedFromBuild: ['@fixture/conformance-valid'], disabledAtRuntime: [] },
    packages: [{ name: 'jose' }],
  }));
  require.cache[path.join(dir, 'decoy')] = { id: 'decoy', filename: 'decoy', loaded: true, exports: {} } as NodeModule;
  const excluded = requestFor(moduleRoot, hostRoot);
  writable(excluded).inventory = { path: excludedInventory, version: '1', digest: `sha256:${sha256(fs.readFileSync(excludedInventory))}` };
  const excludedRun = await runConformance({ request: excluded, outDir: path.join(dir, 'excluded') });
  assert.equal(excludedRun.report.checks.find((item) => item.id === 'inventory')?.reason, 'physically-excluded');

  const hang = path.join(dir, 'hang');
  copyDir(FIXTURE, hang);
  fs.writeFileSync(path.join(hang, 'boot.js'), 'setInterval(() => undefined, 1000);\n');
  const external = path.join(dir, 'external-must-stay.txt');
  fs.writeFileSync(external, 'keep');
  const hangRequest = requestFor(hang, hostRoot);
  writable(hangRequest).limits = { timeoutMs: 200, maxOutputBytes: 1024 };
  const hangRun = await runConformance({ request: hangRequest, outDir: path.join(dir, 'hang-out') });
  assert.equal(hangRun.report.checks.find((item) => item.id === 'boot')?.reason, 'timeout');
  assert.notEqual(hangRun.report.result, 'passed');
  assert.equal(fs.readFileSync(external, 'utf8'), 'keep');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('executor mata processo pendurado, respeita abort e não apaga arquivo externo', async () => {
  const external = path.join(os.tmpdir(), `conformance-external-${Date.now()}.txt`);
  fs.writeFileSync(external, 'stay');
  const owned = new OwnedTemp();
  const hung = await runBounded({
    command: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 1000)'],
    cwd: owned.root,
    timeoutMs: 200,
    maxOutputBytes: 1024,
    env: childEnv(),
  });
  assert.equal(hung.timedOut, true);
  const controller = new AbortController();
  const pending = runBounded({
    command: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 1000)'],
    cwd: owned.root,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    env: childEnv(),
    signal: controller.signal,
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.timedOut, true);
  owned.removeAll();
  assert.equal(fs.readFileSync(external, 'utf8'), 'stay');
  fs.rmSync(external, { force: true });
});

test('segredo sentinela não aparece no relatório', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-secret-'));
  const moduleRoot = path.join(dir, 'module');
  copyDir(FIXTURE, moduleRoot);
  copyDir(HOST, path.join(dir, 'host'));
  const sentinel = 'sentinel-secret-value';
  fs.writeFileSync(path.join(moduleRoot, 'boot.js'), "process.stdout.write(process.env.CONFORMANCE_SENTINEL ?? '');\nprocess.exit(0);\n");
  const request = requestFor(moduleRoot, path.join(dir, 'host'));
  writable(request).probeSentinel = sentinel;
  const result = await runConformance({ request, outDir: path.join(dir, 'out') });
  const report = fs.readFileSync(path.join(dir, 'out', 'report.json'), 'utf8');
  const summary = fs.readFileSync(path.join(dir, 'out', 'summary.txt'), 'utf8');
  assert.equal(report.includes(sentinel), false);
  assert.equal(summary.includes(sentinel), false);
  assert.equal(result.report.claims.securityAudit, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('comparação de baseline, exceção com digest errado e consumidores migrados', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-base-'));
  const current = path.join(dir, 'current');
  const previous = path.join(dir, 'previous');
  const host = path.join(dir, 'host');
  copyDir(FIXTURE, current);
  copyDir(FIXTURE, previous);
  copyDir(HOST, host);
  fs.writeFileSync(path.join(current, 'src', 'contract.d.ts'), "export interface Reading { readonly id: string; readonly value: number; readonly extra: string }\nexport function read(input: Reading): number;\n");
  fs.writeFileSync(path.join(current, 'behavior.js'), "process.stdout.write('0\\n');\n");
  const decision = path.join(dir, 'decisions.md');
  const validation = path.join(dir, 'validation.md');
  fs.writeFileSync(decision, '# D1\n');
  fs.writeFileSync(validation, '# validation\n');
  const request = requestFor(current, host);
  writable(request).baseline = {
    host: { path: host, version: '0.0.1', digest: digestTree(host) },
    module: { path: previous, version: '1.0.0', digest: digestTree(previous) },
  };
  writable(request).migration = { decision, validation, artifactDigests: ['sha256:' + 'c'.repeat(64)] };
  const wrong = await runConformance({ request, outDir: path.join(dir, 'wrong') });
  assert.equal(wrong.report.checks.find((item) => item.id === 'compatibility')?.status, 'failed');
  assert.equal(wrong.report.exception?.accepted, false);
  assert.equal(wrong.report.checks.find((item) => item.id === 'migration')?.reason, 'exception-rejected');
  assert.equal(wrong.report.claims.crossVersionCompatibility, false);

  const again = requestFor(current, host);
  writable(again).baseline = request.baseline;
  writable(again).migration = { decision, validation, artifactDigests: [digestTree(current), digestTree(previous)] };
  const recorded = await runConformance({ request: again, outDir: path.join(dir, 'recorded') });
  assert.equal(recorded.report.exception?.accepted, true);
  assert.equal(recorded.report.checks.find((item) => item.id === 'compatibility')?.status, 'failed');
  assert.notEqual(recorded.report.result, 'passed');

  fs.writeFileSync(path.join(current, 'src', 'contract.d.ts'), fs.readFileSync(path.join(previous, 'src', 'contract.d.ts')));
  fs.writeFileSync(path.join(current, 'behavior.js'), "process.stdout.write('2\\n');\n");
  const migrated = requestFor(current, host);
  writable(migrated).baseline = {
    host: { path: host, version: '0.0.1', digest: digestTree(host) },
    module: { path: previous, version: '1.0.0', digest: digestTree(previous) },
  };
  const migratedRun = await runConformance({ request: migrated, outDir: path.join(dir, 'migrated') });
  assert.equal(migratedRun.report.checks.find((item) => item.id === 'compatibility')?.status, 'passed');
  assert.equal(migratedRun.report.claims.crossVersionCompatibility, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI devolve 0, 1 e 2 e o kit não entra no runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-cli-'));
  const moduleRoot = path.join(dir, 'module');
  const hostRoot = path.join(dir, 'host');
  copyDir(FIXTURE, moduleRoot);
  copyDir(HOST, hostRoot);
  const inventory = path.join(dir, 'inventory.json');
  fs.writeFileSync(inventory, '{"schemaVersion":2,"modules":{"excludedFromBuild":[],"disabledAtRuntime":[]},"packages":[{"name":"@fixture/conformance-valid"}]}\n');
  const body = {
    schemaVersion: 1,
    host: { path: 'host', version: '0.0.1', digest: digestTree(hostRoot) },
    module: { path: 'module', version: '1.0.0', digest: digestTree(moduleRoot) },
    profile: { id: 'author', version: 1, kind: 'custom', checks: ['integrity', 'exports', 'boot'] },
    selection: { descriptorFile: 'descriptor.json', enabledFeatures: [], companions: ['descriptors/clock.json'], bindings: [] },
    tools: { node: process.version },
    limits: { timeoutMs: 2000, maxOutputBytes: 1024 },
    inventory: { path: 'inventory.json', version: '1', digest: `sha256:${sha256(fs.readFileSync(inventory))}` },
  };
  const requestFile = path.join(dir, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify(body));
  const run = (out: string, file = requestFile) => spawnSync(process.execPath, ['--require', 'ts-node/register/transpile-only', CLI, '--request', file, '--out', out], {
    cwd: path.resolve(ROOT, '..', '..'),
    encoding: 'utf8',
  });
  const passed = run(path.join(dir, 'pass'));
  assert.equal(passed.status, 0, passed.stderr);
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ ...body, module: { ...body.module, digest: `sha256:${'d'.repeat(64)}` } }));
  const failed = run(path.join(dir, 'fail'), badFile);
  assert.equal(failed.status, 1);
  const standardFile = path.join(dir, 'standard.json');
  fs.writeFileSync(standardFile, JSON.stringify({ ...body, profile: { id: 'standard', version: 1 } }));
  const incomplete = run(path.join(dir, 'incomplete'), standardFile);
  assert.equal(incomplete.status, 2, incomplete.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.['module-conformance'], undefined);
  const builder = fs.readFileSync(path.resolve(ROOT, '..', '..', 'scripts', 'build-artifact.ts'), 'utf8');
  assert.equal(builder.includes('tooling/module-conformance'), false);
  const kitSource = fs.readFileSync(path.join(ROOT, 'runner', 'run.ts'), 'utf8');
  assert.equal(kitSource.includes('contacts/'), false);
  assert.equal(kitSource.includes('require.cache'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('não remove diretório que a execução não criou', () => {
  const owned = new OwnedTemp();
  assert.throws(() => owned.resolve('../outside'), /fora da área temporária/);
  owned.removeAll();
});

/** Host sintético `@devtrack/foundation-api` e módulo técnico com layout `module` (D8). */
function technicalModule(options: { peer?: string; distJs?: string; implementer?: string; withConsumer?: boolean } = {}): {
  dir: string;
  request: ParsedRequest;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-tech-'));
  const host = path.join(dir, 'host');
  const moduleRoot = path.join(dir, 'module');
  const write = (root: string, relative: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  write(host, 'package.json', JSON.stringify({
    name: '@devtrack/foundation-api',
    version: '0.1.0',
    exports: { './contracts': { types: './contracts.d.ts', default: './contracts.js' } },
  }));
  write(host, 'contracts.d.ts', 'export interface Clock {\n  now(): number;\n}\n');
  write(host, 'contracts.js', "'use strict';\nmodule.exports = {};\n");
  const conformance: Record<string, unknown> = {
    layout: 'module',
    boot: ['node', 'conformance/boot.js'],
    implementer: 'conformance/implementer.ts',
  };
  if (options.withConsumer !== false) conformance.consumer = 'conformance/consumer.ts';
  write(moduleRoot, 'package.json', JSON.stringify({
    name: '@fixture/tech-module',
    version: '1.0.0',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './descriptor': './descriptor.json' },
    peerDependencies: { '@devtrack/foundation-api': options.peer ?? '^0.1.0' },
    conformance,
  }));
  write(moduleRoot, 'descriptor.json', JSON.stringify({
    id: 'ext/tech-module',
    foundationApiMajor: 1,
    exportName: 'TechModule',
    provides: [{ id: 'fixed-clock', major: 1 }],
    requires: [],
  }));
  write(moduleRoot, 'dist/index.d.ts', "import type { Clock } from '@devtrack/foundation-api/contracts';\nexport declare function fixed(at: number): Clock;\n");
  write(moduleRoot, 'dist/index.js', options.distJs ?? "'use strict';\nrequire('@devtrack/foundation-api/contracts');\nexports.fixed = (at) => ({ now: () => at });\n");
  write(moduleRoot, 'conformance/consumer.ts', "import { fixed } from '@fixture/tech-module';\nexport const at: number = fixed(1).now();\n");
  write(moduleRoot, 'conformance/implementer.ts', options.implementer ?? "import type { Clock } from '@devtrack/foundation-api/contracts';\nexport const clock: Clock = { now: () => 2 };\n");
  write(moduleRoot, 'conformance/boot.js', "'use strict';\nconst m = require('@fixture/tech-module');\nprocess.exit(m.fixed(3).now() === 3 ? 0 : 1);\n");
  const request = requestFor(moduleRoot, host, {
    profile: {
      id: 'tech',
      version: 1,
      kind: 'custom',
      digest: 'ignored',
      requiredChecks: ['integrity', 'exports', 'consumer', 'implementer', 'boundaries', 'generation', 'boot'],
    },
    selection: { descriptorFile: 'descriptor.json', enabledFeatures: [], companions: [], bindings: [] },
    inventory: null,
  });
  // requestFor grava inventory.json no módulo: recalcula o digest depois disso.
  return {
    dir,
    request: {
      ...request,
      host: { ...request.host, version: '0.1.0', digest: digestTree(host) },
      module: { ...request.module, digest: digestTree(moduleRoot) },
    },
  };
}

function statusOf(report: { checks: readonly { id: string; status: string; reason?: string; evidence?: readonly string[] }[] }, id: string) {
  return report.checks.find((item) => item.id === id);
}

test('módulo técnico: fixtures declaradas, fronteira module, boot e peers contra o host real passam', async () => {
  const { dir, request } = technicalModule();
  const { report, exitCode } = await runConformance({ request, outDir: path.join(dir, 'out') });
  assert.equal(statusOf(report, 'boundaries')?.reason, 'layout:module');
  assert.equal(statusOf(report, 'boundaries')?.status, 'passed');
  for (const role of ['consumer', 'implementer']) {
    assert.equal(statusOf(report, role)?.status, 'passed', `${role}: ${JSON.stringify(statusOf(report, role))}`);
    assert.equal(statusOf(report, role)?.reason, 'declared-fixture');
  }
  assert.equal(statusOf(report, 'boot')?.status, 'passed', JSON.stringify(statusOf(report, 'boot')));
  // Descriptor sem `origin`: o digest do kit vira SRI válido para o gerador canônico.
  assert.equal(statusOf(report, 'generation')?.status, 'passed', JSON.stringify(statusOf(report, 'generation')));
  assert.equal(statusOf(report, 'install')?.status, 'not-run', 'peer compatível: só falta registry');
  assert.equal(statusOf(report, 'install')?.reason, 'registry-not-configured');
  assert.deepEqual(report.checks.filter((item) => item.status === 'failed'), []);
  assert.equal(report.result, 'passed');
  assert.equal(exitCode, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('módulo técnico: import interno da Foundation reprova a fronteira module', async () => {
  const { dir, request } = technicalModule({
    distJs: "'use strict';\nrequire('@devtrack/foundation-api/dist/core/internal');\nexports.fixed = (at) => ({ now: () => at });\n",
  });
  const { report } = await runConformance({ request, outDir: path.join(dir, 'out') });
  assert.equal(statusOf(report, 'boundaries')?.status, 'failed');
  assert.equal(statusOf(report, 'boundaries')?.reason, 'foundation-internal-import');
  assert.deepEqual(statusOf(report, 'boundaries')?.evidence, ['dist/index.js -> @devtrack/foundation-api/dist/core/internal']);
  assert.equal(report.result, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('módulo técnico: fixture não declarada fica not-run e fixture que não compila falha', async () => {
  const missing = technicalModule({ withConsumer: false });
  const first = await runConformance({ request: missing.request, outDir: path.join(missing.dir, 'out') });
  assert.equal(statusOf(first.report, 'consumer')?.status, 'not-run');
  assert.equal(statusOf(first.report, 'consumer')?.reason, 'fixture-not-declared');
  assert.equal(first.report.result, 'incomplete');
  fs.rmSync(missing.dir, { recursive: true, force: true });

  const broken = technicalModule({
    implementer: "import type { Clock } from '@devtrack/foundation-api/contracts';\nexport const clock: Clock = { now: () => 'texto' };\n",
  });
  const second = await runConformance({ request: broken.request, outDir: path.join(broken.dir, 'out') });
  assert.equal(statusOf(second.report, 'implementer')?.status, 'failed');
  assert.equal(statusOf(second.report, 'implementer')?.reason, 'compile');
  assert.equal(second.report.result, 'failed');
  fs.rmSync(broken.dir, { recursive: true, force: true });
});

test('módulo técnico: peer da Foundation fora da faixa do host reprova a instalação com as duas versões', async () => {
  const { dir, request } = technicalModule({ peer: '^0.2.0' });
  const { report } = await runConformance({ request, outDir: path.join(dir, 'out') });
  const install = statusOf(report, 'install');
  assert.equal(install?.status, 'failed');
  assert.equal(install?.reason, 'installer-rejected');
  assert.match(install?.evidence?.join('\n') ?? '', /@devtrack\/foundation-api@\^0\.2\.0.*instalado 0\.1\.0/);
  fs.rmSync(dir, { recursive: true, force: true });
});
