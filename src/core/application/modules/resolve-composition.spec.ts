import { CompositionError } from './composition-error';
import type { CompositionErrorCode } from './composition-error';
import type {
  CapabilityBinding,
  ModuleDescriptor,
  ModuleSelection,
} from './module-descriptor';
import { resolveComposition } from './resolve-composition';

function moduleSelection(
  id: string,
  changes: Partial<ModuleDescriptor> = {},
  enabledFeatures?: readonly string[],
): ModuleSelection {
  return {
    descriptor: {
      id,
      foundationApiMajor: 1,
      origin: { kind: 'native' },
      provides: [],
      requires: [],
      ...changes,
    },
    enabledFeatures,
  };
}

function expectFailure(
  action: () => unknown,
  code: CompositionErrorCode,
): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CompositionError);
  expect(failure).toMatchObject({ code });
}

const storage = (id = 'native/storage', major = 1) =>
  moduleSelection(id, { provides: [{ id: 'object-storage', major }] });
const consumer = (id = 'module/media') =>
  moduleSelection(id, {
    requires: [{ id: 'object-storage', major: 1 }],
  });
const storageBinding: CapabilityBinding = {
  consumerId: 'module/media',
  capabilityId: 'object-storage',
  providerId: 'native/storage',
};

describe('resolveComposition', () => {
  it('accepts an empty host and never requires a business module', () => {
    expect(resolveComposition({ modules: [] })).toEqual({
      foundationApiMajor: 1,
      modules: [],
      orderedModuleIds: [],
      bindings: [],
    });
  });

  it('orders providers before consumers independently of input order', () => {
    const modules = [consumer(), moduleSelection('native/audit'), storage()];
    const result = resolveComposition({ modules });
    expect(result.orderedModuleIds).toEqual([
      'native/audit',
      'native/storage',
      'module/media',
    ]);
    expect(result.bindings).toEqual([storageBinding]);
    expect(result.modules).toEqual([
      { id: 'native/audit', enabledFeatures: [] },
      { id: 'native/storage', enabledFeatures: [] },
      { id: 'module/media', enabledFeatures: [] },
    ]);
    expect(resolveComposition({ modules: [...modules].reverse() })).toEqual(
      result,
    );
  });

  it('normalizes equivalent module and feature order while preserving conditional dependencies', () => {
    const descriptor = {
      features: ['upload', 'export'],
      requires: [{ id: 'object-storage', major: 1, whenFeature: 'upload' }],
    };
    const result = resolveComposition({
      modules: [
        moduleSelection('module/media', descriptor, ['upload', 'export']),
        storage(),
      ],
    });
    expect(result.modules).toEqual([
      { id: 'native/storage', enabledFeatures: [] },
      { id: 'module/media', enabledFeatures: ['export', 'upload'] },
    ]);
    expect(result.orderedModuleIds).toEqual(result.modules.map(({ id }) => id));
    expect(result.bindings).toEqual([storageBinding]);
    expect(
      resolveComposition({
        modules: [
          storage(),
          moduleSelection('module/media', descriptor, ['export', 'upload']),
        ],
      }),
    ).toEqual(result);
  });

  it('normalizes omitted and explicitly empty features to equivalent empty lists', () => {
    expect(
      resolveComposition({ modules: [moduleSelection('module/example')] }),
    ).toEqual(
      resolveComposition({
        modules: [moduleSelection('module/example', {}, [])],
      }),
    );
    expect(
      resolveComposition({ modules: [moduleSelection('module/example')] })
        .modules,
    ).toEqual([{ id: 'module/example', enabledFeatures: [] }]);
  });

  it('detaches modules, selected features and bindings from subsequent input mutations', () => {
    const descriptor = {
      id: 'module/media',
      foundationApiMajor: 1,
      origin: { kind: 'native' as const },
      features: ['upload', 'export'],
      provides: [],
      requires: [{ id: 'object-storage', major: 1, whenFeature: 'upload' }],
    };
    const enabledFeatures = ['upload', 'export'];
    const selection = { descriptor, enabledFeatures };
    const binding = { ...storageBinding };
    const input = { modules: [selection, storage()], bindings: [binding] };
    const result = resolveComposition(input);
    expect(enabledFeatures).toEqual(['upload', 'export']);
    expect(result.modules[1]).not.toBe(selection);
    expect(result.modules[1].enabledFeatures).not.toBe(enabledFeatures);
    expect(result.bindings[0]).not.toBe(binding);

    descriptor.id = 'module/changed';
    descriptor.features.length = 0;
    descriptor.requires[0].id = 'changed-capability';
    enabledFeatures.splice(0, enabledFeatures.length, 'changed-feature');
    selection.descriptor = { ...descriptor, id: 'module/replaced' };
    selection.enabledFeatures = ['replacement-feature'];
    binding.consumerId = 'module/changed';
    binding.capabilityId = 'changed-capability';
    binding.providerId = 'native/changed';
    input.modules.length = 0;
    input.bindings.length = 0;

    expect(result).toEqual({
      foundationApiMajor: 1,
      modules: [
        { id: 'native/storage', enabledFeatures: [] },
        { id: 'module/media', enabledFeatures: ['export', 'upload'] },
      ],
      orderedModuleIds: ['native/storage', 'module/media'],
      bindings: [storageBinding],
    });
  });

  it('allows npm origin metadata without installing or loading the package', () => {
    expect(
      resolveComposition({
        modules: [
          moduleSelection('external/example', {
            origin: {
              kind: 'npm',
              packageName: '@example/module',
              version: '1.0.0',
              integrity: 'sha512-example',
            },
          }),
        ],
      }).orderedModuleIds,
    ).toEqual(['external/example']);
  });

  it('rejects a missing provider before any activation', () => {
    expectFailure(
      () => resolveComposition({ modules: [consumer()] }),
      'MISSING_PROVIDER',
    );
  });

  it('rejects incompatible capability majors', () => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [consumer(), storage('native/storage', 2)],
        }),
      'INCOMPATIBLE_CAPABILITY',
    );
  });

  it('rejects ambiguous providers unless a consumer binding selects one', () => {
    const modules = [consumer(), storage(), storage('native/other')];
    expectFailure(() => resolveComposition({ modules }), 'AMBIGUOUS_PROVIDER');
    expect(
      resolveComposition({ modules, bindings: [storageBinding] }).bindings,
    ).toEqual([storageBinding]);
  });

  it('scopes bindings to consumers', () => {
    const bindings = [
      storageBinding,
      {
        consumerId: 'module/second',
        capabilityId: 'object-storage',
        providerId: 'native/other',
      },
    ];
    const result = resolveComposition({
      modules: [
        consumer(),
        consumer('module/second'),
        storage(),
        storage('native/other'),
      ],
      bindings,
    });
    expect(result.bindings).toEqual(bindings);
  });

  it('does not activate a conditional dependency until its feature is selected', () => {
    const descriptor = {
      features: ['media'],
      requires: [{ id: 'object-storage', major: 1, whenFeature: 'media' }],
    };
    const disabled = resolveComposition({
      modules: [moduleSelection('module/example', descriptor)],
    });
    expect(disabled.bindings).toEqual([]);
    expect(disabled.modules).toEqual([
      { id: 'module/example', enabledFeatures: [] },
    ]);
    expectFailure(
      () =>
        resolveComposition({
          modules: [moduleSelection('module/example', descriptor, ['media'])],
        }),
      'MISSING_PROVIDER',
    );
  });

  it.each([
    {
      consumerId: 'unknown',
      capabilityId: 'object-storage',
      providerId: 'native/storage',
    },
    {
      consumerId: 'module/media',
      capabilityId: 'unknown',
      providerId: 'native/storage',
    },
    {
      consumerId: 'module/media',
      capabilityId: 'object-storage',
      providerId: 'unknown',
    },
    {
      consumerId: 'module/media',
      capabilityId: 'object-storage',
      providerId: 'module/media',
    },
  ])('rejects invalid binding %j', (binding) => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [consumer(), storage()],
          bindings: [binding],
        }),
      'INVALID_BINDING',
    );
  });

  it('rejects duplicate bindings, including duplicates pointing to the same provider', () => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [consumer(), storage()],
          bindings: [storageBinding, storageBinding],
        }),
      'INVALID_BINDING',
    );
  });

  it('rejects a binding for an inactive requirement', () => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [
            moduleSelection('module/media', {
              features: ['upload'],
              requires: [
                { id: 'object-storage', major: 1, whenFeature: 'upload' },
              ],
            }),
            storage(),
          ],
          bindings: [storageBinding],
        }),
      'INVALID_BINDING',
    );
  });

  it('rejects duplicate module identifiers', () => {
    expectFailure(
      () => resolveComposition({ modules: [storage(), storage()] }),
      'DUPLICATE_MODULE',
    );
  });

  it('rejects unsupported public API versions', () => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [
            moduleSelection('native/example', { foundationApiMajor: 2 }),
          ],
        }),
      'INCOMPATIBLE_API',
    );
  });

  it('rejects an unknown selected feature', () => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [moduleSelection('native/example', {}, ['typo'])],
        }),
      'UNKNOWN_FEATURE',
    );
  });

  it.each([
    { id: '../private' },
    { provides: [{ id: 'storage', major: 0 }] },
    { provides: [{ id: 'storage', major: 1.2 }] },
    {
      provides: [
        { id: 'storage', major: 1 },
        { id: 'storage', major: 1 },
      ],
    },
    { requires: [{ id: 'storage', major: 1, whenFeature: 'undeclared' }] },
    { features: ['upload', 'upload'] },
    {
      origin: {
        kind: 'npm' as const,
        packageName: '',
        version: '1.0.0',
        integrity: 'digest',
      },
    },
  ])('rejects invalid descriptor metadata %j', (changes) => {
    expectFailure(
      () =>
        resolveComposition({
          modules: [moduleSelection('native/example', changes)],
        }),
      'INVALID_DESCRIPTOR',
    );
  });

  it('rejects cycles and self dependencies', () => {
    const a = moduleSelection('module/a', {
      provides: [{ id: 'a', major: 1 }],
      requires: [{ id: 'b', major: 1 }],
    });
    const b = moduleSelection('module/b', {
      provides: [{ id: 'b', major: 1 }],
      requires: [{ id: 'a', major: 1 }],
    });
    expectFailure(
      () => resolveComposition({ modules: [a, b] }),
      'DEPENDENCY_CYCLE',
    );
    const self = moduleSelection('module/self', {
      provides: [{ id: 'self', major: 1 }],
      requires: [{ id: 'self', major: 1 }],
    });
    expect(() => resolveComposition({ modules: [self] })).toThrow(
      CompositionError,
    );
  });

  it('does not mutate descriptors or selections', () => {
    const selection = Object.freeze(storage());
    Object.freeze(selection.descriptor.provides);
    Object.freeze(selection.descriptor);
    expect(() =>
      resolveComposition({ modules: Object.freeze([selection]) }),
    ).not.toThrow();
  });
});
