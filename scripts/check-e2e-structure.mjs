#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const FEATURE_GLOB = 'specs/features/**/*.feature';
const STEP_DISCOVERY = Object.freeze([
  'tests/e2e/fixtures/test.ts',
  'tests/e2e/**/*.steps.ts',
]);
const REGISTRATION_NAMES = new Set([
  'Given', 'When', 'Then', 'Before', 'After', 'BeforeAll', 'AfterAll',
]);
const MUTABLE_COLLECTIONS = new Set(['Map', 'Set']);

function sourceFile(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function lineOf(node, source) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function unwrap(expression) {
  let current = expression;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  )) current = current.expression;
  return current;
}

function isMutableInitializer(initializer) {
  const expression = unwrap(initializer);
  if (!expression) return false;
  if (ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression)) return true;
  return ts.isNewExpression(expression)
    && ts.isIdentifier(expression.expression)
    && MUTABLE_COLLECTIONS.has(expression.expression.text);
}

function isExported(statement) {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function listTypeScriptFiles(directory) {
  if (!existsSync(directory)) return [];
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) paths.push(path);
  }
  return paths.sort();
}

function importResolvesTo(importer, specifier, expected) {
  if (!specifier.startsWith('.')) return false;
  const resolution = ts.resolveModuleName(specifier, importer, {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }, ts.sys).resolvedModule?.resolvedFileName;
  if (resolution) return resolve(resolution) === resolve(expected);
  const candidate = resolve(dirname(importer), specifier);
  const resolved = extname(candidate) ? candidate : `${candidate}.ts`;
  return resolve(resolved) === resolve(expected);
}

function isExportedMutableInitializer(initializer) {
  const expression = unwrap(initializer);
  return isMutableInitializer(expression) || Boolean(expression && ts.isNewExpression(expression));
}

function checkPlaywrightConfig(root, errors) {
  const path = resolve(root, 'playwright.config.ts');
  if (!existsSync(path)) {
    errors.push('playwright.config.ts is missing');
    return;
  }
  const source = sourceFile(path);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'defineBddConfig') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (calls.length !== 1) {
    errors.push(`playwright.config.ts must call defineBddConfig exactly once (found ${calls.length})`);
    return;
  }
  const [call] = calls;
  const options = call.arguments[0];
  if (call.arguments.length !== 1 || !options || !ts.isObjectLiteralExpression(options)) {
    errors.push('defineBddConfig must receive one object literal');
    return;
  }
  const properties = new Map();
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      properties.set(property.name.text, property.initializer);
    }
  }
  const features = properties.get('features');
  if (!features || !ts.isStringLiteral(features) || features.text !== FEATURE_GLOB) {
    errors.push(`defineBddConfig.features must be exactly '${FEATURE_GLOB}'`);
  }
  const steps = properties.get('steps');
  if (!steps || !ts.isArrayLiteralExpression(steps)
    || steps.elements.length !== STEP_DISCOVERY.length
    || steps.elements.some((element, index) => (
      !ts.isStringLiteral(element) || element.text !== STEP_DISCOVERY[index]
    ))) {
    errors.push(`defineBddConfig.steps must be exactly ${JSON.stringify(STEP_DISCOVERY)}`);
  }
}

function checkFixture(root, errors) {
  const path = resolve(root, STEP_DISCOVERY[0]);
  if (!existsSync(path)) {
    errors.push(`${STEP_DISCOVERY[0]} is missing`);
    return;
  }
  const source = sourceFile(path);
  const importedTests = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'playwright-bdd') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'test') importedTests.add(element.name.text);
    }
  }

  let validExport = false;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = unwrap(declaration.initializer);
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0
        || !ts.isIdentifier(declaration.name) || declaration.name.text !== 'test'
        || !initializer || !ts.isCallExpression(initializer)
        || !ts.isPropertyAccessExpression(initializer.expression)
        || initializer.expression.name.text !== 'extend'
        || !ts.isIdentifier(initializer.expression.expression)
        || !importedTests.has(initializer.expression.expression.text)) continue;
      validExport = true;
    }
  }
  if (!validExport) {
    errors.push(`${STEP_DISCOVERY[0]} must export const test = <playwright-bdd test>.extend(...)`);
  }
}

function checkStepModule(path, root, source, errors) {
  const canonicalFixture = resolve(root, STEP_DISCOVERY[0]);
  let canonicalTestImports = 0;
  let forbiddenPackageTestImports = 0;
  let unaliasedCreateBddImport = false;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (element.name.text === 'test' && !element.propertyName
        && importResolvesTo(path, statement.moduleSpecifier.text, canonicalFixture)) {
        canonicalTestImports += 1;
      }
      if (importedName === 'test'
        && ['@playwright/test', 'playwright-bdd'].includes(statement.moduleSpecifier.text)) {
        forbiddenPackageTestImports += 1;
      }
      if (statement.moduleSpecifier.text === 'playwright-bdd'
        && element.name.text === 'createBdd' && !element.propertyName) {
        unaliasedCreateBddImport = true;
      }
    }
  }
  const label = relative(root, path);
  if (canonicalTestImports !== 1) {
    errors.push(`${label} must import the unaliased named export test from ${STEP_DISCOVERY[0]}`);
  }
  if (forbiddenPackageTestImports > 0) {
    errors.push(`${label} must not import test directly from @playwright/test or playwright-bdd`);
  }
  if (!unaliasedCreateBddImport) {
    errors.push(`${label} must import the unaliased named export createBdd from playwright-bdd`);
  }

  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'createBdd') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (calls.length !== 1 || calls[0].arguments.length !== 1
    || !ts.isIdentifier(calls[0].arguments[0]) || calls[0].arguments[0].text !== 'test') {
    errors.push(`${label} must call createBdd exactly once as createBdd(test)`);
  }
}

function checkTypeScriptFile(path, root, errors) {
  const source = sourceFile(path);
  const label = relative(root, path);
  const isSteps = path.endsWith('.steps.ts');
  const mutableTopLevelBindings = new Map();

  if (isSteps) checkStepModule(path, root, source, errors);

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declarationKind = statement.declarationList.flags;
    const mutableBinding = (declarationKind & ts.NodeFlags.Const) === 0;
    for (const declaration of statement.declarationList.declarations) {
      if (isSteps && mutableBinding) {
        errors.push(`${label}:${lineOf(declaration, source)} has top-level mutable let/var step state`);
      }
      if (isSteps && isMutableInitializer(declaration.initializer)) {
        errors.push(`${label}:${lineOf(declaration, source)} has a top-level mutable collection/object singleton`);
      }
      if (isExported(statement) && (mutableBinding || isExportedMutableInitializer(declaration.initializer))) {
        errors.push(`${label}:${lineOf(declaration, source)} exports mutable E2E state`);
      }
      if (ts.isIdentifier(declaration.name)
        && (mutableBinding || isExportedMutableInitializer(declaration.initializer))) {
        mutableTopLevelBindings.set(declaration.name.text, declaration);
      }
    }
  }

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause) || statement.moduleSpecifier) continue;
    for (const element of statement.exportClause.elements) {
      const localName = element.propertyName?.text ?? element.name.text;
      const declaration = mutableTopLevelBindings.get(localName);
      if (declaration) {
        errors.push(`${label}:${lineOf(declaration, source)} exports mutable E2E state`);
      }
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (!isSteps && (REGISTRATION_NAMES.has(node.expression.text) || node.expression.text === 'createBdd')) {
        errors.push(`${label}:${lineOf(node, source)} registers BDD steps outside a *.steps.ts module`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export function inspectE2EStructure(root = process.cwd()) {
  const resolvedRoot = resolve(root);
  const errors = [];
  checkPlaywrightConfig(resolvedRoot, errors);

  const e2eRoot = resolve(resolvedRoot, 'tests/e2e');
  const files = listTypeScriptFiles(e2eRoot);
  if (!files.some((path) => path.endsWith('.steps.ts'))) {
    errors.push('tests/e2e must contain at least one *.steps.ts registration module');
  }
  for (const path of files) {
    if (path.endsWith('/app.steps.ts') || path.endsWith('\\app.steps.ts')) {
      errors.push(`${relative(resolvedRoot, path)} is forbidden; split registrations by capability`);
    }
    checkTypeScriptFile(path, resolvedRoot, errors);
  }
  checkFixture(resolvedRoot, errors);
  return errors;
}

export function checkE2EStructure(root = process.cwd()) {
  const errors = inspectE2EStructure(root);
  if (errors.length > 0) throw new Error(`E2E structure check failed:\n- ${errors.join('\n- ')}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    checkE2EStructure();
    console.log('E2E structure check passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
