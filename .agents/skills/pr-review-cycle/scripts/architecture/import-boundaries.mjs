import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import {
  dirname, extname, join, posix as posixPath, relative, resolve, sep, win32 as win32Path,
} from 'node:path';

import ts from 'typescript';

const GENERIC_OWNER_NAMES = new Set([
  'common.mjs', 'helper.mjs', 'helpers.mjs', 'misc.mjs', 'util.mjs', 'utils.mjs',
]);

const UNSUPPORTED_PRODUCTION_SOURCE_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.mts', '.ts',
]);

const REPOSITORY_SOURCE_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx',
]);

const FACADE_PATHS = new Map([
  ['contracts', 'contracts/contracts.mjs'],
  ['github', 'github/github.mjs'],
  ['state', 'state/state.mjs'],
  ['worktree', 'worktree/worktree.mjs'],
]);

const PRIVILEGED_STATE_IMPORTS = new Map([
  ['state/transition-policy.mjs', new Set(['state/checkpoint.mjs'])],
  ['state/checkpoint.mjs', new Set([
    'state/state.mjs',
    'state/services/archive-import.mjs',
    'state/services/completion.mjs',
    'state/services/git-metadata.mjs',
    'state/services/review.mjs',
    'state/services/tasks.mjs',
    'state/services/validation.mjs',
  ])],
]);

const EXTERNAL_PUBLIC_SURFACES = [
  '.agents/skills/aerstello-specialists/scripts/validate-registry.mjs',
  'scripts/lib/release-state.mjs',
];

function posix(path) {
  return path.split(sep).join('/');
}

function location(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: start.line + 1, column: start.character + 1 };
}

function diagnostic(sourceFile, node, rule, importer, target, message) {
  return { rule, importer, target, ...location(sourceFile, node), message };
}

function productionEntries(rootDirectory) {
  const files = [];
  const diagnostics = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['fixtures', 'test-support'].includes(entry.name)) pending.push(path);
      } else if (entry.isFile()) {
        const extension = extname(entry.name);
        const testSource = entry.name.endsWith(`.test${extension}`);
        if (extension === '.mjs' && !testSource) {
          files.push(posix(relative(rootDirectory, path)));
        } else if (UNSUPPORTED_PRODUCTION_SOURCE_EXTENSIONS.has(extension) && !testSource) {
          const target = posix(relative(rootDirectory, path));
          diagnostics.push({
            rule: 'unsupported-production-source-extension',
            importer: target,
            target,
            line: 1,
            column: 1,
            message: 'canonical production workflow modules must use the .mjs extension',
          });
        }
      } else if (!entry.isFile()) {
        const target = posix(relative(rootDirectory, path));
        diagnostics.push({
          rule: 'non-regular-canonical-entry', importer: target, target, line: 1, column: 1,
          message: 'production architecture entries must be regular files or directories',
        });
      }
    }
  }
  return { files: files.sort(), diagnostics };
}

function resolveInternalTarget(rootDirectory, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolvedTarget = resolve(rootDirectory, dirname(importer), specifier);
  const target = posix(relative(rootDirectory, resolvedTarget));
  return {
    escaped: target === '..' || target.startsWith('../'),
    resolvedTarget,
    target,
  };
}

function isPathAtOrBelow(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function repositoryScriptKind(path) {
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(?:cts|mts|ts)$/u.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function literalModuleSpecifier(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function directCommonJsLoader(expression) {
  if (ts.isIdentifier(expression)) return expression.text === 'require';
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression)
      && expression.expression.text === 'module'
      && expression.name.text === 'require';
  }
  if (ts.isElementAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression)
      && expression.expression.text === 'module'
      && expression.argumentExpression !== undefined
      && literalModuleSpecifier(expression.argumentExpression) === 'require';
  }
  return false;
}

function executableModuleSpecifier(node) {
  if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || directCommonJsLoader(node.expression))) {
    return node.arguments.length > 0 ? literalModuleSpecifier(node.arguments[0]) : null;
  }
  if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined) {
    return literalModuleSpecifier(node.moduleReference.expression);
  }
  return null;
}

export function scanInboundCapabilityImports({
  repositoryDirectory,
  files,
  capabilityRoot,
  permittedExternalAdapters,
} = {}) {
  const protectedRoot = posixPath.normalize(capabilityRoot);
  const permittedEdges = new Set(permittedExternalAdapters.flatMap((adapter) => (
    adapter.targets.map((target) => (
      `${adapter.path}\0${posixPath.join(protectedRoot, target)}`
    ))
  )));
  const diagnostics = [];

  function inspectSpecifier(sourceFile, node, importer, specifier) {
    if (specifier.startsWith('#')) {
      diagnostics.push(diagnostic(
        sourceFile,
        node,
        'opaque-package-import-alias',
        importer,
        specifier,
        'outside package import aliases are opaque to the capability boundary scan',
      ));
      return;
    }
    if (!specifier.startsWith('.')) return;
    const target = posixPath.normalize(posixPath.join(posixPath.dirname(importer), specifier));
    if (!isPathAtOrBelow(target, protectedRoot)) return;
    if (permittedEdges.has(`${importer}\0${target}`)) return;
    diagnostics.push(diagnostic(
      sourceFile,
      node,
      'undeclared-capability-import',
      importer,
      target,
      'outside source must use an exact declared external adapter edge',
    ));
  }

  for (const importer of files) {
    const extension = posixPath.extname(importer);
    if (isPathAtOrBelow(importer, protectedRoot)
        || !REPOSITORY_SOURCE_EXTENSIONS.has(extension)) continue;
    const source = readFileSync(join(repositoryDirectory, importer), 'utf8');
    const sourceFile = ts.createSourceFile(
      importer,
      source,
      ts.ScriptTarget.Latest,
      true,
      repositoryScriptKind(importer),
    );
    for (const statement of sourceFile.statements) {
      const moduleSpecifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        ? statement.moduleSpecifier : null;
      if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
      inspectSpecifier(sourceFile, statement, importer, moduleSpecifier.text);
    }
    function visit(node) {
      const specifier = executableModuleSpecifier(node);
      if (specifier !== null) inspectSpecifier(sourceFile, node, importer, specifier);
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sourceFile, visit);
  }

  return diagnostics.sort((left, right) => (
    formatBoundaryDiagnostic(left).localeCompare(formatBoundaryDiagnostic(right))
  ));
}

function isAbsoluteFilesystemSpecifier(specifier) {
  return posixPath.isAbsolute(specifier)
    || win32Path.isAbsolute(specifier)
    || /^file:/iu.test(specifier);
}

function isInlineDataSpecifier(specifier) {
  return /^data:/iu.test(specifier);
}

function forbiddenLayer(importer, target) {
  const importerLayer = importer.split('/', 1)[0];
  const importedLayer = target.split('/', 1)[0];
  if (importerLayer === 'contracts') {
    return ['github', 'hooks', 'state', 'worktree'].includes(importedLayer);
  }
  if (importerLayer === 'state' && importedLayer === 'github') return true;
  if (importerLayer === 'worktree' && ['github', 'hooks'].includes(importedLayer)) return true;
  return false;
}

function crossesOwnerLayer(importer, target) {
  const importerLayer = importer.split('/', 1)[0];
  const importedLayer = target.split('/', 1)[0];
  return importerLayer !== importedLayer;
}

function publicCrossLayerTarget(target) {
  return target === 'paths.mjs' || [...FACADE_PATHS.values()].includes(target);
}

function declaredExternalDependencies(rootDirectory) {
  try {
    const skillDirectory = dirname(rootDirectory);
    const ownership = JSON.parse(readFileSync(join(skillDirectory, 'ownership.json'), 'utf8'));
    const repositoryDirectory = resolve(
      skillDirectory,
      ...ownership.skillRoot.split('/').map(() => '..'),
    );
    return [
      ...ownership.neutralSharedDependencies,
      ...EXTERNAL_PUBLIC_SURFACES,
    ].map((path) => resolve(repositoryDirectory, path));
  } catch {
    return [];
  }
}

function cycleFrom(graph) {
  const visited = new Set();
  const active = new Set();
  const path = [];
  function visit(file) {
    if (active.has(file)) return [...path.slice(path.indexOf(file)), file];
    if (visited.has(file)) return null;
    visited.add(file);
    active.add(file);
    path.push(file);
    for (const target of graph.get(file) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(file);
    return null;
  }
  for (const file of [...graph.keys()].sort()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return null;
}

export function formatBoundaryDiagnostic(value) {
  return `[${value.rule}] ${value.importer}:${value.line}:${value.column} -> ${value.target}: ${value.message}`;
}

function importedFacadeAccess(statement) {
  if (ts.isExportDeclaration(statement)) {
    if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
      return { names: [], opaque: true };
    }
    return {
      names: statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text),
      opaque: false,
    };
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return { names: [], opaque: false };
  if (ts.isNamespaceImport(bindings)) return { names: [], opaque: true };
  return {
    names: bindings.elements.map((element) => (element.propertyName ?? element.name).text),
    opaque: false,
  };
}

export function scanImportBoundaries({
  rootDirectory,
  files,
  permittedNeutralDependencies,
  privilegedFacadeExports = {},
} = {}) {
  const discoversCanonicalProduction = files === undefined;
  const discovered = files === undefined
    ? productionEntries(rootDirectory) : { files, diagnostics: [] };
  files = discovered.files;
  const knownFiles = new Set(files);
  const permittedNeutralTargets = new Set((
    permittedNeutralDependencies
    ?? (discoversCanonicalProduction ? declaredExternalDependencies(rootDirectory) : [])
  ).map((path) => resolve(path)));
  const graph = new Map(files.map((file) => [file, new Set()]));
  const diagnostics = [...discovered.diagnostics];

  for (const importer of files) {
    const source = readFileSync(join(rootDirectory, importer), 'utf8');
    const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const parseDiagnostic of sourceFile.parseDiagnostics) {
      diagnostics.push(diagnostic(
        sourceFile, sourceFile, 'syntax', importer, importer,
        ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, ' '),
      ));
    }

    if (GENERIC_OWNER_NAMES.has(importer.split('/').at(-1))) {
      diagnostics.push(diagnostic(sourceFile, sourceFile, 'generic-owner-name', importer, importer, 'use a narrow authority-specific module name'));
    }

    for (const statement of sourceFile.statements) {
      const moduleSpecifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        ? statement.moduleSpecifier : null;
      if (!moduleSpecifier) continue;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        diagnostics.push(diagnostic(sourceFile, statement, 'static-module-specifier', importer, '<non-literal>', 'module specifier must be a string literal'));
        continue;
      }
      const specifier = moduleSpecifier.text;
      if (specifier.startsWith('#')) {
        diagnostics.push(diagnostic(
          sourceFile, statement, 'package-import-alias', importer, specifier,
          'static package import aliases are not permitted in the canonical production graph',
        ));
        continue;
      }
      if (isInlineDataSpecifier(specifier)) {
        diagnostics.push(diagnostic(
          sourceFile, statement, 'inline-data-import', importer, specifier,
          'static module specifier must not use an inline data URL',
        ));
        continue;
      }
      if (isAbsoluteFilesystemSpecifier(specifier)) {
        diagnostics.push(diagnostic(
          sourceFile, statement, 'absolute-filesystem-import', importer, specifier,
          'static module specifier must not use an absolute filesystem path or file URL',
        ));
        continue;
      }
      const resolution = resolveInternalTarget(rootDirectory, importer, specifier);
      if (resolution === null) continue;
      const { escaped, resolvedTarget, target } = resolution;
      if (escaped) {
        let regularPermittedFile = false;
        try {
          regularPermittedFile = permittedNeutralTargets.has(resolvedTarget)
            && lstatSync(resolvedTarget).isFile();
        } catch {
          regularPermittedFile = false;
        }
        if (!regularPermittedFile) {
          diagnostics.push(diagnostic(
            sourceFile, statement, 'escaped-capability-import', importer, target,
            'relative import escapes the capability scripts root without an explicitly permitted neutral dependency',
          ));
        }
        continue;
      }
      const targetPath = join(rootDirectory, target);
      let regularFile = false;
      try {
        regularFile = lstatSync(targetPath).isFile();
      } catch {
        regularFile = false;
      }
      if (!regularFile || !knownFiles.has(target)) {
        diagnostics.push(diagnostic(sourceFile, statement, 'unresolved-internal-import', importer, target, 'relative production import must resolve to a checked-in regular production module'));
        continue;
      }
      graph.get(importer).add(target);
      if (forbiddenLayer(importer, target)) {
        diagnostics.push(diagnostic(sourceFile, statement, 'layer-direction', importer, target, 'dependency crosses a forbidden architecture layer'));
      } else if (crossesOwnerLayer(importer, target) && !publicCrossLayerTarget(target)) {
        diagnostics.push(diagnostic(
          sourceFile, statement, 'private-layer-import', importer, target,
          'cross-layer dependencies must use the imported layer public facade or an explicit neutral utility',
        ));
      }
      for (const [layer, facade] of FACADE_PATHS) {
        if (target === facade
            && importer.startsWith(`${layer}/`)
            && importer !== facade
            && !importer.endsWith('/cli.mjs')) {
          diagnostics.push(diagnostic(sourceFile, statement, 'own-facade-import', importer, target, 'internal modules must import their canonical owner, not their public facade'));
        }
      }
      const privilegedConsumers = PRIVILEGED_STATE_IMPORTS.get(target);
      if (privilegedConsumers && !privilegedConsumers.has(importer)) {
        diagnostics.push(diagnostic(sourceFile, statement, 'privileged-state-consumer', importer, target, 'module is not authorized to consume this protected state authority'));
      }
      if (target === 'state/state.mjs') {
        const access = importedFacadeAccess(statement);
        const names = access.opaque ? Object.keys(privilegedFacadeExports) : access.names;
        for (const imported of names) {
          const consumers = privilegedFacadeExports[imported];
          if (consumers && !consumers.includes(importer)) {
            diagnostics.push(diagnostic(
              sourceFile, statement, 'privileged-state-facade-consumer', importer, target,
              `${imported} is not authorized for this state facade consumer`,
            ));
          }
        }
      }
    }
  }

  const cycle = cycleFrom(graph);
  if (cycle) {
    diagnostics.push({
      rule: 'static-import-cycle', importer: cycle[0], target: cycle.at(-1), line: 1, column: 1,
      message: cycle.join(' -> '),
    });
  }
  return diagnostics.sort((left, right) => formatBoundaryDiagnostic(left).localeCompare(formatBoundaryDiagnostic(right)));
}
