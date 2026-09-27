import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../../.dependency-cruiser.cjs') as { forbidden: object[] };
const fixtureRoot = fileURLToPath(new URL('../fixtures', import.meta.url));

async function violations(): Promise<string[]> {
  const cwd = process.cwd();
  process.chdir(fixtureRoot);
  try {
    const result = await cruise(['packages', 'apps', 'tools'], {
      ruleSet: { forbidden: config.forbidden } as never,
      validate: true,
      tsPreCompilationDeps: true,
    });
    const output = result.output as ICruiseResult;
    return output.summary.violations.map((v) => v.rule.name);
  } finally {
    process.chdir(cwd);
  }
}

describe('architecture boundaries (ADR 0001, 0011, 0015)', () => {
  it('[meta] every boundary rule fires on a deliberate violation', async () => {
    const rules = new Set(await violations());
    for (const rule of ['no-app-to-app', 'no-package-to-app', 'kernel-is-self-contained', 'expr-is-self-contained', 'recipe-core-allowed-deps', 'no-runtime-import-of-tools']) {
      expect(rules, rule).toContain(rule);
    }
  });
});
