/**
 * Architecture boundaries (build outline section 4.3, ADR 0001/0011/0015; Phase 2 apps plan section 3).
 * A violation fails CI. tools/boundaries/test proves each rule fires on a fixture.
 */

// Database drivers as dependency-cruiser reports them: resolved through pnpm's store
// (node_modules/.pnpm/<name>@<version>/node_modules/<name>/...) or, when unresolvable, the bare name.
// (dependency-cruiser refuses regular expressions with nested quantifiers.)
const DB_DRIVERS = '^(pg|kysely)$|^@node-rs/|(^|/)node_modules/(pg|kysely|@node-rs)/';
// recipe-core folders that must stay browser-safe (plan section 3: the ./pure subpath).
const RECIPE_PURE = 'packages/recipe-core/src/(flow|validator|limits|simulator|engine|blocks|library)/|packages/recipe-core/src/pure\\.ts$';

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
      comment: 'flow, validator, limits, simulator, engine, blocks and library never import the kernel, a database driver or a node core module (they run in the browser).',
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
    // ---- Phase 6A analytics (ADR 0020 point 2) ------------------------------------------------------
    {
      name: 'analytics-is-self-contained',
      comment:
        'The analytics package (pure computation) reaches no other package, app or tool, no database driver and, of the external packages, only ml-matrix and @stdlib.',
      severity: 'error',
      from: { path: '^packages/analytics/src/' },
      to: {
        path: `^(packages/(?!analytics/)|apps/|tools/)|${DB_DRIVERS}|(^|/)node_modules/(?!\\.pnpm/(ml-matrix@|@stdlib\\+)|ml-matrix/|@stdlib/)`,
      },
    },
    {
      name: 'analytics-no-node-core',
      comment: 'The analytics package imports no node core module (it runs anywhere a method must reproduce).',
      severity: 'error',
      from: { path: '^packages/analytics/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'analytics-only-from-runner',
      comment: 'Only the analytics runner of the tablets server (and tests) imports the analytics package.',
      severity: 'error',
      from: { pathNot: '^packages/analytics/|^apps/tablets-server/src/analytics/|^(apps|packages|tools)/[^/]+/test/' },
      to: { path: '^packages/analytics/' },
    },
    {
      name: 'analytics-runner-no-gmp-path',
      comment:
        'The analytics runner never reaches a server feature, the command path, the kernel, site services, recipe-core or the integration SDK: it reads views and records advisory outputs only.',
      severity: 'error',
      from: { path: '^apps/tablets-server/src/analytics/' },
      to: {
        path: '^apps/tablets-server/src/features/|^apps/tablets-server/src/platform/db/commands\\.ts$|^packages/(kernel|site-services|recipe-core|integration-sdk)/',
      },
    },
    {
      name: 'no-gmp-feature-imports-analytics',
      comment:
        'No other server feature imports the analytics runner or the analytics feature (the review queue reads the priority through a database view, never through code).',
      severity: 'error',
      from: { path: '^apps/tablets-server/src/features/', pathNot: '^apps/tablets-server/src/features/(analytics/|index\\.ts$)' },
      to: { path: '^apps/tablets-server/src/(analytics|features/analytics)/' },
    },
    // ---- Phase 7 slice 7b-2: the stand-alone record viewer (DI-08) --------------------------------------------------
    {
      name: 'record-viewer-standalone',
      comment:
        'The stand-alone record viewer is a static, offline page: its code reaches no package, app or tool of the repository and no database driver (it verifies an export with its own code, in the browser).',
      severity: 'error',
      from: { path: '^apps/record-viewer/src/' },
      to: { path: `^(packages|apps/(?!record-viewer/)|tools)/|${DB_DRIVERS}` },
    },
    {
      name: 'record-viewer-no-node-core',
      comment: 'The stand-alone record viewer imports no node core module (it runs in a browser from the file system).',
      severity: 'error',
      from: { path: '^apps/record-viewer/src/' },
      to: { dependencyTypes: ['core'] },
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
