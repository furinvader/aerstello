const capabilityRoot = '.agents/skills/pr-review-cycle';
const productionModules = `${capabilityRoot}/scripts/**/*.mjs`;

const forbiddenIdentifierSelector = "Identifier[name=/^(?:require|eval|Function|getBuiltinModule)$/]";
const forbiddenNameLiteralSelector = "Literal[value='getBuiltinModule']";
const forbiddenNameTemplateSelector = "TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked='getBuiltinModule']";
const forbiddenRawNameTemplateSelector = "TemplateLiteral[expressions.length=0] > TemplateElement[value.raw='getBuiltinModule']";

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
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
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
