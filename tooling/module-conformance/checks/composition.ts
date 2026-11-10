import fs from 'node:fs';
import path from 'node:path';
import { CompositionError } from '../../../src/core/application/modules/composition-error';
import type { CompositionInput, ModuleDescriptor } from '../../../src/core/application/modules/module-descriptor';
import { resolveComposition } from '../../../src/core/application/modules/resolve-composition';
import { renderComposition } from '../../../src/core/infrastructure/composition/composition-generator';
import type { ExtensionSource } from '../../../src/core/infrastructure/composition/composition-profile';
import type { CheckRecord } from '../reports/schema';

export interface DescriptorJson {
  readonly id: string;
  readonly foundationApiMajor: number;
  readonly origin?: ModuleDescriptor['origin'];
  readonly features?: readonly string[];
  readonly provides: ModuleDescriptor['provides'];
  readonly requires: ModuleDescriptor['requires'];
  readonly exportName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readDescriptorFile(file: string, fallbackOrigin: ModuleDescriptor['origin']): ModuleDescriptor & { readonly exportName: string } {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || typeof raw.id !== 'string') throw new Error(`Descriptor inválido: ${file}`);
  const origin = isRecord(raw.origin) ? (raw.origin as ModuleDescriptor['origin']) : fallbackOrigin;
  return {
    id: raw.id,
    foundationApiMajor: raw.foundationApiMajor as number,
    origin,
    features: Array.isArray(raw.features) ? (raw.features as string[]) : [],
    provides: (raw.provides ?? []) as ModuleDescriptor['provides'],
    requires: (raw.requires ?? []) as ModuleDescriptor['requires'],
    exportName: typeof raw.exportName === 'string' ? raw.exportName : 'Module',
  };
}

export function resolveFeatureMatrix(
  descriptor: ModuleDescriptor,
  companions: readonly ModuleDescriptor[],
  bindings: CompositionInput['bindings'],
): { readonly on: ReturnType<typeof resolveComposition>; readonly off: ReturnType<typeof resolveComposition> } {
  const features = descriptor.features ?? [];
  const on = resolveComposition({
    modules: [
      ...companions.map((item) => ({ descriptor: item })),
      { descriptor, enabledFeatures: features },
    ],
    bindings,
  });
  const off = resolveComposition({
    modules: [
      ...companions.map((item) => ({ descriptor: item })),
      { descriptor, enabledFeatures: [] },
    ],
    bindings: (bindings ?? []).filter((binding) => {
      const requirement = descriptor.requires.find((item) => item.id === binding.capabilityId);
      return requirement?.whenFeature === undefined;
    }),
  });
  return { on, off };
}

export function compositionFailure(error: unknown): CheckRecord {
  if (error instanceof CompositionError) {
    return { id: 'composition', status: 'failed', reason: error.code, evidence: [error.message] };
  }
  return { id: 'composition', status: 'failed', reason: 'composition-error', evidence: [error instanceof Error ? error.message : String(error)] };
}

export function renderDeclaredComposition(
  descriptor: ModuleDescriptor & { readonly exportName: string },
  enabledFeatures: readonly string[],
  outputPath: string,
): string {
  const profile = [
    'foundationApiMajor: 1',
    'natives: []',
    'extensions:',
    `  - id: ${descriptor.id}`,
    `    packageName: "${descriptor.origin.kind === 'npm' ? descriptor.origin.packageName : 'invalid'}"`,
    `    version: "${descriptor.origin.kind === 'npm' ? descriptor.origin.version : '0.0.0'}"`,
    `    integrity: "${descriptor.origin.kind === 'npm' ? descriptor.origin.integrity : 'sha512-invalid'}"`,
    `    features: [${enabledFeatures.join(', ')}]`,
    'bindings: []',
    '',
  ].join('\n');
  const extension: ExtensionSource = { descriptor, exportName: descriptor.exportName };
  const rendered = renderComposition(profile, [extension], outputPath);
  return rendered.source;
}

export function classifyInventory(file: string): {
  readonly physicallyExcluded: readonly string[];
  readonly present: readonly string[];
  readonly disabledAtRuntime: readonly string[];
} {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || !isRecord(raw.modules) || !Array.isArray(raw.packages)) {
    throw new Error('Inventário não tem o formato do build canônico');
  }
  const excluded = Array.isArray(raw.modules.excludedFromBuild) ? (raw.modules.excludedFromBuild as string[]) : null;
  const disabled = Array.isArray(raw.modules.disabledAtRuntime) ? (raw.modules.disabledAtRuntime as string[]) : null;
  if (excluded === null || disabled === null) throw new Error('Inventário sem excludedFromBuild/disabledAtRuntime');
  const present = (raw.packages as unknown[]).map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : '')).filter(Boolean);
  return { physicallyExcluded: excluded, present, disabledAtRuntime: disabled };
}

export function inventoryVerdict(inventory: ReturnType<typeof classifyInventory>, packageName: string): CheckRecord {
  const inPackages = inventory.present.includes(packageName);
  const excluded = inventory.physicallyExcluded.includes(packageName);
  const disabled = inventory.disabledAtRuntime.includes(packageName);
  if (excluded && inPackages) {
    return { id: 'inventory', status: 'failed', reason: 'exclusion-contradicts-packages', evidence: [packageName] };
  }
  if (excluded) {
    return { id: 'inventory', status: 'passed', reason: 'physically-excluded', evidence: [packageName] };
  }
  if (disabled && inPackages) {
    return { id: 'inventory', status: 'passed', reason: 'disabled-at-runtime', evidence: [packageName] };
  }
  if (inPackages) {
    return { id: 'inventory', status: 'passed', reason: 'present-in-artifact', evidence: [packageName] };
  }
  return { id: 'inventory', status: 'failed', reason: 'not-in-inventory', evidence: [packageName] };
}

export function writeGenerated(source: string, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source);
}
