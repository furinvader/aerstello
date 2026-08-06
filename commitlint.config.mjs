export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'perf',
        'docs',
        'test',
        'build',
        'ci',
        'style',
        'chore',
        'revert',
      ],
    ],
    'header-max-length': [2, 'always', 72],
    'subject-full-stop': [2, 'never', '.'],
    'breaking-change-exclamation-mark': [2, 'always'],
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
