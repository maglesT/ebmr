/**
 * Architecture boundaries (build outline section 4.3, ADR 0001/0011/0015; Phase 2 apps plan section 3).
 * A violation fails CI. tools/boundaries/test proves each rule fires on a fixture.
 */

// Database drivers as dependency-cruiser reports them: resolved through pnpm's store
// (node_modules/.pnpm/<name>@<version>/node_modules/<name>/...) or, when unresolvable, the bare name.
// (dependency-cruiser refuses regular expressions with nested quantifiers.)
const DB_DRIVERS = '^(pg|kysely)$|^@node-rs/|(^|/)node_modules/(pg|kysely|@node-rs)/';
// recipe-core folders that must stay browser-safe (plan section 3: the ./pure subpath).
const RECIPE_PURE = 'packages/recipe-core/src/(flow|validator|limits|simulator|engine|blocks)/|packages/recipe-core/src/pure\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-app-to-app',
      comment: 'Apps never import each other (the two editions stay separate products).',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/([^/]+)/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-package-to-app',
      comment: 'Shared packages never depend on an app.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'kernel-is-self-contained',
      comment: 'The compliance kernel imports nothing else in the repository.',
      severity: 'error',
      from: { path: '^packages/kernel/' },
      to: { path: '^(packages/(?!kernel/)|apps/|tools/)' },
    },
    {
      name: 'expr-is-self-contained',
      comment: 'The expression language imports nothing else in the repository.',
      severity: 'error',
      from: { path: '^packages/expr/' },
      to: { path: '^(packages/(?!expr/)|apps/|tools/)' },
    },
    {
      name: 'recipe-core-allowed-deps',
      comment: 'recipe-core may import only kernel and expr.',
      severity: 'error',
      from: { path: '^packages/recipe-core/' },
      to: { path: '^(packages/(?!(recipe-core|kernel|expr)/)|apps/|tools/)' },
    },
    {
      name: 'no-runtime-import-of-tools',
      comment: 'Product code never imports repository tooling.',
      severity: 'error',
      from: { path: '^(packages|apps)/' },
      to: { path: '^tools/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    // ---- Phase 2 apps (plan section 3, rules 1-8) ------------------------------------------------
    {
      name: 'browser-safe',
      comment:
        'Browser code (web app, UI kit, API contract) never reaches database drivers, node-only packages or the node-only parts of recipe-core (root export, lifecycle, execution).',
      severity: 'error',
      from: { path: '^(apps/tablets-web/src|packages/ui-kit/src|packages/api-contract/src)/' },
      to: {
        path: `^packages/(kernel|site-services|test-kit|validation-kit|integration-sdk)/|^packages/recipe-core/src/(index\\.ts$|lifecycle/|execution/)|${DB_DRIVERS}`,
      },
    },
    {
      name: 'browser-safe-no-node-core',
      comment: 'Browser code never imports node core modules (a node built-in in the bundle also fails vite build).',
      severity: 'error',
      from: { path: '^(apps/tablets-web/src|packages/ui-kit/src|packages/api-contract/src)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'api-contract-allowed-deps',
      comment: 'The API contract depends only on zod, expr and the pure recipe-core folders.',
      severity: 'error',
      from: { path: '^packages/api-contract/src/' },
      to: {
        path: `^(packages/(?!(api-contract|expr)/|${RECIPE_PURE.replace(/packages\//g, '')})|apps/|tools/)|(^|/)node_modules/(?!\\.pnpm/zod@|zod/)`,
      },
    },
    {
      name: 'ui-kit-allowed-deps',
      comment: 'The UI kit depends only on the API contract, expr and the pure recipe-core folders (plus UI libraries).',
      severity: 'error',
      from: { path: '^packages/ui-kit/src/' },
      to: { path: `^(packages/(?!(ui-kit|api-contract|expr)/|${RECIPE_PURE.replace(/packages\//g, '')})|apps/|tools/)` },
    },
    {
      name: 'recipe-core-pure-no-kernel',
      comment: 'flow, validator, limits, simulator, engine and blocks never import the kernel, a database driver or a node core module (they run in the browser).',
      severity: 'error',
      from: { path: `^(${RECIPE_PURE})` },
      to: { path: `^packages/(kernel|site-services)/|${DB_DRIVERS}` },
    },
    {
      name: 'pure-code-no-node-core',
      comment: 'The browser-safe recipe-core folders and expr (except its build-time unit-table generator) never import node core modules.',
      severity: 'error',
      from: { path: `^(${RECIPE_PURE})|^packages/expr/src/`, pathNot: '^packages/expr/src/units/generator/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'test-kit-never-imports-apps',
      comment: 'The test harness serves every app and imports none of them.',
      severity: 'error',
      from: { path: '^packages/test-kit/' },
      to: { path: '^apps/' },
    },
    {
      name: 'product-never-imports-test-kit',
      comment: 'Product code never imports the test harness, except the tablets server set-up CLI (demo and E2E databases) and tests.',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot: '^packages/test-kit/|^apps/tablets-server/src/cli/|^(apps|packages)/[^/]+/test/',
      },
      to: { path: '^packages/test-kit/' },
    },
    {
      name: 'gateway-and-simulators-no-db',
      comment: 'The site gateway and the simulators never reach a database or the kernel (they use the integration-sdk subpaths only).',
      severity: 'error',
      from: { path: '^apps/(site-gateway|simulators)/' },
      to: {
        path: `^packages/(kernel|site-services|recipe-core|test-kit)/|^packages/integration-sdk/src/index\\.ts$|${DB_DRIVERS}`,
      },
    },
    {
      name: 'integration-sdk-subpaths-no-kernel',
      comment: 'The integration-sdk subpaths (scale, process, printer, serialisation, adapter) never import the kernel or a database driver: the gateway, the simulators and the adapters use them (Phase 6 slice 6a-0).',
      severity: 'error',
      from: { path: '^packages/integration-sdk/src/(?!index\\.ts$)' },
      to: { path: `^packages/(kernel|site-services|recipe-core|test-kit)/|^packages/integration-sdk/src/index\\.ts$|${DB_DRIVERS}` },
    },
    {
      name: 'e2e-imports',
      comment: 'End-to-end tests import only packages and the demo tooling, never app internals.',
      severity: 'error',
      from: { path: '^tools/e2e/' },
      to: { path: '^(apps/|tools/(?!(e2e|demo)/))' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^tools/boundaries/fixtures/|(^|/)(node_modules|dist)/|^tools/e2e/(test-results|playwright-report)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'], extensions: ['.ts', '.tsx', '.js'] },
    preserveSymlinks: false,
  },
};
