/**
 * What the generators derive from the bundle, the same way in every document (Phase 7 slice 7c): a test's verdict
 * across the runs, whether a test exercises the database, the user-requirement ids, and the risk rules of the risk
 * assessment (in the manner of ICH Q9(R1): severity, probability and detectability give a risk class and the test
 * rigour it calls for). The rules are data here, printed in the risk assessment, so the customer can review them.
 */
import { compareText } from '../bundle/validate.ts';
import type { Bundle, Control, Result } from '../bundle/types.ts';

export type Verdict = 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT RUN';

/** The verdict of each test the bundle reports, across its runs: FAILED if any run failed it, PASSED if any passed. */
export function verdicts(b: Bundle): Map<string, { verdict: Verdict; runs: string[] }> {
  const byTest = new Map<string, Result[]>();
  for (const r of b.results) {
    const list = byTest.get(r.test) ?? [];
    list.push(r);
    byTest.set(r.test, list);
  }
  const out = new Map<string, { verdict: Verdict; runs: string[] }>();
  for (const [test, rs] of byTest) {
    const verdict: Verdict = rs.some((r) => r.status === 'failed') ? 'FAILED' : rs.some((r) => r.status === 'passed') ? 'PASSED' : 'SKIPPED';
    out.set(test, { verdict, runs: rs.map((r) => r.run).sort(compareText) });
  }
  return out;
}

export function verdictOf(v: ReturnType<typeof verdicts>, test: string): { verdict: Verdict; runs: string[] } {
  return v.get(test) ?? { verdict: 'NOT RUN', runs: [] };
}

/**
 * A test that exercises the database's own enforcement, known by where it lives, never by the words of its title: a
 * test of a package whose tests run against PostgreSQL (kernel, site services, recipe core), a server database-guard
 * test (a file whose name starts db-guards), a test of the SQL mutation groups (apps/<app>/test/mutation/, written
 * against the database functions with the database-guard support), or a drill run on a real database
 * (tools/drills/test/). The register's core controls need one (D-P7-2).
 */
export const DATABASE_TEST_RULE =
  "a test under packages/kernel/test, packages/site-services/test or packages/recipe-core/test, a server test whose file name starts db-guards, a test under apps/<app>/test/mutation/ (the SQL mutation groups), or a drill test under tools/drills/test/ (run on a real database); a test's title does not make it one";
export function isDatabaseTest(test: string): boolean {
  const file = test.split(' > ')[0] ?? '';
  if (/^packages\/(kernel|site-services|recipe-core)\/test\//.test(file)) return true;
  if (/^apps\/[^/]+\/test\/(.*\/)?db-guards[^/]*\.test\.ts$/.test(file)) return true;
  if (/^apps\/[^/]+\/test\/mutation\/[^/]+\.test\.ts$/.test(file)) return true;
  return /^tools\/drills\/test\/[^/]+\.test\.ts$/.test(file);
}

/** The user-requirement id of a control. */
export const urOf = (controlId: string): string => `UR-${controlId}`;

/** Every listed test of a control (its clauses' tests), sorted, once each. */
export function listedTests(c: Control): string[] {
  return [...new Set(c.clauses.flatMap((k) => k.tests))].sort(compareText);
}

export const isDeferred = (c: Control): boolean => c.clauses.some((k) => k.deferred !== undefined) || c.deferredScope.length > 0;

// ---------------------------------------------------------------------------------------------------------------
// Risk rules
// ---------------------------------------------------------------------------------------------------------------

export type Level = 'high' | 'medium' | 'low';

export interface RiskAssessment {
  control: string;
  harm: string;
  severity: Level;
  probability: Level;
  detectability: Level;
  riskClass: Level;
  rigour: string;
  databaseEnforced: boolean;
}

/** The high-risk functions of build outline 9.2: a control naming one of them is of high severity. */
export const HIGH_RISK_FUNCTIONS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'limit checks', pattern: /\blimits?\b|out[- ]of[- ](range|limit|specification)|\bOOS\b|\btolerance/i },
  { name: 'calculations', pattern: /\bcalculat|\byield\b|\brounding\b|\bformula\b/i },
  { name: 'signature binding', pattern: /\bsignature|\be-?sign/i },
  { name: 'status and release interlocks', pattern: /\binterlock|\brelease\b|\bstatus\b|\bdisposition|\bquarantine/i },
  { name: 'exception reports', pattern: /\bexception|\bdeviation/i },
  { name: 'automated checks replacing a human check', pattern: /\bautomat|\binstead of a (human|person)|\bverif(y|ies|ication) by the system/i },
  { name: 'audit trail', pattern: /\baudit trail|\baudit\b/i },
];

export const RISK_RULES: readonly string[] = [
  'Severity (harm to the patient or to record integrity if the requirement fails): high for a core-class control (decision 0008 section 2: audit trail, e-signatures, access and segregation, record integrity, trusted time, status and release interlocks, limits and calculations, market resolution) or one that names a high-risk function of build outline 9.2 (limit checks, calculations, signature binding, status and release interlocks, exception reports, automated checks replacing a human check, audit trail); medium for another control of type ENFORCED; low otherwise.',
  `Probability (that a defect reaches GMP use unnoticed): low when the database enforces the requirement (a core-class control with a database test among its tests: ${DATABASE_TEST_RULE}); medium when only application code enforces it; high when nothing is listed yet (a deferred clause or no listed test).`,
  'Detectability (that a failure would be seen): high when every listed test passed in the bundle\'s runs; medium when some did not run; low when one failed or none is listed.',
  'Risk class: high when the severity is high and either the probability is not low or the detectability is not high; medium when the severity is high (otherwise), or the severity is medium and the probability or detectability is not the best; low otherwise.',
  'Test rigour by risk class: high, positive, negative and boundary tests, a database guard or bypass test and a review pass; medium, positive and negative tests; low, a positive test. The customer may raise the rigour of any requirement for its configured use.',
];

const RIGOUR: Record<Level, string> = {
  high: 'positive, negative and boundary tests, a database guard or bypass test, a review pass',
  medium: 'positive and negative tests',
  low: 'a positive test',
};

export function assessRisk(c: Control, v: ReturnType<typeof verdicts>): RiskAssessment {
  const text = `${c.title} ${c.behaviour} ${c.catalogTest}`;
  const functions = HIGH_RISK_FUNCTIONS.filter((f) => f.pattern.test(text)).map((f) => f.name);
  const tests = listedTests(c);
  const databaseEnforced = c.class === 'core' && tests.some(isDatabaseTest);
  const severity: Level = c.class === 'core' || functions.length > 0 ? 'high' : c.type.includes('ENFORCED') ? 'medium' : 'low';
  const probability: Level = tests.length === 0 || isDeferred(c) ? 'high' : databaseEnforced ? 'low' : 'medium';
  const states = tests.map((t) => verdictOf(v, t).verdict);
  const detectability: Level = tests.length === 0 || states.includes('FAILED') ? 'low' : states.every((s) => s === 'PASSED') ? 'high' : 'medium';
  const riskClass: Level =
    severity === 'high' && (probability !== 'low' || detectability !== 'high')
      ? 'high'
      : severity === 'high' || (severity === 'medium' && (probability !== 'low' || detectability !== 'high'))
        ? 'medium'
        : 'low';
  const harm = [
    c.class === 'core' ? 'a regulation-required core control fails' : 'a supporting control fails',
    functions.length > 0 ? `in a high-risk function (${functions.join(', ')})` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' ');
  return { control: c.id, harm, severity, probability, detectability, riskClass, rigour: RIGOUR[riskClass], databaseEnforced };
}
