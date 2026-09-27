// ESLint flat config. Type-aware rules catch unhandled promises; restricted-syntax rules
// enforce project conventions that matter for GMP correctness (see REPO-GUIDE.md).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const clockBan = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use the kernel trusted clock (ADR 0006/0007); Date.now() is banned in domain code.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use the kernel trusted clock; argument-less new Date() is banned in domain code.',
  },
];

export default tseslint.config(
  { ignores: ['.dependency-cruiser.cjs', '**/node_modules/**', '**/dist/**', '**/fixtures/**', 'docs/**', 'tools/regulatory/**', '.reports/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', ...clockBan],
    },
  },
  {
    // The trusted clock implementation, tools and tests may read the system clock.
    files: ['packages/kernel/src/time/**', 'tools/**', '**/test/**', 'apps/simulators/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
