import fs from 'node:fs';
import path from 'node:path';
import {
  ArtifactDependencyError,
  CORE_RUNTIME_PACKAGES,
  NATIVE_SOURCES,
  TOOLING_PACKAGES,
  resolveArtifactDependencies,
} from './native-sources';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const NODE_BUILTIN = /^(node:|[a-z_]+$)/;
const IMPORT_PATTERN =
  /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)
      ? [full]
      : [];
  });
}

/** Nome do pacote npm de um especificador bare (`@scope/name/sub` -> `@scope/name`). */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (NODE_BUILTIN.test(specifier) || specifier.startsWith('node:'))
    return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function importedPackages(files: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const name = packageOf(match[1] ?? match[2] ?? match[3] ?? '');
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}

const CORE_DIRS = ['core', 'contracts', 'composition'].map((dir) =>
  path.join(ROOT, 'src', dir),
);
// Arquivos de tooling não entram no artefato; o núcleo runtime não pode depender deles.
const TOOLING_FILES = new Set(
  [
    'src/core/infrastructure/composition/composition-generator.ts',
    'src/core/infrastructure/composition/composition-profile.ts',
    'src/core/infrastructure/composition/native-sources.ts',
    'src/composition/extension-sources.ts',
  ].map((file) => path.join(ROOT, file)),
);
const hostPackage = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as { dependencies: Record<string, string> };

describe('native runtime dependency declarations', () => {
  it('declares every native package from the real imports of its directory', () => {
    for (const id of Object.keys(NATIVE_SOURCES)) {
      const dir = path.join(ROOT, 'src', id);
      const used = importedPackages(listSources(dir));
      const allowed = new Set([
        ...NATIVE_SOURCES[id].runtimePackages,
        ...CORE_RUNTIME_PACKAGES,
      ]);
      const undeclared = [...used].filter((name) => !allowed.has(name));
      expect({ id, undeclared }).toEqual({ id, undeclared: [] });
    }
  });

  it('keeps the core free of undeclared and tooling packages', () => {
    const files = CORE_DIRS.flatMap(listSources).filter(
      (file) => !TOOLING_FILES.has(file),
    );
    const used = importedPackages(files);
    const undeclared = [...used].filter(
      (name) => !CORE_RUNTIME_PACKAGES.includes(name),
    );
    expect(undeclared).toEqual([]);
  });

  it('never declares tooling packages as runtime and keeps them out of the core', () => {
    for (const source of Object.values(NATIVE_SOURCES))
      for (const name of source.runtimePackages)
        expect(TOOLING_PACKAGES).not.toContain(name);
    for (const name of CORE_RUNTIME_PACKAGES)
      expect(TOOLING_PACKAGES).not.toContain(name);
  });

  it('only declares packages that the host pins in package.json', () => {
    const declared = [
      ...CORE_RUNTIME_PACKAGES,
      ...Object.values(NATIVE_SOURCES).flatMap((s) => s.runtimePackages),
    ];
    for (const name of declared)
      expect(hostPackage.dependencies[name]).toBeDefined();
  });
});

describe('resolveArtifactDependencies', () => {
  const catalog = {
    'native/fixture-storage': { runtimePackages: ['fixture-storage-sdk'] },
    'native/jwt-auth': { runtimePackages: ['jose'] },
  };

  it('includes a selected native package and its core packages', () => {
    const plan = resolveArtifactDependencies({
      selectedNatives: ['native/fixture-storage'],
      catalog,
      corePackages: ['rxjs'],
    });
    expect(plan.runtimePackages).toEqual(['fixture-storage-sdk', 'rxjs']);
    expect(plan.excludedPackages).toEqual(['jose']);
  });

  it('excludes the package of a native that was not selected', () => {
    const plan = resolveArtifactDependencies({
      selectedNatives: [],
      catalog,
      corePackages: ['rxjs'],
    });
    expect(plan.runtimePackages).toEqual(['rxjs']);
    expect(plan.excludedPackages).toEqual(['fixture-storage-sdk', 'jose']);
  });

  it('does not exclude a package still required by a selected native or the core', () => {
    const shared = {
      'native/a': { runtimePackages: ['shared-lib'] },
      'native/b': { runtimePackages: ['shared-lib', 'only-b'] },
    };
    const plan = resolveArtifactDependencies({
      selectedNatives: ['native/a'],
      catalog: shared,
      corePackages: [],
    });
    expect(plan.excludedPackages).toEqual(['only-b']);
  });

  it('rejects a selection of a native without a runtime declaration', () => {
    expect(() =>
      resolveArtifactDependencies({
        selectedNatives: ['native/missing'],
        catalog,
      }),
    ).toThrow(ArtifactDependencyError);
  });

  it('rejects a native that declares a tooling package', () => {
    expect(() =>
      resolveArtifactDependencies({
        selectedNatives: ['native/leaky'],
        catalog: { 'native/leaky': { runtimePackages: ['yaml'] } },
        toolingPackages: ['yaml'],
      }),
    ).toThrow(/tooling package/);
  });
});
