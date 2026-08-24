import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

const GENERIC_OWNER_NAMES = new Set([
  'common.mjs', 'helper.mjs', 'helpers.mjs', 'misc.mjs', 'util.mjs', 'utils.mjs',
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

function productionFiles(rootDirectory) {
  const files = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['fixtures', 'test-support'].includes(entry.name)) pending.push(path);
      } else if (entry.isFile() && extname(entry.name) === '.mjs' && !entry.name.endsWith('.test.mjs')) {
        files.push(posix(relative(rootDirectory, path)));
      }
    }
  }
  return files.sort();
}

function resolveInternalTarget(rootDirectory, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = posix(relative(rootDirectory, resolve(rootDirectory, dirname(importer), specifier)));
  return target === '..' || target.startsWith('../') ? null : target;
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

export function scanImportBoundaries({ rootDirectory, files = productionFiles(rootDirectory) }) {
  const knownFiles = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set()]));
  const diagnostics = [];

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

    function inspect(node) {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          diagnostics.push(diagnostic(sourceFile, node, 'hidden-module-loading', importer, '<dynamic>', 'dynamic import is forbidden'));
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          diagnostics.push(diagnostic(sourceFile, node, 'hidden-module-loading', importer, '<require>', 'CommonJS require is forbidden'));
        }
      }
      if (ts.isImportEqualsDeclaration(node)) {
        diagnostics.push(diagnostic(sourceFile, node, 'hidden-module-loading', importer, '<import-equals>', 'CommonJS import assignment is forbidden'));
      }
      ts.forEachChild(node, inspect);
    }
    inspect(sourceFile);

    for (const statement of sourceFile.statements) {
      const moduleSpecifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        ? statement.moduleSpecifier : null;
      if (!moduleSpecifier) continue;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        diagnostics.push(diagnostic(sourceFile, statement, 'static-module-specifier', importer, '<non-literal>', 'module specifier must be a string literal'));
        continue;
      }
      const specifier = moduleSpecifier.text;
      if (specifier === 'node:module' && source.includes('createRequire')) {
        diagnostics.push(diagnostic(sourceFile, statement, 'hidden-module-loading', importer, specifier, 'createRequire is forbidden'));
      }
      const target = resolveInternalTarget(rootDirectory, importer, specifier);
      if (target === null) continue;
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
