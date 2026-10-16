// A few type-aware rules for what `tsc` can't see: promises nobody awaits, `async` callbacks
// where a plain function is expected, and `any`. No style rules (docs/testing.md, "Static checks").
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', '.claude/', 'node_modules/', 'scratch/'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
    },
  },
  {
    files: ['**/*.ts'],
    ...comments.recommended,
    rules: {
      ...comments.recommended.rules,
      '@eslint-community/eslint-comments/require-description': 'error',
    },
  },
);
