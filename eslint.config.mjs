import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

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
      'packages/db/prisma/migrations/**',
      // Claude Code worktrees are full repo copies — outside the root tsconfig.
      '.claude/**',
    ],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
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
