// ESLint flat config. Type-aware rules catch unhandled promises; restricted-syntax rules
// enforce project conventions that matter for GMP correctness (see REPO-GUIDE.md).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
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

// react-aria's NumberField and useNumberField produce JavaScript numbers; GMP values use ui-kit's
// string-only DecimalField (plan section 3, ESLint).
const numberFieldBan = {
  paths: [
    { name: 'react-aria-components', importNames: ['NumberField'], message: 'NumberField produces JavaScript numbers; use DecimalField from @ebmr/ui-kit for GMP values.' },
    { name: 'react-aria', importNames: ['useNumberField'], message: 'useNumberField produces JavaScript numbers; use DecimalField from @ebmr/ui-kit for GMP values.' },
    { name: '@react-aria/numberfield', message: 'useNumberField produces JavaScript numbers; use DecimalField from @ebmr/ui-kit for GMP values.' },
    { name: '@react-stately/numberfield', message: 'Number field state produces JavaScript numbers; use DecimalField from @ebmr/ui-kit for GMP values.' },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '.dependency-cruiser.cjs',
      'stryker.config.mjs',
      '.stryker-tmp/**',
      '**/node_modules/**',
      '**/dist/**',
      'tools/boundaries/fixtures/**',
      '**/test/fixtures/**',
      'packages/api-contract/fixtures/**',
      'docs/**',
      'tools/regulatory/**',
      '.reports/**',
      'var/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
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
    // Browser code: the web app and the UI kit (plan section 3).
    files: ['apps/tablets-web/**/*.{ts,tsx}', 'packages/ui-kit/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', numberFieldBan],
    },
  },
  {
    // The trusted clock implementation, tools, tests and simulators may read the system clock. In the
    // apps only the named clock modules may: GMP time comes from the database; the web clock only
    // drives display countdowns from the server offset (plan section 3).
    files: [
      'packages/kernel/src/time/**',
      'tools/**',
      '**/test/**',
      'apps/simulators/**',
      'apps/tablets-server/src/platform/clock.ts',
      'apps/tablets-web/src/app/clock.ts',
      'apps/site-gateway/src/clock.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts', 'apps/tablets-web/vite.config.ts', 'tools/e2e/playwright.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
