// Stryker for the focused mutation campaign at the Phase 7 exit (D-P7-1 item 4, decision 0019's rules): the analytics
// package and its runner (Phase 6A), the gateway feed signature, the adapters' TLS, the IQ checks and the build-status
// tool (Phase 7). The machinery is that of stryker.phase6.config.mjs (one feature per run, high-risk files at 90 %,
// the rest at 80 %, a per-feature incremental file, report and sandbox); only the features differ. The Vitest config
// is the Phase 6 one, which reads the feature's tests from EBMR_STRYKER_PHASE6_TESTS.
//
//   EBMR_STRYKER_FEATURE=<feature> EBMR_PG_ADMIN_URL=<cluster> pnpm exec stryker run stryker.phase7.config.mjs
//   node stryker.phase7.config.mjs --list        the features, their files and tests
//   node stryker.phase7.config.mjs --summary     each finished feature's score per zone, from its JSON report
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import base from './stryker.config.mjs';

const A = 'packages/analytics/src';
const R = 'apps/tablets-server/src/analytics';

/**
 * @typedef {{ kind: 'db' | 'server' | 'unit', high: string[], other: string[], tests: string[] }} Feature
 * @type {Record<string, Feature>}
 */
export const FEATURES = {
  // Priority 1 here: the restricted audit-trail flags; the method registry and runtime that keep a method to its inputs.
  'analytics-methods': {
    kind: 'unit',
    high: [`${A}/methods/audit/**/*.ts`, `${A}/registry.ts`, `${A}/runtime.ts`, `${A}/method.ts`],
    other: [`${A}/methods/{spc,capability,drift,mspc,profile,rates,review}/**/*.ts`, `${A}/numeric/*.ts`],
    tests: ['packages/analytics/test/*.test.ts'],
  },
  // Priority 1 here: analytics segregation (the runner reads as ebmr_analytics and writes no GMP data) and the role check
  // kept in the worker (P6A7-8).
  'analytics-runner': {
    kind: 'server',
    high: [`${R}/runner.ts`, `${R}/pool.ts`, `${R}/threaded.ts`, `${R}/worker-entry.ts`, `${R}/audit.ts`],
    other: [`${R}/{catalog,implementation,inputs,method-types,mspc,profile,review,spc}.ts`],
    tests: ['apps/tablets-server/test/analytics/*.test.ts'],
  },
  'feed-signature': {
    kind: 'unit',
    high: ['packages/integration-sdk/src/adapter/feed-signature.ts'],
    other: [],
    tests: ['packages/integration-sdk/test/adapter/feed-signature.test.ts'],
  },
  // The adapters' TLS and mTLS refusal (slice 7a), with the server's feed-signature tests.
  'adapter-tls': {
    kind: 'server',
    high: ['apps/tablets-server/src/features/integrations/adapters/transport.ts'],
    other: [],
    tests: ['apps/tablets-server/test/security/tls.test.ts', 'apps/tablets-server/test/equipment-data/feed-signature.test.ts'],
  },
  iq: {
    kind: 'db',
    high: ['packages/validation-kit/src/iq/iq.ts'],
    other: ['packages/validation-kit/src/iq/db-inventory.ts'],
    tests: ['tools/validation/test/validation.test.ts'],
  },
  'build-status': {
    kind: 'unit',
    high: ['tools/register/src/build-status.ts'],
    other: [],
    tests: ['tools/register/test/build-status.test.ts'],
  },
};

const OUT = '.reports/stryker-phase7';

/** The Stryker options of one feature (exported for the --list check). */
export function featureOptions(name, highRiskOnly = false) {
  const f = FEATURES[name];
  if (!f) throw new Error(`EBMR_STRYKER_FEATURE names no feature: ${name}; one of ${Object.keys(FEATURES).join(', ')}`);
  return {
    ...base,
    vitest: { configFile: 'vitest.stryker-phase6.config.ts', related: false },
    mutate: highRiskOnly ? f.high : [...f.high, ...f.other],
    // As in Phase 6: a unit feature's static mutants are tested too; a database feature keeps the base setting.
    ignoreStatic: f.kind !== 'unit',
    incremental: true,
    incrementalFile: `${OUT}/${name}.incremental.json`,
    concurrency: Number(process.env['EBMR_STRYKER_CONCURRENCY'] ?? '4'),
    dryRunTimeoutMinutes: 45,
    timeoutMS: 120000,
    thresholds: { high: f.high.length > 0 ? 90 : 80, low: 80, break: null },
    reporters: ['clear-text', 'progress', 'html', 'json'],
    htmlReporter: { fileName: `${OUT}/${name}.html` },
    jsonReporter: { fileName: `${OUT}/${name}.json` },
    tempDirName: `.stryker-tmp-${name}`,
  };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
const feature = process.env['EBMR_STRYKER_FEATURE'];
let config = {};
if (!isMain) {
  if (!feature) throw new Error(`set EBMR_STRYKER_FEATURE to one of: ${Object.keys(FEATURES).join(', ')}`);
  config = featureOptions(feature, process.env['EBMR_STRYKER_HIGH_RISK_ONLY'] === '1');
  process.env['EBMR_STRYKER_PHASE6_TESTS'] = JSON.stringify({ kind: FEATURES[feature].kind, tests: FEATURES[feature].tests });
}
export default config;

/** Score of a list of mutants as Stryker counts it: detected over detected, survived and without coverage. */
function scoreOf(mutants) {
  const n = (s) => mutants.filter((m) => s.includes(m.status)).length;
  const detected = n(['Killed', 'Timeout']);
  const valid = detected + n(['Survived', 'NoCoverage']);
  return { detected, valid, survived: n(['Survived']), noCoverage: n(['NoCoverage']), score: valid === 0 ? 100 : (100 * detected) / valid };
}

function matches(file, pattern) {
  const brace = /\{([^}]*)\}/.exec(pattern);
  if (brace) return brace[1].split(',').some((alt) => matches(file, pattern.replace(brace[0], alt)));
  const re = new RegExp(`^${pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
  return re.test(file);
}

if (isMain && process.argv.includes('--list')) {
  for (const [name, f] of Object.entries(FEATURES)) {
    console.log(`${name} (${f.kind})\n  90 %: ${f.high.join(' ') || '-'}\n  80 %: ${f.other.join(' ') || '-'}\n  tests: ${f.tests.join(' ')}`);
  }
}
if (isMain && process.argv.includes('--summary')) {
  const rows = ['| Feature | Zone | Detected / valid | Score | Survived | No coverage | Target |', '|---|---|---|---|---|---|---|'];
  for (const [name, f] of Object.entries(FEATURES)) {
    const file = `${OUT}/${name}.json`;
    if (!existsSync(file)) {
      rows.push(`| ${name} | | not run | | | | |`);
      continue;
    }
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const root = process.cwd() + '/';
    const zone = (patterns) =>
      Object.entries(report.files).filter(([p]) => patterns.some((x) => matches(p.startsWith(root) ? p.slice(root.length) : p, x))).flatMap(([, v]) => v.mutants);
    for (const [label, patterns, target] of [['high-risk', f.high, 90], ['other', f.other, 80]]) {
      if (patterns.length === 0) continue;
      const s = scoreOf(zone(patterns));
      rows.push(`| ${name} | ${label} | ${s.detected} / ${s.valid} | ${s.score.toFixed(1)} % | ${s.survived} | ${s.noCoverage} | ${target} % |`);
    }
  }
  console.log(rows.join('\n'));
}
