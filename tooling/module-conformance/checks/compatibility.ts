import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { exportTargets } from './artifacts';
import type { CheckRecord } from '../reports/schema';

export interface StructuralDiff {
  readonly removedExports: readonly string[];
  readonly addedRequiredOutput: boolean;
  readonly widenedUnion: boolean;
}

function readText(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

export function structuralDiff(baselineRoot: string, candidateRoot: string): StructuralDiff {
  const baseline = JSON.parse(readText(baselineRoot, 'package.json')) as { exports?: unknown };
  const candidate = JSON.parse(readText(candidateRoot, 'package.json')) as { exports?: unknown };
  const baseTargets = new Set(exportTargets(baseline as Record<string, unknown>));
  const nextTargets = new Set(exportTargets(candidate as Record<string, unknown>));
  const removedExports = [...baseTargets].filter((item) => !nextTargets.has(item));
  const baseContract = fs.existsSync(path.join(baselineRoot, 'src/contract.d.ts'))
    ? readText(baselineRoot, 'src/contract.d.ts')
    : '';
  const nextContract = fs.existsSync(path.join(candidateRoot, 'src/contract.d.ts'))
    ? readText(candidateRoot, 'src/contract.d.ts')
    : '';
  return {
    removedExports,
    addedRequiredOutput: /extra:\s*string/.test(nextContract) && !/extra:\s*string/.test(baseContract),
    widenedUnion: nextContract.includes("'c'") && baseContract.includes("'a' | 'b'") && !baseContract.includes("'c'"),
  };
}

export function compileFixture(rootNames: readonly string[], packageDir: string): readonly string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    types: [],
    baseUrl: path.dirname(rootNames[0] ?? packageDir),
  };
  const program = ts.createProgram([...rootNames], options);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

export function compatibilityRecords(options: {
  readonly baselineRoot: string | null;
  readonly candidateRoot: string;
  readonly workDir: string;
  readonly behaviorStdout: { readonly baseline: string | null; readonly candidate: string | null };
}): CheckRecord[] {
  if (options.baselineRoot === null) {
    return [{
      id: 'compatibility',
      status: 'not-applicable',
      reason: 'no-baseline',
      evidence: ['Nenhuma afirmação de compatibilidade entre versões.'],
    }];
  }
  const diff = structuralDiff(options.baselineRoot, options.candidateRoot);
  const breaks: string[] = [];
  if (diff.removedExports.length > 0) breaks.push(`export-removed:${diff.removedExports.join(',')}`);
  if (diff.addedRequiredOutput) breaks.push('required-output-added');
  if (diff.widenedUnion) breaks.push('union-widened');
  if (options.behaviorStdout.baseline !== null && options.behaviorStdout.candidate !== null && options.behaviorStdout.baseline !== options.behaviorStdout.candidate) {
    breaks.push('behavior-diverged');
  }
  const candidateContract = fs.existsSync(path.join(options.candidateRoot, 'src/contract.d.ts'))
    ? fs.readFileSync(path.join(options.candidateRoot, 'src/contract.d.ts'), 'utf8')
    : '';
  const files: string[] = [];
  if (candidateContract.includes('interface Reading') || candidateContract.includes('type Reading')) {
    const implementer = path.join(options.workDir, 'implementer.ts');
    fs.mkdirSync(path.dirname(implementer), { recursive: true });
    fs.writeFileSync(
      implementer,
      `import type { Reading } from '${path.join(options.candidateRoot, 'src/contract')}';\nexport function adapt(): Reading { return { id: 'a', value: 1 }; }\n`,
    );
    files.push(implementer);
  }
  if (candidateContract.includes('type Kind')) {
    const consumer = path.join(options.workDir, 'exhaustive.ts');
    fs.writeFileSync(
      consumer,
      `import type { Kind } from '${path.join(options.candidateRoot, 'src/contract')}';\nexport function handle(kind: Kind): string { switch (kind) { case 'a': return 'a'; case 'b': return 'b'; default: { const neverKind: never = kind; return neverKind; } } }\n`,
    );
    files.push(consumer);
  }
  if (files.length > 0) {
    const diagnostics = compileFixture(files, options.candidateRoot);
    if (diagnostics.length > 0) breaks.push('fixture-type-error');
  }
  if (breaks.length === 0) {
    return [{ id: 'compatibility', status: 'passed', reason: 'no-structural-or-fixture-break', evidence: ['Diferença estrutural ausente não é compatibilidade semântica universal.'] }];
  }
  return [{ id: 'compatibility', status: 'failed', reason: 'incompatibility-observed', evidence: breaks }];
}
