const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('compiled contracts expose a stable API without bootstrap or framework imports', () => {
  const output = execFileSync(process.execPath, ['-e', `
    const contracts = require('@devtrack/foundation-api/contracts');
    console.log(JSON.stringify({ major: contracts.FOUNDATION_API_MAJOR,
      auth: typeof contracts.AuthenticationService,
      token: String(contracts.AUTHENTICATION_SERVICE), files: Object.keys(require.cache) }));
  `], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const result = JSON.parse(output);
  assert.equal(result.major, 1);
  assert.equal(result.auth, 'function');
  assert.equal(result.token, 'Symbol(foundation.api.v1.authentication)');
  assert.ok(!result.files.some((file) => /node_modules|infrastructure|reserva|main\.js|app\.module|swagger/i.test(file)));
});

test('the neutral DTO schema contract is exported without loading Nest or Swagger', () => {
  const output = execFileSync(process.execPath, ['-e', `
    const contracts = require('@devtrack/foundation-api/contracts');
    console.log(JSON.stringify({ define: typeof contracts.defineDtoSchema,
      get: typeof contracts.getDtoSchema, files: Object.keys(require.cache) }));
  `], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const result = JSON.parse(output);
  assert.equal(result.define, 'function');
  assert.equal(result.get, 'function');
  assert.ok(!result.files.some((file) => /@nestjs|swagger|reflect-metadata/i.test(file)));
});

test('default composition and AppModule load without @nestjs/swagger in require.cache', () => {
  const output = execFileSync(process.execPath, ['-e', `
    require('./dist/composition/composition.generated.js');
    require('./dist/app.module.js');
    console.log(JSON.stringify(Object.keys(require.cache)));
  `], { cwd: root, encoding: 'utf8', timeout: 20000 });
  const files = JSON.parse(output);
  assert.ok(files.some((file) => /@nestjs[\\/]core/.test(file)));
  assert.ok(!files.some((file) => /@nestjs[\\/]swagger|swagger-ui-dist/.test(file)));
});

function compileConsumer(source, types = []) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-contract-'));
  try {
    fs.mkdirSync(path.join(fixture, 'node_modules/@devtrack'), { recursive: true });
    fs.symlinkSync(root, path.join(fixture, 'node_modules/@devtrack/foundation-api'), 'dir');
    if (types.length) fs.symlinkSync(path.join(root, 'node_modules/@types'), path.join(fixture, 'node_modules/@types'), 'dir');
    fs.writeFileSync(path.join(fixture, 'consumer.ts'), source);
    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', types, noEmit: true }, files: ['consumer.ts'] }));
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', fixture], { encoding: 'utf8', timeout: 30000 });
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

test('an external TypeScript consumer uses pure contracts without Node ambient types', () => {
  compileConsumer(`
    import { FOUNDATION_API_MAJOR, AuthenticationService, createAuditContext, resolveComposition } from '@devtrack/foundation-api/contracts';
    import type { PasswordCredentials, AuthenticationResult, AccessTokenIssuer, UnitOfWork, AuditContext, AuditEntry, OperationContext, ResolvedModuleSelection } from '@devtrack/foundation-api/contracts';
    const input: PasswordCredentials = { username: 'test', password: 'secret' };
    const result: AuthenticationResult = { accessToken: 'opaque', tokenType: 'Bearer', expiresAt: 1, subjectId: 's', sessionId: 'x' };
    // @ts-expect-error JWT claims are not part of the neutral result.
    result.claims;
    // @ts-expect-error Password login requires username.
    const invalid: PasswordCredentials = { password: 'secret' };
    const issuer: AccessTokenIssuer = { issue: async ({ session }) => ({ value: 'opaque', expiresAt: session.expiresAt }) };
    const uow: UnitOfWork<{ value: number }> = { run: async (work) => work({ value: 1 }) };
    const context: OperationContext = { principal: { subjectId: 's', permissions: ['read'] }, correlationId: 'c', deadlineAt: 1000 };
    const auditContext: AuditContext = createAuditContext(context);
    const entry: AuditEntry = { id: 'a', occurredAt: 1, context: auditContext, action: 'read', target: 'resource', outcome: 'succeeded' };
    // @ts-expect-error Operational context is not the minimal audit context.
    const oldAudit: AuditContext = context;
    // @ts-expect-error Permissions are not an audit field.
    auditContext.permissions;
    const modules: readonly ResolvedModuleSelection[] = resolveComposition({ modules: [] }).modules;
    void [FOUNDATION_API_MAJOR, AuthenticationService, input, result, issuer, uow, invalid, entry, oldAudit, modules];
  `);
});

test('Nest registration requires named mandatory ports and rejects the legacy API', () => {
  compileConsumer(`
    import { FoundationCoreModule } from '@devtrack/foundation-api/nest';
    import type { AuthenticationRegistration, AuthenticationPortBindings } from '@devtrack/foundation-api/nest';
    const registration: AuthenticationRegistration = { ports: { identities: 'I', sessions: 'S', tokens: 'T', clock: 'C' } };
    FoundationCoreModule.withAuthentication(registration);
    // @ts-expect-error Session binding is required.
    const missingPort: AuthenticationPortBindings = { identities: 'I', tokens: 'T', clock: 'C' };
    // @ts-expect-error Legacy positional registration is intentionally incompatible.
    const legacy: AuthenticationRegistration = { inject: [], useFactory: () => ({}) };
    void [missingPort, legacy];
  `, ['node']);
});
