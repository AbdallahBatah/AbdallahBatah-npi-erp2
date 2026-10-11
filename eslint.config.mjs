import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import noLatinUiText from './apps/copilot/eslint-rules/no-latin-ui-text.cjs';

/**
 * Pragmatic baseline: recommended TS rules minus the ones that would flood a
 * working codebase with churn. Tighten incrementally (M1+), never loosen.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'packages/db/prisma/migrations/**',
      'apps/copilot/src/generated/**',
      // Claude Code worktrees are full repo copies — outside the root tsconfig.
      '.claude/**',
    ],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    files: [
      'apps/web/**/*.tsx',
      'apps/web/**/*.ts',
      'apps/copilot/**/*.tsx',
      'apps/copilot/**/*.ts',
    ],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Every string a user can see in the copilot UI must come from
    // src/i18n/ar.ts (spec/madar/08 §E.8) — enforced only for the app's own
    // source, not generated/vendor code.
    files: ['apps/copilot/src/**/*.tsx'],
    plugins: { 'copilot-local': { rules: { 'no-latin-ui-text': noLatinUiText } } },
    rules: {
      'copilot-local/no-latin-ui-text': 'error',
    },
  },
  {
    // Q-5 (2026-10-11): the mechanical sweep's rules, so the SonarCloud
    // baseline does not grow back. `require-await` is off for tests, whose
    // mocks return promises from async stubs on purpose.
    rules: {
      'require-await': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='isNaN']",
          message: 'Use Number.isNaN: the global isNaN coerces its argument first.',
        },
        {
          selector: "CallExpression[callee.property.name='charCodeAt']",
          message: 'Use codePointAt (and String.fromCodePoint): charCodeAt splits astral characters.',
        },
        {
          selector: "CallExpression[callee.property.name='replace'] > Literal.arguments:first-child[regex.flags=/g/]",
          message: 'Use replaceAll with a global pattern.',
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.int-spec.ts', '**/e2e/**', '**/tests/**'],
    rules: { 'require-await': 'off' },
  },
  {
    rules: {
      // Interop with decorators/DTO patterns and existing idioms:
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // DTO definite-assignment (`prop!:`) is the Nest convention:
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
);
