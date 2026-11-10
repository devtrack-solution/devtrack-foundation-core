import fs from 'node:fs';
import path from 'node:path';
import { EXTENSION_SOURCES } from '../src/composition/extension-sources';
import {
  DEFAULT_INSTRUMENTATION_OUTPUT,
  generateCompositionFile,
  generateInstrumentationFile,
} from '../src/core/infrastructure/composition/composition-generator';

const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');
const profilePath = path.join(root, 'config', 'composition.yaml');
const outputPath = path.join(
  root,
  'src',
  'composition',
  'composition.generated.ts',
);

function main(): void {
  const profileSource = fs.readFileSync(profilePath, 'utf8');
  const composition = generateCompositionFile({
    profileSource,
    extensions: EXTENSION_SOURCES,
    outputPath,
    check,
  });
  // Instrumentação é gerada no mesmo passo: falha de qualquer um dos dois arquivos interrompe o modo verificação.
  const instrumentation = generateInstrumentationFile({
    profileSource,
    extensions: EXTENSION_SOURCES,
    outputPath: DEFAULT_INSTRUMENTATION_OUTPUT,
    check,
  });
  if (check) console.log('Composition is up to date.');
  else
    console.log(
      composition.changed || instrumentation.changed
        ? 'Composition generated.'
        : 'Composition already up to date.',
    );
}

try {
  main();
} catch (error: unknown) {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : 'ERROR';
  const message = error instanceof Error ? error.message : 'Unknown failure';
  console.error(`[${code}] ${message}`);
  process.exitCode = 1;
}
