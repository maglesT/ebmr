// ESLint flat config. Type-aware rules catch unhandled promises; restricted-syntax rules
// enforce project conventions that matter for GMP correctness (see REPO-GUIDE.md).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// The clock ban (REPO-GUIDE "Clock"; ADR 0006/0007): domain code never reads the process clock through Date.
// tools/boundaries/test/clock-ban.test.ts proves each selector fires, once per form.
//  - Date.now is matched as a member access, so a reference (a default clock `= Date.now`, `.map(Date.now)`) is caught
//    as well as a call.
//  - new Date() without arguments, or with spread arguments that may be none.
//  - Date itself is allowed only where it cannot read the clock: `new Date(value)`, Date.parse, Date.UTC,
//    Date.prototype, the right of instanceof, and types (so Date() without new, Date.call, a copy of Date, Date passed
//    as a value and `const { now } = Date` are caught).
//  - Date reached as a member of another object (globalThis.Date, window.Date, a copy of globalThis), where the
//    selectors above cannot see it.
// A syntactic rule sees names, not values: a name built at run time (Reflect.get(globalThis, 'Da' + 'te')) is not seen.
const DATE_ALLOWED_AT = [
  'NewExpression > .callee',
  "MemberExpression:matches([property.name='now'], [property.value='now']) > .object",
  "MemberExpression[computed=false]:matches([property.name='parse'], [property.name='UTC'], [property.name='prototype']) > .object",
  "BinaryExpression[operator='instanceof'] > .right",
  // Names, not the Date constructor: x.Date (the last selector), { Date: ... }, class and interface members.
  'MemberExpression[computed=false] > .property',
  'ObjectExpression > Property[computed=false] > .key',
  'Property[shorthand=true] > .key',
  ':matches(PropertyDefinition, MethodDefinition, TSPropertySignature, TSMethodSignature, TSAbstractPropertyDefinition, TSAbstractMethodDefinition)[computed=false] > .key',
  // Types.
  'TSTypeReference > .typeName',
  'TSQualifiedName > .left',
  'TSQualifiedName > .right',
  'TSTypeQuery > .exprName',
];
const clockBan = [
  {
    selector: "MemberExpression[object.name='Date']:matches([property.name='now'], [property.value='now'])",
    message: 'Use the kernel trusted clock (ADR 0006/0007); Date.now is banned in domain code, called or passed as a function.',
  },
  {
    selector: "NewExpression[callee.name='Date']:matches([arguments.length=0], :has(> SpreadElement.arguments))",
    message: 'Use the kernel trusted clock; argument-less new Date() (or one with spread arguments) is banned in domain code.',
  },
  {
    selector: `Identifier[name='Date']:not(${DATE_ALLOWED_AT.join(', ')})`,
    message:
      'Use the kernel trusted clock; in domain code Date is only constructed with a value, read for Date.parse, Date.UTC or Date.prototype, or named in instanceof and types: any other use (Date() without new, Date.call, a copy, a destructured now) can read the process clock.',
  },
  {
    selector: "MemberExpression:matches([computed=false][property.name='Date'], [property.value='Date'])",
    message: 'Reach Date by its own name in domain code: as a member of another object (globalThis.Date) the clock ban cannot see Date.now, Date() or new Date().',
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
      'stryker.phase6.config.mjs',
      '.stryker-tmp/**',
      '.stryker-tmp-*/**',
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
