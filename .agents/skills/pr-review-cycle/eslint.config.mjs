const capabilityRoot = '.agents/skills/pr-review-cycle';
const productionModules = `${capabilityRoot}/scripts/**/*.mjs`;

const forbiddenIdentifierSelector = "Identifier[name=/^(?:require|eval|Function|getBuiltinModule|createRequire)$/]";
const forbiddenNameLiteralSelector = "Literal[value='getBuiltinModule']";
const forbiddenNameTemplateSelector = "TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked='getBuiltinModule']";
const forbiddenRawNameTemplateSelector = "TemplateLiteral[expressions.length=0] > TemplateElement[value.raw='getBuiltinModule']";
const forbiddenComputedNames = new Set([
  'getBuiltinModule',
  'createRequire',
  'require',
  'eval',
  'Function',
]);
const guardedComputedRoots = new Set(['process', 'globalThis', 'module']);

function foldPropertyName(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral') {
    let folded = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      folded += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
      if (index < node.expressions.length) {
        const expression = foldPropertyName(node.expressions[index]);
        if (expression === undefined) return undefined;
        folded += expression;
      }
    }
    return folded;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = foldPropertyName(node.left);
    const right = foldPropertyName(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function memberRoot(node) {
  let current = node;
  while (current.type === 'MemberExpression' || current.type === 'ChainExpression') {
    current = current.type === 'ChainExpression' ? current.expression : current.object;
  }
  return current.type === 'Identifier' ? current.name : undefined;
}

const computedLoaderAccessRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      forbidden: 'Computed access to dynamic code or hidden module-loading APIs is forbidden in production review workflow modules.',
      unknown: 'Unknown computed access on privileged module-loading roots is forbidden in production review workflow modules.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (!node.computed) return;
        const foldedName = foldPropertyName(node.property);
        if (foldedName !== undefined) {
          if (forbiddenComputedNames.has(foldedName)) {
            context.report({ node: node.property, messageId: 'forbidden' });
          }
          return;
        }
        const numericIndex = node.property.type === 'Literal'
          && typeof node.property.value === 'number';
        if (!numericIndex && guardedComputedRoots.has(memberRoot(node))) {
          context.report({ node: node.property, messageId: 'unknown' });
        }
      },
    };
  },
};

export default [
  {
    ignores: [
      '**/*.test.mjs',
      '**/fixtures/**',
      '**/test-support/**',
      '.agents/skills/pr-review-cycle/eslint.config.mjs',
    ],
  },
  {
    files: [productionModules],
    plugins: {
      'pr-review': {
        rules: {
          'computed-loader-access': computedLoaderAccessRule,
        },
      },
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'pr-review/computed-loader-access': 'error',
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'module', message: 'Node module loading APIs are forbidden in production review workflow modules.' },
          { name: 'node:module', message: 'Node module loading APIs are forbidden in production review workflow modules.' },
          { name: 'process', message: 'Process module loading APIs are forbidden in production review workflow modules.' },
          { name: 'node:process', message: 'Process module loading APIs are forbidden in production review workflow modules.' },
        ],
      }],
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: 'Dynamic import is forbidden in production review workflow modules.' },
        { selector: forbiddenIdentifierSelector, message: 'Dynamic code and hidden module-loading identifiers are forbidden in production review workflow modules.' },
        { selector: forbiddenNameLiteralSelector, message: 'Static getBuiltinModule names are forbidden in production review workflow modules.' },
        { selector: forbiddenNameTemplateSelector, message: 'Static getBuiltinModule names are forbidden in production review workflow modules.' },
        { selector: forbiddenRawNameTemplateSelector, message: 'Static getBuiltinModule names are forbidden in production review workflow modules.' },
      ],
    },
  },
];
