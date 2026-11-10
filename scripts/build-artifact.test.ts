import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArtifact,
  readPackageLock,
  verifyArtifact,
  type ArtifactInventory,
} from './build-artifact';

/** Testes lentos (instalam pacotes): rodam só por `npm run test:artifact`. */
const SLOW = { timeout: 900_000 };
const HOST_ROOT = path.resolve(__dirname, '..');
const hostLock = readPackageLock(path.join(HOST_ROOT, 'package-lock.json'));

let base: string;

function hostVersion(name: string): string {
  const entry = hostLock.packages[`node_modules/${name}`];
  if (entry === undefined) throw new Error(`${name} missing from host lock`);
  return entry.version;
}

function writeProfile(name: string, natives: readonly string[]): string {
  const file = path.join(base, `${name}.yaml`);
  const lines = [
    'foundationApiMajor: 1',
    natives.length === 0 ? 'natives: []' : 'natives:',
    ...natives.map((id) => `  - id: ${id}`),
    'extensions: []',
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function build(
  profile: string,
  label: string,
): {
  inventory: ArtifactInventory;
  out: string;
  work: string;
} {
  const out = path.join(base, label, 'out');
  const work = path.join(base, label, 'work');
  const inventory = buildArtifact({
    profilePath: profile,
    outDir: out,
    workDir: work,
  });
  return { inventory, out, work };
}

function packageNames(inventory: ArtifactInventory): Set<string> {
  return new Set(inventory.packages.map((pkg) => pkg.name));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string')
        return reject(new Error('no port'));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForBody(url: string, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`artifact exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      return await response.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`artifact did not answer: ${String(lastError)}`);
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-artifact-test-'));
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

void describe('artifact: perfil mínimo', () => {
  void it(
    'omits native and tooling packages and native directories',
    SLOW,
    () => {
      const { inventory, out, work } = build(
        writeProfile('minimal', []),
        'minimal',
      );
      const names = packageNames(inventory);
      for (const name of [
        'jose',
        '@nestjs/swagger',
        'yaml',
        'typescript',
        'prettier',
        'ts-node',
      ])
        assert.equal(names.has(name), false, `${name} must be absent`);
      assert.equal(
        [...names].some((name) => name.startsWith('@opentelemetry/')),
        false,
      );
      assert.deepEqual(inventory.modules.selected, []);
      assert.deepEqual(inventory.modules.disabledAtRuntime, []);
      assert.equal(fs.existsSync(path.join(work, 'dist', 'native')), false);
      assert.equal(fs.existsSync(path.join(out, 'dist', 'native')), false);
      assert.equal(
        fs.existsSync(path.join(work, 'node_modules', 'jose')),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(work, 'node_modules', '@nestjs', 'swagger')),
        false,
      );
      verifyArtifact(work);
      verifyArtifact(out);
    },
  );

  void it('starts with node dist/main.js and answers GET /', SLOW, async () => {
    const { work } = build(writeProfile('minimal-boot', []), 'minimal-boot');
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: work,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      const body = await waitForBody(`http://127.0.0.1:${port}/`, child);
      assert.equal(body, 'Hello World!');
    } finally {
      child.kill('SIGTERM');
    }
  });
});

void describe('artifact: nativos selecionados', () => {
  void it(
    'ships swagger, OTel and JWT packages at the exact host lock versions',
    SLOW,
    () => {
      const { inventory, out } = build(
        writeProfile('full', [
          'native/http-security',
          'native/jwt-auth',
          'native/opentelemetry',
          'native/swagger-adapter',
        ]),
        'full',
      );
      const byName = new Map(
        inventory.packages
          .filter((pkg) => pkg.directOf.length > 0)
          .map((pkg) => [pkg.name, pkg]),
      );
      for (const name of [
        'jose',
        '@nestjs/swagger',
        '@opentelemetry/sdk-node',
        '@opentelemetry/api',
      ]) {
        const pkg = byName.get(name);
        assert.ok(pkg, `${name} must be a direct artifact package`);
        assert.equal(
          pkg.version,
          hostVersion(name),
          `${name} must match the host lock`,
        );
      }
      assert.deepEqual(
        inventory.modules.selected.map((module) => module.id),
        [
          'native/http-security',
          'native/jwt-auth',
          'native/opentelemetry',
          'native/swagger-adapter',
        ],
      );
      assert.deepEqual(inventory.modules.excludedFromBuild, [
        'native/aws-s3',
        'native/cache-redis',
        'native/persistence-typeorm',
        'native/queue-bullmq',
      ]);
      for (const id of ['jwt-auth', 'swagger-adapter', 'opentelemetry'])
        assert.ok(
          fs.existsSync(path.join(out, 'dist', 'native', id)),
          `dist/native/${id} missing`,
        );
      verifyArtifact(out);
    },
  );

  void it('with swagger only, leaves OpenTelemetry and jose out', SLOW, () => {
    const { inventory, out, work } = build(
      writeProfile('swagger', ['native/swagger-adapter']),
      'swagger',
    );
    const names = packageNames(inventory);
    assert.equal(names.has('@nestjs/swagger'), true);
    assert.equal(names.has('jose'), false);
    assert.equal(
      [...names].some((name) => name.startsWith('@opentelemetry/')),
      false,
    );
    assert.equal(names.has('yaml'), false);
    assert.equal(fs.existsSync(path.join(work, 'node_modules', 'jose')), false);
    assert.equal(
      fs.existsSync(path.join(out, 'dist', 'native', 'opentelemetry')),
      false,
    );
    verifyArtifact(out);
  });

  void it(
    'is deterministic: two builds of the same profile yield the same inventory',
    SLOW,
    () => {
      const profile = writeProfile('deterministic', ['native/swagger-adapter']);
      const first = build(profile, 'det-a').inventory;
      const second = build(profile, 'det-b').inventory;
      assert.deepEqual(second, first);
    },
  );
});

void describe('artifact: verificação', () => {
  void it(
    'rejects a dist that references a package excluded from the build',
    SLOW,
    () => {
      const { out } = build(writeProfile('tamper-source', []), 'tamper');
      const tampered = path.join(base, 'tampered');
      fs.cpSync(out, tampered, { recursive: true });
      fs.writeFileSync(
        path.join(tampered, 'dist', 'leak.js'),
        "require('jose');\n",
        'utf8',
      );
      assert.throws(
        () => verifyArtifact(tampered),
        /jose \(excluded-from-build/,
      );
    },
  );
});

/** Verdadeiro se algum arquivo de dist/ (.js ou .d.ts) casa com o padrão. */
function distMentions(root: string, pattern: RegExp): boolean {
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          return entry.isDirectory() ? walk(full) : [full];
        })
      : [];
  return walk(path.join(root, 'dist'))
    .filter((file) => /\.(?:c|m)?js$|\.d\.ts$/.test(file))
    .some((file) => pattern.test(fs.readFileSync(file, 'utf8')));
}

void describe('artifact: S3 e isolamento de SDK', () => {
  void it(
    'ships the S3 SDK at the host lock version when aws-s3 is selected',
    SLOW,
    () => {
      const { inventory, out } = build(
        writeProfile('s3', ['native/aws-s3']),
        's3',
      );
      const pkg = inventory.packages.find(
        (item) =>
          item.name === '@aws-sdk/client-s3' && item.directOf.length > 0,
      );
      assert.ok(pkg, '@aws-sdk/client-s3 must be a direct artifact package');
      assert.equal(pkg.version, hostVersion('@aws-sdk/client-s3'));
      assert.ok(
        fs.existsSync(path.join(out, 'dist', 'native', 'aws-s3')),
        'dist/native/aws-s3 must exist',
      );
      verifyArtifact(out);
    },
  );

  void it(
    'leaves every @aws-sdk package out when S3 is not selected',
    SLOW,
    () => {
      const { inventory, out, work } = build(
        writeProfile('swagger-no-s3', ['native/swagger-adapter']),
        'swagger-no-s3',
      );
      assert.equal(
        [...packageNames(inventory)].some((name) =>
          name.startsWith('@aws-sdk/'),
        ),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(work, 'node_modules', '@aws-sdk')),
        false,
      );
      assert.equal(distMentions(out, /@aws-sdk\//), false);
      assert.equal(
        fs.existsSync(path.join(out, 'dist', 'native', 'aws-s3')),
        false,
      );
      verifyArtifact(out);
    },
  );

  void it(
    'rejects a dist that references @aws-sdk/client-s3 without the aws-s3 native',
    SLOW,
    () => {
      const { out } = build(
        writeProfile('no-s3-tamper', ['native/swagger-adapter']),
        'no-s3-tamper',
      );
      const tampered = path.join(base, 'tampered-s3');
      fs.cpSync(out, tampered, { recursive: true });
      fs.writeFileSync(
        path.join(tampered, 'dist', 'leak-s3.js'),
        "require('@aws-sdk/client-s3');\n",
        'utf8',
      );
      assert.throws(
        () => verifyArtifact(tampered),
        /@aws-sdk\/client-s3 \(excluded-from-build/,
      );
    },
  );
});

void describe('artifact: entrypoint do worker', () => {
  void it(
    'ships dist/worker.js and bullmq when the queue native is selected',
    SLOW,
    () => {
      const { inventory, out, work } = build(
        writeProfile('queue', [
          'native/persistence-typeorm',
          'native/queue-bullmq',
        ]),
        'queue',
      );
      assert.deepEqual(inventory.entrypoints, ['main', 'worker']);
      assert.ok(
        fs.existsSync(path.join(work, 'src', 'worker.ts')),
        'src/worker.ts must be copied',
      );
      assert.ok(
        fs.existsSync(path.join(out, 'dist', 'worker.js')),
        'dist/worker.js must exist',
      );
      const bullmq = inventory.packages.find(
        (pkg) => pkg.name === 'bullmq' && pkg.directOf.length > 0,
      );
      assert.ok(bullmq, 'bullmq must be a direct artifact package');
      assert.equal(bullmq.version, hostVersion('bullmq'));
      verifyArtifact(out);
      // Só checa que o módulo compilado resolve as dependências: `require.main`
      // não é o worker aqui, então ele não inicia (sem Redis/PostgreSQL).
      const probe = spawnSync(
        process.execPath,
        [
          '-e',
          "require.resolve('bullmq'); require('./dist/worker.js'); console.log('ok')",
        ],
        { cwd: work, encoding: 'utf8', timeout: 120_000 },
      );
      assert.equal(probe.status, 0, `${probe.stderr}`);
      assert.equal(probe.stdout.trim(), 'ok');
    },
  );

  void it(
    'leaves worker entrypoint and bullmq out without the queue native',
    SLOW,
    () => {
      const { inventory, out, work } = build(
        writeProfile('no-queue', ['native/persistence-typeorm']),
        'no-queue',
      );
      assert.deepEqual(inventory.entrypoints, ['main']);
      assert.equal(packageNames(inventory).has('bullmq'), false);
      assert.equal(fs.existsSync(path.join(work, 'src', 'worker.ts')), false);
      assert.equal(fs.existsSync(path.join(out, 'dist', 'worker.js')), false);
      assert.equal(
        fs.existsSync(path.join(work, 'node_modules', 'bullmq')),
        false,
      );
      verifyArtifact(out);
    },
  );

  void it(
    'rejects a dist/worker.js injected into an artifact without the queue native',
    SLOW,
    () => {
      const { out } = build(
        writeProfile('no-queue-tamper', ['native/persistence-typeorm']),
        'no-queue-tamper',
      );
      const tampered = path.join(base, 'tampered-worker');
      fs.cpSync(out, tampered, { recursive: true });
      fs.writeFileSync(
        path.join(tampered, 'dist', 'worker.js'),
        "require('./main');\n",
        'utf8',
      );
      assert.throws(
        () => verifyArtifact(tampered),
        /dist\/worker\.js exists but worker is not listed in entrypoints/,
      );
    },
  );
});
