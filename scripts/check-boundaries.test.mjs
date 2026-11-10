import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkBoundaries } from './check-boundaries.mjs';

function fixture(t, files, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'commonjs',
        moduleResolution: 'node',
        baseUrl: '.',
        ...options,
      },
      include: ['src/**/*.ts'],
    }),
  );
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

test('accepts inward dependencies, public contracts and technical adapters', (t) => {
  const root = fixture(t, {
    'src/core/domain/identity.ts': 'export interface Identity { id: string }',
    'src/core/application/login.ts':
      "import type { Identity } from '../domain/identity'; export type Login = Identity;",
    'src/contracts/index.ts':
      "export type { Login } from '../core/application/login';",
    'src/native/jwt-auth/adapter.ts':
      "import { Injectable } from '@nestjs/common'; import type { Login } from '../../contracts';",
  });
  assert.deepEqual(checkBoundaries(root), []);
});

for (const statement of [
  "import { Injectable } from '@nestjs/common';",
  "import type { EntityManager } from 'typeorm';",
  "export type { EntityManager } from 'typeorm';",
  "type Client = import('@aws-sdk/client-s3').S3Client;",
  "import crypto = require('node:crypto');",
  "const orm = require('typeorm');",
  "const orm = import('typeorm');",
  "const orm = require.resolve('typeorm');",
  "const orm = module.require('typeorm');",
]) {
  test(`rejects technical dependency: ${statement}`, (t) => {
    const root = fixture(t, { 'src/core/application/use-case.ts': statement });
    assert.equal(checkBoundaries(root)[0]?.rule, 'external-dependency');
  });
}

test('rejects outward Domain dependencies and contracts importing adapters', (t) => {
  const root = fixture(t, {
    'src/core/domain/identity.ts':
      "export { Login } from '../application/login';",
    'src/core/application/login.ts': 'export class Login {}',
    'src/native/jwt-auth/adapter.ts': 'export class Jwt {}',
    'src/contracts/index.ts':
      "export { Jwt } from '../native/jwt-auth/adapter';",
  });
  assert.deepEqual(
    checkBoundaries(root).map((error) => error.rule),
    ['layer-dependency', 'layer-dependency'],
  );
});

test('resolves aliases before checking layers and catches barrel bypasses', (t) => {
  const root = fixture(
    t,
    {
      'src/core/application/login.ts': "import { Jwt } from '@core/barrel';",
      'src/core/application/barrel.ts':
        "export { Jwt } from '@native/jwt-auth/adapter';",
      'src/native/jwt-auth/adapter.ts': 'export class Jwt {}',
    },
    {
      paths: {
        '@core/*': ['src/core/application/*'],
        '@native/*': ['src/native/*'],
      },
    },
  );
  const errors = checkBoundaries(root);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'src/core/application/barrel.ts');
  assert.equal(errors[0].rule, 'layer-dependency');
});

test('rejects aliases pointing outside src', (t) => {
  const root = fixture(
    t,
    {
      'outside/shared.ts': 'export const shared = 1;',
      'src/app.ts': "import { shared } from '@outside/shared';",
    },
    { paths: { '@outside/*': ['outside/*'] } },
  );
  assert.equal(checkBoundaries(root)[0]?.rule, 'outside-source');
});

test('rejects local imports outside src and reserva imports from any layer', (t) => {
  const root = fixture(t, {
    'outside.ts': 'export const value = 1;',
    'reserva/old.ts': 'export const old = 1;',
    'src/app.ts':
      "import { value } from '../outside'; import { old } from '../reserva/old';",
  });
  assert.deepEqual(
    checkBoundaries(root).map((error) => error.rule),
    ['outside-source', 'reserved-source'],
  );
});

test('rejects computed imports and requires in pure layers', (t) => {
  const root = fixture(t, {
    'src/core/application/login.ts':
      'const name = "typeorm"; import(name); require(name);',
  });
  assert.deepEqual(
    checkBoundaries(root).map((error) => error.rule),
    ['computed-import', 'computed-import'],
  );
});

test('rejects unresolved local imports', (t) => {
  const root = fixture(t, {
    'src/core/application/login.ts': "import './missing';",
  });
  assert.equal(checkBoundaries(root)[0]?.rule, 'unresolved-import');
});

test('test helpers may use technical libraries but cannot enter production graph', (t) => {
  const root = fixture(t, {
    'src/core/application/login.spec.ts':
      "import { Test } from '@nestjs/testing';",
    'src/core/application/login.ts': "import './login.spec';",
  });
  const errors = checkBoundaries(root);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'test-dependency');
});

test('rejects escaping symlinks even when alias looks internal', (t) => {
  const root = fixture(t, { 'outside.ts': 'export const value = 1;' });
  fs.symlinkSync(
    path.join(root, 'outside.ts'),
    path.join(root, 'src', 'escape.ts'),
  );
  assert.equal(checkBoundaries(root)[0]?.rule, 'outside-source');
});

test('checks triple-slash references as dependencies', (t) => {
  const root = fixture(t, {
    'outside.d.ts': 'declare const value: number;',
    'src/core/application/login.ts':
      '/// <reference path="../../../outside.d.ts" />',
  });
  assert.equal(checkBoundaries(root)[0]?.rule, 'outside-source');
});

test('extension layout flags a technical import in domain and ignores host-only paths', (t) => {
  const root = fixture(t, {
    'src/domain/reading.ts': "import { Injectable } from '@nestjs/common';",
    'src/application/read.ts': "import type { Reading } from '../domain/reading';",
  });
  const errors = checkBoundaries(root, { layout: 'extension' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'external-dependency');
  assert.equal(errors[0].specifier, '@nestjs/common');
});

test('rejects an unsupported boundary layout instead of approving it', (t) => {
  const root = fixture(t, {
    'src/domain/reading.ts': 'export const id = 1;',
  });
  assert.throws(
    () => checkBoundaries(root, { layout: 'plugin' }),
    /Unsupported boundary layout/,
  );
});
