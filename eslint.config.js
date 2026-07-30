// Root ESLint flat config (ESLint 9).
//
// Machine-enforces AD-1: packages/core must not import from env-fighter,
// providers, cli, or apps/web. Kept deliberately minimal — a TS-aware parser
// so ESLint doesn't choke on TypeScript syntax, plus the built-in
// `no-restricted-imports` rule (no extra boundary-checking plugin needed).
const parser = require('@typescript-eslint/parser');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      'replays/**',
      '_bmad/**',
      '_bmad-output/**',
      '.agents/**',
      '.bmad-loop/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {},
  },
  // AD-1: packages/core is pure and may not depend on any adapter or app.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/env-fighter/**',
                '**/providers/**',
                '**/cli/**',
                '**/apps/web/**',
                '@tokenbrawl/env-fighter',
                '@tokenbrawl/env-fighter/**',
                '@tokenbrawl/providers',
                '@tokenbrawl/providers/**',
                '@tokenbrawl/cli',
                '@tokenbrawl/cli/**',
              ],
              message:
                'packages/core is pure (AD-1): it must not import from env-fighter, providers, cli, or apps/web.',
            },
          ],
        },
      ],
    },
  },
];
