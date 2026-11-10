import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
const productionSource = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const testSource = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const portable = (value) => value.split(path.sep).join('/');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};
const real = (target) =>
  fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);

function layer(relativePath) {
  if (relativePath.startsWith('core/domain/')) return 'domain';
  if (relativePath.startsWith('core/application/')) return 'application';
  if (relativePath.startsWith('contracts/')) return 'contracts';
  return 'technical';
}

/**
 * Layouts the gate can actually analyze. `foundation` is the host tree.
 * `extension` is `src/domain` and `src/application` of a packaged module.
 * Anything else is unsupported; the caller must not treat it as a pass.
 */
export const SUPPORTED_BOUNDARY_LAYOUTS = ['foundation', 'extension'];

function layerOf(relativePath, layout) {
  if (layout === 'extension') {
    if (relativePath.startsWith('domain/')) return 'domain';
    if (relativePath.startsWith('application/')) return 'application';
    return 'technical';
  }
  return layer(relativePath);
}

function allowedLayer(from, to) {
  if (from === 'domain') return to === 'domain';
  if (from === 'application') return to === 'domain' || to === 'application';
  if (from === 'contracts')
    return ['domain', 'application', 'contracts'].includes(to);
  return true;
}

/** Static architecture gate, not a sandbox for untrusted plugins. */
export function checkBoundaries(
  projectRoot = path.resolve(path.dirname(scriptPath), '..'),
  options = {},
) {
  const layout = options.layout ?? 'foundation';
  if (!SUPPORTED_BOUNDARY_LAYOUTS.includes(layout)) {
    throw new Error(`Unsupported boundary layout: ${layout}`);
  }
  projectRoot = real(projectRoot);
  const sourceRoot = path.join(projectRoot, 'src');
  const configPath = path.join(projectRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot,
  );
  const errors = [];
  const files = [];
  const visited = new Set();

  function report(file, node, source, rule, message, specifier) {
    const position =
      source && node
        ? source.getLineAndCharacterOfPosition(node.getStart(source))
        : { line: 0, character: 0 };
    errors.push({
      file: portable(path.relative(projectRoot, file)),
      line: position.line + 1,
      column: position.character + 1,
      rule,
      message,
      ...(specifier === undefined ? {} : { specifier }),
    });
  }

  function walk(directory) {
    const resolved = real(directory);
    if (!inside(sourceRoot, resolved)) {
      report(
        directory,
        undefined,
        undefined,
        'outside-source',
        'Source symlink escapes src.',
      );
      return;
    }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isSymbolicLink()) {
        if (!inside(sourceRoot, real(target)))
          report(
            target,
            undefined,
            undefined,
            'outside-source',
            'Source symlink escapes src.',
          );
        else if (fs.statSync(target).isDirectory()) walk(target);
        else if (productionSource.test(target) && !testSource.test(target))
          files.push(target);
      } else if (productionSource.test(target) && !testSource.test(target))
        files.push(target);
    }
  }

  if (!fs.existsSync(sourceRoot))
    throw new Error(`Source directory not found: ${sourceRoot}`);
  walk(sourceRoot);
  for (const file of files.sort()) {
    const from = layerOf(portable(path.relative(sourceRoot, file)), layout);
    const pure = from !== 'technical';
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    function checkSpecifier(expression, node) {
      if (!expression || !ts.isStringLiteralLike(expression)) {
        if (pure)
          report(
            file,
            node,
            source,
            'computed-import',
            'Computed imports are forbidden in pure layers.',
          );
        return;
      }
      const specifier = expression.text;
      if (
        specifier
          .split(/[\\/]/)
          .some((part) => part.toLowerCase() === 'reserva')
      ) {
        report(
          file,
          node,
          source,
          'reserved-source',
          'Imports from reserva are forbidden.',
          specifier,
        );
        return;
      }
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      const local = specifier.startsWith('.') || path.isAbsolute(specifier);
      const target = resolved
        ? real(resolved.resolvedFileName)
        : local
          ? path.resolve(path.dirname(file), specifier)
          : undefined;
      const external =
        !local && (!resolved || resolved.isExternalLibraryImport);
      if (external) {
        if (pure)
          report(
            file,
            node,
            source,
            'external-dependency',
            'Pure layers cannot depend on packages or platform libraries.',
            specifier,
          );
        return;
      }
      if (!target || !inside(sourceRoot, target)) {
        report(
          file,
          node,
          source,
          'outside-source',
          'Local imports must stay inside src.',
          specifier,
        );
        return;
      }
      if (!resolved) {
        report(
          file,
          node,
          source,
          'unresolved-import',
          'Local import cannot be resolved.',
          specifier,
        );
        return;
      }
      if (testSource.test(target)) {
        report(
          file,
          node,
          source,
          'test-dependency',
          'Production source cannot import test files.',
          specifier,
        );
        return;
      }
      const to = layerOf(portable(path.relative(sourceRoot, target)), layout);
      if (!allowedLayer(from, to))
        report(
          file,
          node,
          source,
          'layer-dependency',
          `${from} cannot depend on ${to}.`,
          specifier,
        );
    }

    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) checkSpecifier(node.moduleSpecifier, node);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        checkSpecifier(node.moduleReference.expression, node);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument)
      ) {
        checkSpecifier(node.argument.literal, node);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        const isRequireMethod =
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          ((callee.expression.text === 'require' &&
            callee.name.text === 'resolve') ||
            (callee.expression.text === 'module' &&
              callee.name.text === 'require'));
        if (
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          isRequire ||
          isRequireMethod
        )
          checkSpecifier(node.arguments[0], node);
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
    for (const reference of source.referencedFiles) {
      const target = path.resolve(path.dirname(file), reference.fileName);
      const synthetic = ts.factory.createStringLiteral(target);
      // Triple-slash references have no AST node but obey the same boundary.
      checkSpecifier(synthetic, source);
    }
    if (pure && source.typeReferenceDirectives.length)
      report(
        file,
        source,
        source,
        'external-dependency',
        'Pure layers cannot declare external type references.',
      );
  }
  return errors;
}

if (process.argv[1] && real(process.argv[1]) === real(scriptPath)) {
  try {
    const errors = checkBoundaries(process.argv[2]);
    for (const error of errors)
      console.error(
        `${error.file}:${error.line}:${error.column} [${error.rule}] ${error.message}${error.specifier ? ` (${error.specifier})` : ''}`,
      );
    if (errors.length) process.exitCode = 1;
    else console.log('Architecture boundaries: passed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
