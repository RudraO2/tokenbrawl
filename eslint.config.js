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
    // `.mts`/`.cts` included deliberately: ESLint matches no config block for
    // them by default, so such a file is not merely unparsed — it is not linted
    // at all, and `npx eslint .` stays silent on an AD-1 violation inside one.
    // `scripts/audit-invariants.sh`'s own `grep_core` already sweeps both
    // extensions; the two guards must not disagree about which files count.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
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
  // Not `*.ts` only: the cross-process replay harness put real, executed
  // modules under packages/core in plain JS (`contracts-hooks.mjs`,
  // `register-contracts.mjs`), and an adapter import in one of those breaks
  // AD-1 exactly as hard while being invisible to a TypeScript-only glob.
  {
    files: [
      'packages/core/**/*.ts',
      'packages/core/**/*.tsx',
      'packages/core/**/*.mts',
      'packages/core/**/*.cts',
      'packages/core/**/*.mjs',
      'packages/core/**/*.cjs',
      'packages/core/**/*.js',
    ],
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
