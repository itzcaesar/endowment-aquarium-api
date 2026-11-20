import eslint from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      'import-x': importX,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
    },
  },
  {
    // Plain browser script for the operations dashboard (served as-is, no bundler).
    files: ['apps/game-api/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'sessionStorage',
          'fetch',
          'Node',
          'setTimeout',
          'clearTimeout',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'location',
          'URLSearchParams',
          'MutationObserver',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    files: ['**/*.test.ts', '**/*.config.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
