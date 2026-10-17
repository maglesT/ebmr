// Stryker for the Phase 6 TypeScript, one feature per run (decision 0019, part 1). The base settings are those of
// stryker.config.mjs; each feature names the files it mutates, which of them are high-risk (90 %: guards, signatures,
// limits, rounding, flow validation, release and serial gating, stale-mirror refusal, seals; build outline 9.1) and
// the test files that run against its mutants. The other files of a feature target 80 % (display, guidance text, reads
// for a screen, simulators, workers' wiring and retry timing).
//
//   EBMR_STRYKER_FEATURE=<feature> EBMR_PG_ADMIN_URL=<cluster> pnpm exec stryker run stryker.phase6.config.mjs
//   node stryker.phase6.config.mjs --list        the features, their files and tests
//   node stryker.phase6.config.mjs --summary     each finished feature's score per zone, from its JSON report
//
// Options by environment: EBMR_STRYKER_HIGH_RISK_ONLY=1 mutates only the feature's high-risk files (decision 0019: a
// feature that does not finish in an hour runs on those, else it is a residual); EBMR_STRYKER_CONCURRENCY (default 4).
// Each feature keeps its own incremental file, so a run stopped by a restart resumes with what it had (Stryker
// re-tests only mutants without a result for unchanged code and tests); reports and the sandbox are per feature, so
// features can run at the same time (each on its own cluster when its tests use the database).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import base from './stryker.config.mjs';

/** Test kinds: db (kernel template, Vitest `db` set-up), server (tablets-server templates), unit (no database). */
const S = 'apps/tablets-server/src/features';
const T = 'apps/tablets-server/test';

/**
 * @typedef {{ kind: 'db' | 'server' | 'unit', high: string[], other: string[], tests: string[] }} Feature
 * @type {Record<string, Feature>}
 */
export const FEATURES = {
  // ---- Integration SDK, adapters and workers ----
  'sdk-adapter': {
    kind: 'unit',
    high: ['packages/integration-sdk/src/adapter/envelope.ts', 'packages/integration-sdk/src/adapter/errors.ts',
           'packages/integration-sdk/src/adapter/mirror.ts', 'packages/integration-sdk/src/adapter/reconciliation.ts',
           'packages/integration-sdk/src/adapter/systems/*.ts'],
    other: ['packages/integration-sdk/src/adapter/contract.ts'],
    tests: ['packages/integration-sdk/test/adapter/adapter.test.ts'],
  },
  'sdk-equipment-data': {
    kind: 'unit',
    high: ['packages/integration-sdk/src/adapter/equipment-data.ts', 'packages/integration-sdk/src/serialisation/wire.ts'],
    other: ['packages/integration-sdk/src/process/wire.ts'],
    tests: ['packages/integration-sdk/test/adapter/equipment-data.test.ts', 'packages/integration-sdk/test/process/*.test.ts',
            'packages/integration-sdk/test/serialisation/*.test.ts'],
  },
  'gateway-opcua': {
    kind: 'unit',
    high: ['apps/site-gateway/src/drivers/opcua.ts', 'apps/site-gateway/src/opcua-feed.ts'],
    other: ['apps/site-gateway/src/drivers/opcua-node.ts', 'apps/site-gateway/src/process-uplink.ts',
            'apps/site-gateway/src/config.ts', 'apps/site-gateway/src/gateway.ts'],
    tests: ['apps/site-gateway/test/opcua-driver.test.ts', 'apps/site-gateway/test/opcua-driver-shape.test.ts',
            'apps/site-gateway/test/opcua-simulator.test.ts', 'apps/site-gateway/test/gateway.test.ts',
            'apps/site-gateway/test/process.test.ts', 'apps/site-gateway/test/device-config.test.ts'],
  },
  'server-integrations': {
    kind: 'server',
    high: [`${S}/integrations/adapters/framework.ts`, `${S}/integrations/adapters/erp-wms/*.ts`,
           `${S}/integrations/adapters/qms/index.ts`],
    other: [`${S}/integrations/adapters/{cmms,ems,l3,lims,lms,opcua}/index.ts`, `${S}/integrations/adapters/start.ts`,
            `${S}/integrations/index.ts`, `${S}/integrations/reads.ts`, `${S}/integrations/guidance.ts`],
    tests: [`${T}/integrations/**/*.test.ts`, `${T}/equipment-data/opcua-adapter.test.ts`],
  },
  'kernel-config-and-dsc': {
    kind: 'db',
    high: ['packages/kernel/src/config/change-control.ts', 'packages/kernel/src/esig/dsc.ts'],
    other: ['packages/kernel/src/esig/dsc-test-ca.ts'],
    tests: ['packages/kernel/test/config/change-control.test.ts', 'packages/kernel/test/esig/dsc.test.ts'],
  },
  // ---- Server features ----
  'server-alarms': {
    kind: 'server',
    high: [`${S}/alarms/index.ts`],
    other: [`${S}/alarms/reads.ts`, `${S}/alarms/guidance.ts`],
    tests: [`${T}/alarms/*.test.ts`],
  },
  'server-plant-rules': {
    kind: 'server',
    high: [`${S}/plant-rules/index.ts`],
    other: [`${S}/plant-rules/reads.ts`, `${S}/plant-rules/guidance.ts`],
    tests: [`${T}/alarms/plant-displays.test.ts`, `${T}/alarms/area-authorisation-matrix.test.ts`,
            `${T}/integrations/ems/ems-adapter.test.ts`],
  },
  'server-equipment-data': {
    kind: 'server',
    high: [],
    other: [`${S}/equipment-data/index.ts`, `${S}/equipment-data/reads.ts`],
    tests: [`${T}/equipment-data/*.test.ts`, `${T}/alarms/alarm-routes.test.ts`],
  },
  'server-capa': {
    kind: 'server',
    high: [`${S}/capa/index.ts`, `${S}/capa/signables.ts`],
    other: [`${S}/capa/reads.ts`, `${S}/capa/guidance.ts`],
    tests: [`${T}/capa/*.test.ts`],
  },
  'server-config-change': {
    kind: 'server',
    high: [`${S}/config-change/index.ts`, `${S}/config-change/signables.ts`],
    other: [`${S}/config-change/reads.ts`, `${S}/config-change/guidance.ts`],
    tests: [`${T}/config/*.test.ts`],
  },
  'server-controlled': {
    kind: 'server',
    high: [`${S}/controlled/index.ts`],
    other: [`${S}/controlled/reads.ts`],
    tests: [`${T}/controlled/*.test.ts`],
  },
  'server-dashboards-and-training': {
    kind: 'server',
    high: [`${S}/training/index.ts`],
    other: [`${S}/training/exercises.ts`, `${S}/dashboards/index.ts`, `${S}/dashboards/reads.ts`, `${S}/dashboards/guidance.ts`],
    tests: [`${T}/dashboards/*.test.ts`],
  },
  'server-designer-hazard': {
    kind: 'server',
    high: [`${S}/designer/hazard.ts`],
    other: [],
    tests: [`${T}/designer/hazard-containment.test.ts`, `${T}/designer/references.test.ts`],
  },
  'server-genealogy': {
    kind: 'server',
    high: [`${S}/genealogy/index.ts`, `${S}/genealogy/signables.ts`],
    other: [`${S}/genealogy/reads.ts`, `${S}/genealogy/guidance.ts`],
    tests: [`${T}/genealogy/*.test.ts`],
  },
  'server-governance': {
    kind: 'server',
    high: [`${S}/governance/index.ts`, `${S}/esig/dsc.ts`],
    other: [],
    tests: [`${T}/governance/*.test.ts`],
  },
  'server-labels': {
    kind: 'server',
    high: [`${S}/labels/index.ts`],
    other: [],
    tests: [`${T}/labels/*.test.ts`, `${T}/blocks/packaging/line-completion.test.ts`, `${T}/blocks/packaging/completion.test.ts`],
  },
  'server-quality-receipt': {
    kind: 'server',
    high: [`${S}/quality/receipt.ts`],
    other: [`${S}/quality/lims.ts`],
    tests: [`${T}/quality/*.test.ts`],
  },
  'server-serialisation': {
    kind: 'server',
    high: [`${S}/serialisation/index.ts`],
    other: [],
    tests: [`${T}/integrations/l3-adapter.test.ts`],
  },
  'server-transfers': {
    kind: 'server',
    high: [`${S}/transfers/federation.ts`, `${S}/transfers/index.ts`, `${S}/transfers/keys.ts`, `${S}/transfers/signables.ts`],
    other: [`${S}/transfers/reads.ts`, `${S}/transfers/guidance.ts`],
    tests: [`${T}/transfers/*.test.ts`],
  },
  // ---- Part 2 (decision 0019): the Phase 4 server features whose Stryker survivors decision 0012 left to deployment.
  //      Their Phase 4 reports were lost with that container, so they run again here, high-risk files first. ----
  'p4-server-release': {
    kind: 'server',
    high: [`${S}/release/index.ts`, `${S}/release/after-release.ts`, `${S}/release/signables.ts`],
    other: [`${S}/release/reads.ts`],
    tests: [`${T}/release/*.test.ts`],
  },
  'p4-server-records': {
    kind: 'server',
    high: [`${S}/records/index.ts`, `${S}/records/signables.ts`, `${S}/archive/index.ts`],
    other: [`${S}/records/reads.ts`, `${S}/archive/facts.ts`],
    tests: [`${T}/records/*.test.ts`],
  },
  'p4-server-india': {
    kind: 'server',
    high: [`${S}/india/index.ts`],
    other: [],
    tests: [`${T}/india/*.test.ts`],
  },
  'p4-server-pqr': {
    kind: 'server',
    high: [`${S}/pqr/index.ts`, `${S}/pqr/signables.ts`],
    other: [`${S}/pqr/reads.ts`],
    tests: [`${T}/pqr/*.test.ts`],
  },
  // ---- Simulators: the behaviour the adapter, gateway and golden-batch tests rely on (80 %) ----
  simulators: {
    kind: 'unit',
    high: [],
    other: ['apps/simulators/src/opcua/server.ts', 'apps/simulators/src/erp/{feed,model,server}.ts',
            'apps/simulators/src/system-feed/{feed,plugin,server}.ts', 'apps/simulators/src/serialisation/{model,server}.ts',
            'apps/simulators/src/{wms,qms,ems,cmms,lims,lms}/model.ts'],
    tests: ['apps/simulators/test/{opcua,erp,erp-wms,system-feed,serialisation,ems}/*.test.ts'],
  },
};

const OUT = '.reports/stryker-phase6';

/** The Stryker options of one feature (exported for the --list check). */
export function featureOptions(name, highRiskOnly = false) {
  const f = FEATURES[name];
  if (!f) throw new Error(`EBMR_STRYKER_FEATURE names no feature: ${name}; one of ${Object.keys(FEATURES).join(', ')}`);
  return {
    ...base,
    vitest: { configFile: 'vitest.stryker-phase6.config.ts', related: false },
    mutate: highRiskOnly ? f.high : [...f.high, ...f.other],
    // A unit feature's whole test set runs in about a second, so its static mutants (module-level schemas and tables,
    // such as the SDK's zod contracts) are tested too; a database feature keeps the base setting (each static mutant
    // would rebuild the templates).
    ignoreStatic: f.kind !== 'unit',
    incremental: true,
    incrementalFile: `${OUT}/${name}.incremental.json`,
    concurrency: Number(process.env['EBMR_STRYKER_CONCURRENCY'] ?? '4'),
    // The server set-up builds two seeded templates in each worker before its first test.
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
  // The Vitest config (vitest.stryker-phase6.config.ts) reads the feature's tests from here; Stryker's workers inherit
  // the environment of this process.
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
