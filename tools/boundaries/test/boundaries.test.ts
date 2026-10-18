import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../../.dependency-cruiser.cjs') as { forbidden: { name: string }[] };
const fixtureRoot = fileURLToPath(new URL('../fixtures', import.meta.url));

interface Violation {
  rule: string;
  from: string;
  to: string;
}

let cached: Promise<Violation[]> | undefined;

function violations(): Promise<Violation[]> {
  cached ??= (async () => {
    const cwd = process.cwd();
    process.chdir(fixtureRoot);
    try {
      const result = await cruise(['packages', 'apps', 'tools'], {
        ruleSet: { forbidden: config.forbidden } as never,
        validate: true,
        tsPreCompilationDeps: true,
      });
      const output = result.output as ICruiseResult;
      return output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from, to: v.to }));
    } finally {
      process.chdir(cwd);
    }
  })();
  return cached;
}

const PHASE_1_RULES = ['no-app-to-app', 'no-package-to-app', 'kernel-is-self-contained', 'expr-is-self-contained', 'recipe-core-allowed-deps', 'no-runtime-import-of-tools'];

// Phase 2 apps plan section 3, rules 1-8 (rule 1 and rule 4 are each split in two: paths and node core modules).
const PHASE_2_RULES: Record<string, string> = {
  'browser-safe': 'apps/tablets-web/src/bad-reach.ts',
  'browser-safe-no-node-core': 'packages/api-contract/src/bad-node.ts',
  'api-contract-allowed-deps': 'packages/api-contract/src/bad-dep.ts',
  'ui-kit-allowed-deps': 'packages/ui-kit/src/bad-dep.ts',
  'recipe-core-pure-no-kernel': 'packages/recipe-core/src/flow/bad-kernel.ts',
  'pure-code-no-node-core': 'packages/recipe-core/src/engine/bad-node.ts',
  'test-kit-never-imports-apps': 'packages/test-kit/src/index.ts',
  'product-never-imports-test-kit': 'apps/tablets-server/src/features/bad-test-kit.ts',
  'gateway-and-simulators-no-db': 'apps/site-gateway/src/index.ts',
  'e2e-imports': 'tools/e2e/specs/bad.spec.ts',
  // Phase 6 slice 6a-0: the adapter subpath stays free of the kernel.
  'integration-sdk-subpaths-no-kernel': 'packages/integration-sdk/src/adapter/bad-kernel.ts',
};

// Phase 6A slice 6A-0: the analytics rules of ADR 0020 point 2 (the self-containment rule split in two: paths and node
// core modules).
const PHASE_6A_RULES: Record<string, string> = {
  'analytics-is-self-contained': 'packages/analytics/src/bad-reach.ts',
  'analytics-no-node-core': 'packages/analytics/src/bad-node.ts',
  'analytics-only-from-runner': 'apps/tablets-server/src/features/bad-analytics.ts',
  'analytics-runner-no-gmp-path': 'apps/tablets-server/src/analytics/bad-gmp.ts',
  'no-gmp-feature-imports-analytics': 'apps/tablets-server/src/features/bad-analytics.ts',
};

// Phase 7 slice 7b-2: the stand-alone record viewer (DI-08) reaches nothing of the repository and no node core module.
const PHASE_7_RULES: Record<string, string> = {
  'record-viewer-standalone': 'apps/record-viewer/src/bad-reach.ts',
  'record-viewer-no-node-core': 'apps/record-viewer/src/bad-node.ts',
};

describe('architecture boundaries (ADR 0001, 0011, 0015)', () => {
  it('[meta] every boundary rule fires on a deliberate violation', async () => {
    const rules = new Set((await violations()).map((v) => v.rule));
    for (const rule of PHASE_1_RULES) expect(rules, rule).toContain(rule);
  });

  it('[meta] every Phase 2 apps rule fires on its own fixture', async () => {
    const found = await violations();
    for (const [rule, from] of Object.entries(PHASE_2_RULES)) {
      expect(
        found.some((v) => v.rule === rule && v.from === from),
        `${rule} should fire on ${from}`,
      ).toBe(true);
    }
    // Every configured rule except no-circular (dependency-cruiser's own) is proven by a fixture.
    const proven = new Set([...PHASE_1_RULES, ...Object.keys(PHASE_2_RULES), ...Object.keys(PHASE_6A_RULES), ...Object.keys(PHASE_7_RULES)]);
    for (const r of config.forbidden) if (r.name !== 'no-circular') expect(proven, r.name).toContain(r.name);
  });

  it('[meta] browser-safe catches database drivers and the node-only recipe-core folders; the set-up CLI may use the test harness', async () => {
    const found = await violations();
    expect(found).toContainEqual({ rule: 'browser-safe', from: 'packages/ui-kit/src/bad-driver.ts', to: 'pg' });
    expect(found).toContainEqual({ rule: 'browser-safe', from: 'apps/tablets-web/src/bad-reach.ts', to: 'packages/recipe-core/src/lifecycle/index.ts' });
    expect(found).toContainEqual({ rule: 'gateway-and-simulators-no-db', from: 'apps/site-gateway/src/index.ts', to: 'pg' });
    expect(found.filter((v) => v.from === 'apps/tablets-server/src/cli/setup.ts')).toEqual([]);
    // tools/e2e may import tools/demo, but not an app.
    expect(found.filter((v) => v.rule === 'e2e-imports').map((v) => v.to)).toEqual(['apps/tablets-server/src/index.ts']);
  });

  it('[meta] each analytics rule of ADR 0020 fires on its own fixture; the runner may import the package', async () => {
    const found = await violations();
    for (const [rule, from] of Object.entries(PHASE_6A_RULES)) {
      expect(
        found.some((v) => v.rule === rule && v.from === from),
        `${rule} should fire on ${from}`,
      ).toBe(true);
    }
    // The package reaches neither another package nor a database driver.
    expect(found).toContainEqual({ rule: 'analytics-is-self-contained', from: 'packages/analytics/src/bad-reach.ts', to: 'pg' });
    expect(found).toContainEqual({ rule: 'analytics-is-self-contained', from: 'packages/analytics/src/bad-reach.ts', to: 'packages/expr/src/index.ts' });
    // The runner reaches neither the kernel nor a feature; a feature reaches neither the package nor the runner.
    expect(found).toContainEqual({ rule: 'analytics-runner-no-gmp-path', from: 'apps/tablets-server/src/analytics/bad-gmp.ts', to: 'packages/kernel/src/index.ts' });
    expect(found).toContainEqual({ rule: 'analytics-runner-no-gmp-path', from: 'apps/tablets-server/src/analytics/bad-gmp.ts', to: 'apps/tablets-server/src/features/bad-test-kit.ts' });
    expect(found).toContainEqual({ rule: 'no-gmp-feature-imports-analytics', from: 'apps/tablets-server/src/features/bad-analytics.ts', to: 'apps/tablets-server/src/analytics/runner.ts' });
    // The runner importing the package breaks no rule.
    expect(found.filter((v) => v.from === 'apps/tablets-server/src/analytics/runner.ts')).toEqual([]);
  });

  it('[meta][DI-08] the record viewer\'s rules fire on their own fixtures: no package, no database driver, no node core module; its own files are allowed', async () => {
    const found = await violations();
    for (const [rule, from] of Object.entries(PHASE_7_RULES)) {
      expect(
        found.some((v) => v.rule === rule && v.from === from),
        `${rule} should fire on ${from}`,
      ).toBe(true);
    }
    expect(found).toContainEqual({ rule: 'record-viewer-standalone', from: 'apps/record-viewer/src/bad-reach.ts', to: 'pg' });
    expect(found).toContainEqual({ rule: 'record-viewer-standalone', from: 'apps/record-viewer/src/bad-reach.ts', to: 'packages/kernel/src/index.ts' });
    expect(found.filter((v) => v.to === 'apps/record-viewer/src/verify/ok.ts')).toEqual([]);
  });
});
