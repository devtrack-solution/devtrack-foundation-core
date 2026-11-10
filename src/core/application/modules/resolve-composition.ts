import { CompositionError } from './composition-error';
import { MODULE_IDENTIFIER_PATTERN as identifier } from './module-identifier';
import { FOUNDATION_API_MAJOR } from './module-descriptor';
import type {
  CapabilityBinding,
  CapabilityRequirement,
  CompositionInput,
  ModuleSelection,
  ResolvedComposition,
  ResolvedModuleSelection,
} from './module-descriptor';

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (consumer: string, capability: string) =>
  `${consumer}:${capability}`;

function invalid(message: string): never {
  throw new CompositionError('INVALID_DESCRIPTOR', message);
}

function validateSelection(selection: ModuleSelection): void {
  const descriptor = selection.descriptor;
  if (!identifier.test(descriptor.id)) invalid('Invalid module identifier');
  if (descriptor.foundationApiMajor !== FOUNDATION_API_MAJOR) {
    throw new CompositionError(
      'INCOMPATIBLE_API',
      `${descriptor.id} requires an unsupported Foundation API major`,
    );
  }
  if (descriptor.origin.kind === 'npm') {
    const { packageName, version, integrity } = descriptor.origin;
    if (!packageName?.trim() || !version?.trim() || !integrity?.trim()) {
      invalid(`${descriptor.id} has incomplete npm origin metadata`);
    }
  } else if (descriptor.origin.kind !== 'native') {
    invalid(`${descriptor.id} has an unknown origin`);
  }
  const features = new Set(descriptor.features ?? []);
  if (features.size !== (descriptor.features ?? []).length) {
    invalid(`${descriptor.id} declares duplicate features`);
  }
  for (const feature of features) {
    if (!identifier.test(feature)) invalid('Invalid feature identifier');
  }
  const enabled = selection.enabledFeatures ?? [];
  if (new Set(enabled).size !== enabled.length) {
    invalid(`${descriptor.id} selects duplicate features`);
  }
  for (const feature of enabled) {
    if (!features.has(feature)) {
      throw new CompositionError(
        'UNKNOWN_FEATURE',
        `${descriptor.id} does not declare feature ${feature}`,
      );
    }
  }
  for (const contracts of [descriptor.provides, descriptor.requires]) {
    const seen = new Set<string>();
    for (const contract of contracts) {
      if (
        !identifier.test(contract.id) ||
        !Number.isSafeInteger(contract.major) ||
        contract.major < 1 ||
        seen.has(contract.id)
      ) {
        invalid(`${descriptor.id} has an invalid or duplicate capability`);
      }
      seen.add(contract.id);
    }
  }
  for (const requirement of descriptor.requires) {
    if (
      requirement.whenFeature !== undefined &&
      !features.has(requirement.whenFeature)
    ) {
      invalid(`${descriptor.id} requires an undeclared feature`);
    }
  }
}

function activeRequirements(
  selection: ModuleSelection,
): readonly CapabilityRequirement[] {
  const features = new Set(selection.enabledFeatures ?? []);
  return selection.descriptor.requires.filter(
    (requirement) =>
      requirement.whenFeature === undefined ||
      features.has(requirement.whenFeature),
  );
}

/** Resolves metadata without importing modules, opening connections or starting Nest. */
export function resolveComposition(
  input: CompositionInput,
): ResolvedComposition {
  const modules = new Map<string, ModuleSelection>();
  for (const selection of input.modules) {
    validateSelection(selection);
    const id = selection.descriptor.id;
    if (modules.has(id)) {
      throw new CompositionError('DUPLICATE_MODULE', `Duplicate module ${id}`);
    }
    modules.set(id, selection);
  }
  const explicitBindings = new Map<string, CapabilityBinding>();
  for (const binding of input.bindings ?? []) {
    const consumer = modules.get(binding.consumerId);
    const bindingKey = key(binding.consumerId, binding.capabilityId);
    if (
      !consumer ||
      !modules.has(binding.providerId) ||
      !activeRequirements(consumer).some(
        (requirement) => requirement.id === binding.capabilityId,
      ) ||
      explicitBindings.has(bindingKey)
    ) {
      throw new CompositionError(
        'INVALID_BINDING',
        'Unknown or duplicate binding',
      );
    }
    explicitBindings.set(bindingKey, binding);
  }

  const resolved: CapabilityBinding[] = [];
  const dependencies = new Map<string, Set<string>>();
  const ids = [...modules.keys()].sort(compare);
  for (const consumerId of ids) {
    const selection = modules.get(consumerId)!;
    const providerIds = new Set<string>();
    dependencies.set(consumerId, providerIds);
    const requirements = [...activeRequirements(selection)].sort((a, b) =>
      compare(a.id, b.id),
    );
    for (const requirement of requirements) {
      const binding = explicitBindings.get(key(consumerId, requirement.id));
      const candidates = ids.filter((id) =>
        modules
          .get(id)!
          .descriptor.provides.some(
            (provided) =>
              provided.id === requirement.id &&
              provided.major === requirement.major,
          ),
      );
      if (binding && !candidates.includes(binding.providerId)) {
        throw new CompositionError(
          'INVALID_BINDING',
          `${binding.providerId} cannot supply ${requirement.id} to ${consumerId}`,
        );
      }
      if (!binding && candidates.length === 0) {
        const otherVersion = ids.some((id) =>
          modules
            .get(id)!
            .descriptor.provides.some(
              (provided) => provided.id === requirement.id,
            ),
        );
        throw new CompositionError(
          otherVersion ? 'INCOMPATIBLE_CAPABILITY' : 'MISSING_PROVIDER',
          `${consumerId} requires ${requirement.id} major ${requirement.major}`,
        );
      }
      if (!binding && candidates.length > 1) {
        throw new CompositionError(
          'AMBIGUOUS_PROVIDER',
          `${consumerId} needs an explicit binding for ${requirement.id}`,
        );
      }
      const providerId = binding?.providerId ?? candidates[0];
      providerIds.add(providerId);
      resolved.push({ consumerId, capabilityId: requirement.id, providerId });
    }
  }

  // Kahn's algorithm: deterministic order and no recursive stack for long graphs.
  const orderedModuleIds: string[] = [];
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    const next = ids.find(
      (id) =>
        remaining.has(id) &&
        [...dependencies.get(id)!].every(
          (provider) => !remaining.has(provider),
        ),
    );
    if (next === undefined) {
      throw new CompositionError(
        'DEPENDENCY_CYCLE',
        `Dependency cycle among ${[...remaining].join(', ')}`,
      );
    }
    orderedModuleIds.push(next);
    remaining.delete(next);
  }
  const selections: ResolvedModuleSelection[] = orderedModuleIds.map((id) => ({
    id,
    enabledFeatures: [...(modules.get(id)!.enabledFeatures ?? [])].sort(
      compare,
    ),
  }));
  return {
    foundationApiMajor: FOUNDATION_API_MAJOR,
    modules: selections,
    orderedModuleIds: selections.map((selection) => selection.id),
    bindings: resolved,
  };
}
