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

const BUILTIN_MODULE_LOADER_NAME = ['getBuiltin', 'Module'].join('');

const MODULE_LOADER_NAMES = new Set([
  '_load', 'createRequire', BUILTIN_MODULE_LOADER_NAME, 'require',
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

function executableModuleLoad(node) {
  if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || directCommonJsLoader(node.expression))) {
    return {
      esmUrl: node.expression.kind === ts.SyntaxKind.ImportKeyword,
      specifier: node.arguments.length > 0 ? literalModuleSpecifier(node.arguments[0]) : null,
    };
  }
  if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined) {
    return { esmUrl: false, specifier: literalModuleSpecifier(node.moduleReference.expression) };
  }
  return null;
}

function propertyName(expression, name) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === name;
  return ts.isElementAccessExpression(expression)
    && expression.argumentExpression !== undefined
    && literalModuleSpecifier(expression.argumentExpression) === name;
}

function directNamedCall(expression, name) {
  return (ts.isIdentifier(expression) && expression.text === name)
    || propertyName(expression, name);
}

function importMetaUrl(expression) {
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'url'
    && ts.isMetaProperty(expression.expression)
    && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && expression.expression.name.text === 'meta';
}

function canonicalCreateRequireDeclaration(node, hasCanonicalImport) {
  if (!hasCanonicalImport
      || !ts.isVariableDeclaration(node)
      || !ts.isIdentifier(node.name)
      || node.name.text !== 'require'
      || !node.initializer
      || !ts.isCallExpression(node.initializer)
      || !ts.isIdentifier(node.initializer.expression)
      || node.initializer.expression.text !== 'createRequire'
      || node.initializer.questionDotToken
      || node.initializer.arguments.length !== 1
      || !importMetaUrl(node.initializer.arguments[0])) return false;
  return ts.isVariableDeclarationList(node.parent)
    && (node.parent.flags & ts.NodeFlags.Const) !== 0;
}

function directLoaderReference(expression) {
  return (ts.isIdentifier(expression) && expression.text === 'require')
    || ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      && directCommonJsLoader(expression));
}

function loaderHelperReference(expression) {
  return (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    && ['apply', 'bind', 'call', 'resolve'].some((name) => propertyName(expression, name))
    && directLoaderReference(expression.expression);
}

function alternateLoaderReference(expression) {
  return ['_load', 'createRequire', BUILTIN_MODULE_LOADER_NAME].some((name) => (
    directNamedCall(expression, name)
  ));
}

function declarationName(node) {
  const { parent } = node;
  return parent?.name === node
    && (ts.isVariableDeclaration(parent)
      || ts.isParameter(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent));
}

function propertyNameIdentifier(node) {
  const { parent } = node;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node);
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

  function inspectSpecifier(sourceFile, node, importer, specifier, { esmUrl = false } = {}) {
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
    let classifiedSpecifier = specifier;
    if (esmUrl) {
      if (/%(?:2f|5c)/iu.test(specifier)) {
        diagnostics.push(diagnostic(
          sourceFile,
          node,
          'invalid-esm-module-specifier-encoding',
          importer,
          specifier,
          'relative ESM module specifier must not encode a path separator',
        ));
        return;
      }
      try {
        classifiedSpecifier = decodeURIComponent(specifier).replaceAll('\\', '/');
      } catch {
        diagnostics.push(diagnostic(
          sourceFile,
          node,
          'invalid-esm-module-specifier-encoding',
          importer,
          specifier,
          'relative ESM module specifier must use valid percent and UTF-8 encoding',
        ));
        return;
      }
    }
    const target = posixPath.normalize(posixPath.join(posixPath.dirname(importer), classifiedSpecifier));
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

  function loaderShapeDiagnostic(sourceFile, node, importer, message) {
    diagnostics.push(diagnostic(
      sourceFile,
      node,
      'unsupported-module-loader-shape',
      importer,
      '<module-loader>',
      message,
    ));
  }

  function inspectExecutableSpecifier(sourceFile, node, importer, specifier, { esmUrl }) {
    if (specifier === null) {
      diagnostics.push(diagnostic(
        sourceFile,
        node,
        'opaque-executable-module-specifier',
        importer,
        '<non-literal>',
        'direct executable module loads require a string literal or no-substitution template',
      ));
      return;
    }
    if (['module', 'node:module'].includes(specifier)) {
      loaderShapeDiagnostic(
        sourceFile, node, importer,
        'Node module loader APIs must be consumed only through the canonical static createRequire import',
      );
      return;
    }
    if (isInlineDataSpecifier(specifier)) {
      diagnostics.push(diagnostic(
        sourceFile, node, 'inline-data-import', importer, specifier,
        'executable module specifier must not use an inline data URL',
      ));
      return;
    }
    if (isAbsoluteFilesystemSpecifier(specifier)) {
      diagnostics.push(diagnostic(
        sourceFile, node, 'absolute-filesystem-import', importer, specifier,
        'executable module specifier must not use an absolute filesystem path or file URL',
      ));
      return;
    }
    inspectSpecifier(sourceFile, node, importer, specifier, { esmUrl });
  }

  for (const importer of files) {
    const repositoryPath = join(repositoryDirectory, importer);
    let regularFile = false;
    try {
      regularFile = lstatSync(repositoryPath).isFile();
    } catch {
      regularFile = false;
    }
    if (!regularFile) {
      diagnostics.push({
        rule: 'non-regular-repository-entry',
        importer,
        target: importer,
        line: 1,
        column: 1,
        message: 'repository source inventory entries must be regular files',
      });
      continue;
    }
    const extension = posixPath.extname(importer);
    if (isPathAtOrBelow(importer, protectedRoot)
        || !REPOSITORY_SOURCE_EXTENSIONS.has(extension)) continue;
    const source = readFileSync(repositoryPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      importer,
      source,
      ts.ScriptTarget.Latest,
      true,
      repositoryScriptKind(importer),
    );
    let hasCanonicalCreateRequireImport = false;
    for (const statement of sourceFile.statements) {
      const moduleSpecifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        ? statement.moduleSpecifier : null;
      const moduleSpecifierText = moduleSpecifier && ts.isStringLiteral(moduleSpecifier)
        ? moduleSpecifier.text : null;
      if (moduleSpecifierText !== null) {
        inspectSpecifier(sourceFile, statement, importer, moduleSpecifierText, { esmUrl: true });
      }
      if (ts.isImportDeclaration(statement)
          && statement.importClause
          && moduleSpecifierText !== null) {
        const bindings = statement.importClause.namedBindings;
        const defaultOrNamespace = statement.importClause.name !== undefined
          || (bindings !== undefined && ts.isNamespaceImport(bindings))
          || (bindings !== undefined
            && ts.isNamedImports(bindings)
            && bindings.elements.some((element) => (
              (element.propertyName ?? element.name).text === 'default'
            )));
        if (['module', 'node:module'].includes(moduleSpecifierText) && defaultOrNamespace) {
          loaderShapeDiagnostic(
            sourceFile, statement, importer,
            'module loader access must use an unaliased named createRequire import from node:module',
          );
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            if (!MODULE_LOADER_NAMES.has(importedName)
                && !MODULE_LOADER_NAMES.has(element.name.text)) continue;
            if (moduleSpecifierText === 'node:module'
                && importedName === 'createRequire'
                && element.propertyName === undefined
                && element.name.text === 'createRequire') {
              hasCanonicalCreateRequireImport = true;
            } else {
              loaderShapeDiagnostic(
                sourceFile, element, importer,
                'createRequire must be imported without an alias from node:module',
              );
            }
          }
        }
      }
      if (ts.isExportDeclaration(statement)) {
        const elements = statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements : [];
        const exposesLoaderCapability = elements.some((element) => (
          MODULE_LOADER_NAMES.has((element.propertyName ?? element.name).text)
          || MODULE_LOADER_NAMES.has(element.name.text)
        ));
        const opaqueModuleExport = moduleSpecifierText !== null
          && ['module', 'node:module'].includes(moduleSpecifierText)
          && (!statement.exportClause
            || ts.isNamespaceExport(statement.exportClause)
            || elements.some((element) => (
              (element.propertyName ?? element.name).text === 'default'
            )));
        if (exposesLoaderCapability || opaqueModuleExport) {
          loaderShapeDiagnostic(
            sourceFile, statement, importer,
            'module loader capabilities must not be exported from outside source',
          );
        }
      }
    }
    function visit(node) {
      const load = executableModuleLoad(node);
      if (load !== null) inspectExecutableSpecifier(sourceFile, node, importer, load.specifier, load);
      if (ts.isBindingElement(node)
          && (MODULE_LOADER_NAMES.has((node.propertyName ?? node.name).getText(sourceFile))
            || MODULE_LOADER_NAMES.has(node.name.getText(sourceFile)))) {
        loaderShapeDiagnostic(sourceFile, node, importer, 'module loader capabilities cannot be acquired through binding elements');
      }
      const canonicalCreateRequireCall = (ts.isIdentifier(node)
          || ts.isPropertyAccessExpression(node)
          || ts.isElementAccessExpression(node))
        && node.parent !== undefined
        && ts.isCallExpression(node.parent)
        && node.parent.expression === node
        && directNamedCall(node, 'createRequire')
        && canonicalCreateRequireDeclaration(node.parent.parent, hasCanonicalCreateRequireImport);
      const directLoaderCall = directLoaderReference(node)
        && ts.isCallExpression(node.parent)
        && node.parent.expression === node;
      const subsumedLoaderReference = directLoaderReference(node)
        && (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
        && node.parent.expression === node
        && loaderHelperReference(node.parent);
      const declarationOrPropertyName = ts.isIdentifier(node)
        && (declarationName(node)
          || propertyNameIdentifier(node)
          || ts.isBindingElement(node.parent)
          || ts.isImportSpecifier(node.parent)
          || ts.isExportSpecifier(node.parent));
      const exposedLoaderReference = directLoaderReference(node)
        || loaderHelperReference(node)
        || alternateLoaderReference(node);
      if (exposedLoaderReference
          && !canonicalCreateRequireCall
          && !directLoaderCall
          && !subsumedLoaderReference
          && !declarationOrPropertyName) {
        loaderShapeDiagnostic(
          sourceFile, node, importer,
          'module loader capabilities may appear only in canonical direct call source shapes',
        );
      }
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
