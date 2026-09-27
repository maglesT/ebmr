/**
 * Architecture boundaries (build outline section 4.3, ADR 0001/0011/0015).
 * A violation fails CI. tools/boundaries/test proves each rule fires on a fixture.
 */
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
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(fixtures|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'], extensions: ['.ts', '.js'] },
    preserveSymlinks: false,
  },
};
