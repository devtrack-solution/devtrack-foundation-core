import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FOUNDATION_API_MAJOR } from '../../../src/core/application/modules/module-descriptor';
import type { ModuleDescriptor } from '../../../src/core/application/modules/module-descriptor';
import {
  checkoutDependentSpecifiers,
  copyPackage,
  digestTree,
  hasEscapingSymlink,
  missingExportFiles,
} from '../checks/artifacts';
import {
  compatibilityRecords,
  compileFixture,
} from '../checks/compatibility';
import {
  classifyInventory,
  compositionFailure,
  inventoryVerdict,
  readDescriptorFile,
  renderDeclaredComposition,
  resolveFeatureMatrix,
  writeGenerated,
} from '../checks/composition';
import { RequestError, type ParsedRequest } from '../profiles/schema';
import {
  combineResult,
  executionIdentity,
  exitCode,
  KIT_VERSION,
  redact,
  renderSummary,
  sha256,
  type CheckRecord,
  type ConformanceReport,
  type GlobalResult,
} from '../reports/schema';
import { childEnv, OwnedTemp, runBounded } from './executor';

const load = createRequire(__filename);

interface BoundaryGate {
  checkBoundaries(root: string, options?: { layout?: string }): Array<{ file: string; specifier?: string; rule: string }>;
  SUPPORTED_BOUNDARY_LAYOUTS: readonly string[];
}

async function loadBoundaryGate(): Promise<BoundaryGate> {
  const file = pathToFileURL(path.resolve(__dirname, '..', '..', '..', 'scripts', 'check-boundaries.mjs')).href;
  return (await import(file)) as BoundaryGate;
}

export interface RunOptions {
  readonly request: ParsedRequest;
  readonly outDir: string;
  readonly apiCliRoot?: string;
  readonly installExtension?: (foundationRoot: string, packageDir: string) => void;
}

function fileDigest(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return `sha256:${sha256(fs.readFileSync(file))}`;
}

function prerequisites(apiCliRoot: string): ConformanceReport['prerequisites'] {
  const here = path.resolve(__dirname, '..', '..', '..');
  const entries: Array<[string, string]> = [
    ['resolveComposition', path.join(here, 'src/core/application/modules/resolve-composition.ts')],
    ['renderComposition', path.join(here, 'src/core/infrastructure/composition/composition-generator.ts')],
    ['checkBoundaries', path.join(here, 'scripts/check-boundaries.mjs')],
    ['buildArtifact', path.join(here, 'scripts/build-artifact.ts')],
    ['installExtension', path.join(apiCliRoot, 'src/extensions.ts')],
  ];
  return entries.map(([id, file]) => ({ id, present: fs.existsSync(file), digest: fileDigest(file) }));
}

function kitDigest(): string {
  const files = ['runner/run.ts', 'runner/executor.ts', 'profiles/schema.ts', 'reports/schema.ts'].map((relative) =>
    fs.readFileSync(path.join(__dirname, '..', relative)),
  );
  return `sha256:${sha256(Buffer.concat(files))}`;
}

function check(id: string, status: CheckRecord['status'], reason?: string, evidence?: readonly string[]): CheckRecord {
  return { id, status, ...(reason === undefined ? {} : { reason }), ...(evidence === undefined ? {} : { evidence }) };
}

function loadInstaller(apiCliRoot: string): { validateManifest: Function; parseDescriptor: Function } | null {
  const file = path.join(apiCliRoot, 'src', 'validation.ts');
  if (!fs.existsSync(file)) return null;
  try {
    const loaded = load(file) as { validateManifest?: Function; parseDescriptor?: Function };
    if (typeof loaded.validateManifest !== 'function' || typeof loaded.parseDescriptor !== 'function') return null;
    return { validateManifest: loaded.validateManifest, parseDescriptor: loaded.parseDescriptor };
  } catch {
    return null;
  }
}

function behaviorStdout(root: string, timeoutMs: number): string | null {
  const script = path.join(root, 'behavior.js');
  if (!fs.existsSync(script)) return null;
  const result = spawnSync(process.execPath, [script, '2'], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

export async function runConformance(options: RunOptions): Promise<{ readonly report: ConformanceReport; readonly exitCode: 0 | 1 | 2 }> {
  const started = Date.now();
  const request = options.request;
  const secrets = request.probeSentinel === null ? [] : [request.probeSentinel];
  const owned = new OwnedTemp();
  const checks: CheckRecord[] = [];
  const gate = await loadBoundaryGate();
  const limitations = [
    'O kit não é sandbox. Pacotes são tratados como código de autores confiáveis; diretório temporário não isola código hostil.',
    'Não demonstra carga, serviços externos nem auditoria de segurança.',
    'Não demonstra compatibilidade universal nem estabilidade apenas por major igual.',
    'Contacts não participa desta verificação.',
    'Boot do Nest do host não é exercitado; só o entrypoint declarado pela fixture.',
    `Layouts de fronteira realmente verificados: ${gate.SUPPORTED_BOUNDARY_LAYOUTS.join(', ')}.`,
  ];
  let exception: ConformanceReport['exception'] = null;
  let selectionSummary: ConformanceReport['selection'] = { modules: [], bindings: [] };
  const apiCliRoot = options.apiCliRoot ?? path.resolve(__dirname, '..', '..', '..', '..', 'api-cli');

  const finish = (result: GlobalResult): { readonly report: ConformanceReport; readonly exitCode: 0 | 1 | 2 } => {
    const identityInput = {
      schemaVersion: 1,
      kitVersion: KIT_VERSION,
      kitDigest: kitDigest(),
      foundationApiMajor: FOUNDATION_API_MAJOR,
      host: { version: request.host.version, digest: request.host.digest },
      module: { version: request.module.version, digest: request.module.digest },
      profile: {
        id: request.profile.id,
        version: request.profile.version,
        digest: request.profile.digest,
        kind: request.profile.kind,
      },
      selection: selectionSummary,
      tools: request.tools,
      limits: request.limits,
      baseline: request.baseline === null ? null : { hostDigest: request.baseline.host.digest, moduleDigest: request.baseline.module.digest },
      migration: request.migration,
    };
    const claims = {
      standardProfile: result === 'passed' && request.profile.kind === 'standard',
      crossVersionCompatibility: false,
      productionCapacity: false as const,
      securityAudit: false as const,
    };
    const report: ConformanceReport = {
      schemaVersion: 1,
      runId: crypto.randomUUID(),
      kitVersion: KIT_VERSION,
      kitDigest: kitDigest(),
      foundationApiMajor: FOUNDATION_API_MAJOR,
      host: { version: request.host.version, digest: request.host.digest },
      module: { version: request.module.version, digest: request.module.digest },
      profile: identityInput.profile,
      selection: selectionSummary,
      runtime: { node: process.version, platform: os.platform(), arch: os.arch() },
      prerequisites: prerequisites(apiCliRoot),
      checks,
      limitations,
      exception,
      identity: executionIdentity(identityInput),
      result,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      claims,
    };
    const safe = JSON.parse(redact(JSON.stringify(report), secrets)) as ConformanceReport;
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(path.join(options.outDir, 'report.json'), `${JSON.stringify(safe, null, 2)}\n`);
    fs.writeFileSync(path.join(options.outDir, 'summary.txt'), redact(renderSummary(safe), secrets));
    owned.removeAll();
    return { report: safe, exitCode: exitCode(result) };
  };

  try {
    const hostDigest = digestTree(request.host.path);
    const moduleDigest = digestTree(request.module.path);
    if (hostDigest !== request.host.digest) {
      checks.push(check('integrity', 'failed', 'digest-mismatch', ['host']));
      return finish('failed');
    }
    if (moduleDigest !== request.module.digest) {
      checks.push(check('integrity', 'failed', 'digest-mismatch', ['module']));
      return finish('failed');
    }
    checks.push(check('integrity', 'passed'));

    const placed = owned.resolve('module');
    copyPackage(request.module.path, placed);
    const escape = hasEscapingSymlink(placed);
    if (escape !== null) {
      checks.push(check('exports', 'failed', 'symlink-escapes-package', [escape]));
      return finish('failed');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(placed, 'package.json'), 'utf8')) as Record<string, unknown>;
    if (manifest.name === undefined || manifest.version !== request.module.version) {
      checks.push(check('exports', 'failed', 'manifest-version-mismatch'));
      return finish('failed');
    }
    const missing = missingExportFiles(placed, manifest);
    const checkoutDeps = checkoutDependentSpecifiers(placed);
    if (missing.length > 0) checks.push(check('exports', 'failed', 'export-file-missing', missing));
    else if (checkoutDeps.length > 0) checks.push(check('exports', 'failed', 'checkout-dependency', checkoutDeps));
    else checks.push(check('exports', 'passed'));

    const descriptorPath = path.join(placed, request.selection.descriptorFile);
    const origin = {
      kind: 'npm' as const,
      packageName: String(manifest.name),
      version: String(manifest.version),
      integrity: request.module.digest,
    };
    const descriptor = readDescriptorFile(descriptorPath, origin);
    const companions = request.selection.companions.map((relative) => {
      const file = path.join(request.host.path, relative);
      return readDescriptorFile(file, { kind: 'native' });
    });
    try {
      const matrix = resolveFeatureMatrix(descriptor, companions, request.selection.bindings);
      selectionSummary = {
        modules: matrix.on.modules.map((item) => ({ id: item.id, enabledFeatures: item.enabledFeatures })),
        bindings: matrix.on.bindings.map((item) => ({
          consumerId: item.consumerId,
          capabilityId: item.capabilityId,
          providerId: item.providerId,
        })),
      };
      const onFeatures = matrix.on.modules.find((item) => item.id === descriptor.id)?.enabledFeatures ?? [];
      const offFeatures = matrix.off.modules.find((item) => item.id === descriptor.id)?.enabledFeatures ?? [];
      checks.push(check('composition', 'passed', 'feature-matrix', [
        `on:${onFeatures.join(',') || '-'}`,
        `off:${offFeatures.join(',') || '-'}`,
      ]));
    } catch (error) {
      checks.push(compositionFailure(error));
    }

    if (request.profile.requiredChecks.includes('generation') || request.profile.kind === 'standard') {
      try {
        const source = renderDeclaredComposition(descriptor, request.selection.enabledFeatures, owned.resolve('composition.generated.ts'));
        writeGenerated(source, owned.resolve('composition.generated.ts'));
        checks.push(check('generation', 'passed', 'canonical-generator'));
      } catch (error) {
        checks.push(check('generation', 'failed', 'generator-rejected', [error instanceof Error ? error.message : String(error)]));
      }
    }

    const domainDir = path.join(placed, 'src', 'domain');
    const applicationDir = path.join(placed, 'src', 'application');
    const analyzable = fs.existsSync(domainDir) || fs.existsSync(applicationDir);
    if (!analyzable) {
      checks.push(check('boundaries', 'not-run', 'insufficient-material'));
      limitations.push('Fronteira não analisada: o pacote não tem src/domain nem src/application.');
    } else {
      try {
        const errors = gate.checkBoundaries(placed, { layout: 'extension' });
        checks.push(errors.length === 0
          ? check('boundaries', 'passed', 'layout:extension')
          : check('boundaries', 'failed', errors[0]?.rule ?? 'boundary', errors.map((item) => `${item.file}:${item.specifier ?? item.rule}`)));
      } catch (error) {
        checks.push(check('boundaries', 'not-run', 'gate-unavailable', [error instanceof Error ? error.message : String(error)]));
      }
    }

    const consumerFile = owned.resolve('consumer.ts');
    fs.writeFileSync(consumerFile, `import { read } from '${path.join(placed, 'src/contract')}';\nexport const value: number = read({ id: 'a', value: 1 });\n`);
    const implementerFile = owned.resolve('implementer-self.ts');
    fs.writeFileSync(implementerFile, `import type { Reading } from '${path.join(placed, 'src/contract')}';\nexport function write(input: Reading): number { return input.value; }\n`);
    const consumerErrors = compileFixture([consumerFile], placed);
    const implementerErrors = compileFixture([implementerFile], placed);
    checks.push(consumerErrors.length === 0 ? check('consumer', 'passed') : check('consumer', 'failed', 'compile', consumerErrors.slice(0, 3)));
    checks.push(implementerErrors.length === 0 ? check('implementer', 'passed') : check('implementer', 'failed', 'compile', implementerErrors.slice(0, 3)));

    const boot = manifest.conformance;
    const bootArgs = isRecord(boot) && Array.isArray(boot.boot) ? (boot.boot as unknown[]) : null;
    if (bootArgs === null || bootArgs.some((item) => typeof item !== 'string')) {
      checks.push(check('boot', 'not-run', 'boot-entry-missing'));
    } else {
      const [command, ...args] = bootArgs as string[];
      const bounded = await runBounded({
        command: command === 'node' ? process.execPath : command,
        args,
        cwd: placed,
        timeoutMs: request.limits.timeoutMs,
        maxOutputBytes: request.limits.maxOutputBytes,
        env: childEnv(request.probeSentinel === null ? {} : { CONFORMANCE_SENTINEL: request.probeSentinel }),
      });
      if (bounded.timedOut) checks.push(check('boot', 'not-run', 'timeout'));
      else if (bounded.truncated) checks.push(check('boot', 'failed', 'output-limit'));
      else if (bounded.exitCode === 0) checks.push(check('boot', 'passed'));
      else checks.push(check('boot', 'failed', 'boot-exit', [String(bounded.exitCode)]));
    }

    if (request.inventory === null) {
      checks.push(check('inventory', 'not-run', 'inventory-not-provided'));
      limitations.push('Exclusão física não verificada: não há inventário do build canônico. Cache de imports não é evidência.');
    } else {
      const inventoryDigest = `sha256:${sha256(fs.readFileSync(request.inventory.path))}`;
      if (inventoryDigest !== request.inventory.digest) {
        checks.push(check('inventory', 'failed', 'digest-mismatch'));
      } else {
        try {
          const classified = classifyInventory(request.inventory.path);
          checks.push(inventoryVerdict(classified, String(manifest.name)));
          limitations.push('Inventário lido do arquivo informado. Esta execução não invocou buildArtifact.');
        } catch (error) {
          checks.push(check('inventory', 'failed', 'inventory-invalid', [error instanceof Error ? error.message : String(error)]));
        }
      }
    }

    const installer = loadInstaller(apiCliRoot);
    if (installer === null) {
      checks.push(check('install', 'not-run', 'installer-interface-missing'));
      limitations.push('installExtension/validateManifest indisponível. Não houve simulação de instalação.');
    } else {
      try {
        installer.validateManifest(manifest, { name: manifest.name, version: manifest.version }, {
          foundationVersion: '0.0.1',
          installedVersion: () => undefined,
        });
        installer.parseDescriptor(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), String(manifest.name));
        if (request.registry === null || options.installExtension === undefined) {
          checks.push(check('install', 'not-run', 'registry-not-configured'));
          limitations.push('Pacote copiado sem symlink e validado por validateManifest. installExtension no host não rodou: registry ausente.');
        } else if (request.foundationRoot === null) {
          checks.push(check('install', 'not-run', 'foundation-root-missing'));
        } else {
          options.installExtension(request.foundationRoot, placed);
          const link = hasEscapingSymlink(path.join(request.foundationRoot, 'node_modules', String(manifest.name)));
          checks.push(link === null ? check('install', 'passed', 'canonical-install') : check('install', 'failed', 'symlink-to-checkout', [link]));
        }
      } catch (error) {
        checks.push(check('install', 'failed', 'installer-rejected', [error instanceof Error ? error.message : String(error)]));
      }
    }

    const baselineRoot = request.baseline === null ? null : request.baseline.module.path;
    if (baselineRoot !== null && digestTree(baselineRoot) !== request.baseline?.module.digest) {
      checks.push(check('compatibility', 'failed', 'baseline-digest-mismatch'));
    } else {
      const records = compatibilityRecords({
        baselineRoot,
        candidateRoot: placed,
        workDir: owned.resolve('compat'),
        behaviorStdout: {
          baseline: baselineRoot === null ? null : behaviorStdout(baselineRoot, request.limits.timeoutMs),
          candidate: behaviorStdout(placed, request.limits.timeoutMs),
        },
      });
      checks.push(...records);
      if (baselineRoot === null) limitations.push('Sem baseline: nenhuma afirmação de compatibilidade entre versões.');
      else limitations.push('Diferença estrutural ausente não decide toda a compatibilidade semântica.');
    }

    if (request.migration !== null) {
      const digests = new Set(request.migration.artifactDigests);
      const matches = digests.has(request.module.digest) && (request.baseline === null || digests.has(request.baseline.module.digest));
      const decisionExists = fs.existsSync(request.migration.decision);
      const validationExists = fs.existsSync(request.migration.validation);
      const breaks = checks.filter((item) => item.status === 'failed').map((item) => item.id);
      exception = {
        decision: path.basename(request.migration.decision),
        validation: path.basename(request.migration.validation),
        artifactDigests: [...request.migration.artifactDigests].sort(),
        accepted: matches && decisionExists && validationExists,
        breaks,
      };
      if (!matches || !decisionExists || !validationExists) {
        checks.push(check('migration', 'failed', 'exception-rejected'));
      } else {
        checks.push(check('migration', 'failed', 'break-remains-visible'));
        limitations.push('Exceção experimental registrada. A quebra continua visível e não converte check falho em aprovado. Consumidores migrados exigem nova execução.');
      }
    }

    const required = request.profile.kind === 'standard'
      ? request.profile.requiredChecks
      : request.profile.requiredChecks;
    return finish(combineResult(checks, required));
  } catch (error) {
    if (error instanceof RequestError) {
      checks.push(check('input', 'failed', error.field, [error.message]));
      return finish('failed');
    }
    checks.push(check('runner', 'failed', 'runner-error', [error instanceof Error ? error.message : String(error)]));
    return finish('failed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNoModuleLoadOnDigestFailure(marker: string): boolean {
  return !fs.existsSync(marker);
}
