import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'curly': ['error'],
    'jsdoc/check-alignment': 'error',
    'jsdoc/check-line-alignment': 'error',
    'new-cap': 'off',
    'no-undef': 'error',
    'perfectionist/sort-exports': 'error',
    'perfectionist/sort-imports': [
      'error',
      {
        groups: [
          'type',
          'internal-type',
          ['parent-type', 'sibling-type', 'index-type'],
          'builtin',
          'external',
          'internal',
          ['parent', 'sibling', 'index'],
          'side-effect',
          'object',
          'unknown',
        ],
        internalPattern: ['^@/.*'],
        order: 'asc',
        type: 'natural',
        newlinesBetween: 'always',
      },
    ],
    'perfectionist/sort-named-exports': 'error',
    'perfectionist/sort-named-imports': 'error',
    'quotes': ['error', 'single'],
    'sort-imports': 'off',
    'style/brace-style': ['error', '1tbs'],
    'style/quote-props': ['error', 'consistent-as-needed'],
    'test/no-only-tests': 'error',
    'unicorn/no-useless-spread': 'error',
    'unused-imports/no-unused-vars': ['error', { caughtErrors: 'none' }],
  },
  typescript: true,
  yaml: true,
  formatters: {
    markdown: true,
  },
})
