/**
 * The evidence bundle v1 (Phase 7 slice 7-0; docs/build-plan/phase-7/slice-7-0-interfaces.md section 1; D-P7-0-6):
 * the schema, the hand-written types beside it, the reader's refusals and the canonical form the bundle hash is taken
 * over.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import example from '../fixtures/example-bundle.json' with { type: 'json' };
import {
  BUNDLE_SCHEMA,
  BUNDLE_SORT_KEYS,
  BundleError,
  bundleSha256,
  canonicalJson,
  compareText,
  parseBundle,
  type Analytics,
  type AnalyticsMethod,
  type Bundle,
  type Clause,
  type ClauseTraceStatus,
  type Control,
  type ControlClass,
  type CriticalLimit,
  type Deferral,
  type DeferredScope,
  type Edition,
  type ExpertDecision,
  type FindingCounts,
  type Host,
  type InvAuditedTable,
  type InvBlock,
  type InvConstraint,
  type Inventory,
  type InvFunction,
  type InvMeaning,
  type InvMessage,
  type InvMigration,
  type InvPermission,
  type InvPrivilege,
  type InvRole,
  type InvRoute,
  type InvRuleKey,
  type InvSetting,
  type InvStateChart,
  type InvTransition,
  type InvTrigger,
  type KnownIssue,
  type Measure,
  type OpenFinding,
  type OpenFixed,
  type PhaseRecord,
  type RecordKind,
  type Register,
  type Release,
  type Requirement,
  type Result,
  type ResultStatus,
  type Review,
  type Run,
  type RunKind,
  type Sbom,
  type Severity,
  type Trace,
  type TraceClause,
  type TraceControl,
} from '../src/index.ts';

// --- Types against schema -----------------------------------------------------------------------------------------

/** The keys of T that are not optional. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
/** Every property of T and its required ones, as object literals the compiler checks exactly (no key missing, no extra). */
interface Shape<T> {
  all: Record<keyof T, true>;
  required: Record<RequiredKeys<T>, true>;
}
function shape<T>(s: Shape<T>): { all: string[]; required: string[] } {
  return { all: Object.keys(s.all).sort(), required: Object.keys(s.required).sort() };
}
/** The members of a string union, checked exactly by the compiler. */
function members<T extends string>(m: Record<T, true>): string[] {
  return Object.keys(m).sort();
}

const SHAPES: Record<string, { all: string[]; required: string[] }> = {
  '#': shape<Bundle>({
    all: { bundleVersion: true, edition: true, release: true, register: true, runs: true, results: true, trace: true, inventory: true, criticalLimits: true, reviews: true, openFindings: true, analytics: true, records: true, sbom: true, knownIssues: true },
    required: { bundleVersion: true, edition: true, release: true, register: true, runs: true, results: true, trace: true, inventory: true, criticalLimits: true, reviews: true, openFindings: true, analytics: true, records: true, sbom: true, knownIssues: true },
  }),
  Release: shape<Release>({
    all: { product: true, maker: true, version: true, commit: true, commitTime: true, schemaRelease: true },
    required: { product: true, maker: true, version: true, commit: true, commitTime: true, schemaRelease: true },
  }),
  Register: shape<Register>({ all: { controls: true, requirements: true }, required: { controls: true, requirements: true } }),
  Control: shape<Control>({
    all: { id: true, title: true, editions: true, type: true, targetPhase: true, sources: true, behaviour: true, catalogTest: true, requirementRows: true, implementedBy: true, clauses: true, deferredScope: true, expertDecision: true, buildStatus: true, draft: true, class: true },
    required: { id: true, title: true, editions: true, type: true, targetPhase: true, sources: true, behaviour: true, catalogTest: true, requirementRows: true, implementedBy: true, clauses: true, deferredScope: true, expertDecision: true, buildStatus: true, draft: true, class: true },
  }),
  Clause: shape<Clause>({ all: { clause: true, tests: true, deferred: true }, required: { clause: true, tests: true } }),
  Deferral: shape<Deferral>({ all: { phase: true, reason: true }, required: { phase: true, reason: true } }),
  DeferredScope: shape<DeferredScope>({ all: { scope: true, phase: true, reason: true }, required: { scope: true, phase: true, reason: true } }),
  ExpertDecision: shape<ExpertDecision>({ all: { status: true, reviewer: true, date: true, packVersion: true }, required: { status: true, reviewer: true, date: true, packVersion: true } }),
  Requirement: shape<Requirement>({ all: { n: true, source: true, verification: true, paraphrase: true }, required: { n: true, source: true, verification: true, paraphrase: true } }),
  Run: shape<Run>({
    all: { id: true, kind: true, commit: true, startedAt: true, finishedAt: true, reportFile: true, reportSha256: true, host: true },
    required: { id: true, kind: true, commit: true, startedAt: true, finishedAt: true, reportFile: true, reportSha256: true, host: true },
  }),
  Host: shape<Host>({ all: { cpu: true, memory: true, os: true, node: true, postgres: true }, required: { cpu: true, memory: true, os: true, node: true, postgres: true } }),
  Result: shape<Result>({
    all: { test: true, run: true, status: true, durationMs: true, controls: true, evidence: true },
    required: { test: true, run: true, status: true, durationMs: true, controls: true },
  }),
  Trace: shape<Trace>({ all: { phase: true, editions: true, ok: true, controls: true }, required: { phase: true, editions: true, ok: true, controls: true } }),
  TraceControl: shape<TraceControl>({ all: { control: true, passing: true, clauses: true }, required: { control: true, passing: true, clauses: true } }),
  TraceClause: shape<TraceClause>({ all: { clause: true, status: true }, required: { clause: true, status: true } }),
  Inventory: shape<Inventory>({
    all: { migrations: true, functions: true, triggers: true, constraints: true, privileges: true, roles: true, settings: true, auditedTables: true, permissions: true, meanings: true, messages: true, stateCharts: true, blocks: true, ruleKeys: true, routes: true },
    required: { migrations: true, functions: true, triggers: true, constraints: true, privileges: true, roles: true, settings: true, auditedTables: true, permissions: true, meanings: true, messages: true, stateCharts: true, blocks: true, ruleKeys: true, routes: true },
  }),
  InvMigration: shape<InvMigration>({ all: { namespace: true, name: true, sha256: true }, required: { namespace: true, name: true, sha256: true } }),
  InvFunction: shape<InvFunction>({
    all: { schema: true, name: true, argTypes: true, securityDefiner: true, owner: true, executeRoles: true },
    required: { schema: true, name: true, argTypes: true, securityDefiner: true, owner: true, executeRoles: true },
  }),
  InvTrigger: shape<InvTrigger>({ all: { table: true, name: true, enabled: true, function: true }, required: { table: true, name: true, enabled: true, function: true } }),
  InvConstraint: shape<InvConstraint>({ all: { table: true, name: true, kind: true, definitionSha256: true }, required: { table: true, name: true, kind: true, definitionSha256: true } }),
  InvPrivilege: shape<InvPrivilege>({ all: { role: true, object: true, privilege: true }, required: { role: true, object: true, privilege: true } }),
  InvRole: shape<InvRole>({
    all: { name: true, login: true, superuser: true, createRole: true, bypassRls: true, inherit: true, connectionLimit: true },
    required: { name: true, login: true, superuser: true, createRole: true, bypassRls: true, inherit: true, connectionLimit: true },
  }),
  InvSetting: shape<InvSetting>({ all: { name: true, value: true, expected: true }, required: { name: true, value: true, expected: true } }),
  InvAuditedTable: shape<InvAuditedTable>({ all: { table: true }, required: { table: true } }),
  InvPermission: shape<InvPermission>({ all: { permission: true, roles: true, scopeKinds: true }, required: { permission: true, roles: true, scopeKinds: true } }),
  InvMeaning: shape<InvMeaning>({ all: { meaning: true }, required: { meaning: true } }),
  InvMessage: shape<InvMessage>({ all: { code: true, text: true, sourceFile: true }, required: { code: true, text: true, sourceFile: true } }),
  InvStateChart: shape<InvStateChart>({ all: { machine: true, states: true, transitions: true }, required: { machine: true, states: true, transitions: true } }),
  InvTransition: shape<InvTransition>({ all: { from: true, event: true, to: true }, required: { from: true, event: true, to: true } }),
  InvBlock: shape<InvBlock>({ all: { blockType: true, version: true, controls: true }, required: { blockType: true, version: true, controls: true } }),
  InvRuleKey: shape<InvRuleKey>({ all: { key: true }, required: { key: true } }),
  InvRoute: shape<InvRoute>({ all: { namespace: true, route: true, method: true, permission: true }, required: { namespace: true, route: true, method: true, permission: true } }),
  CriticalLimit: shape<CriticalLimit>({ all: { key: true, description: true, controls: true, boundaryTests: true }, required: { key: true, description: true, controls: true, boundaryTests: true } }),
  Review: shape<Review>({ all: { id: true, date: true, scope: true, findings: true }, required: { id: true, date: true, scope: true, findings: true } }),
  FindingCounts: shape<FindingCounts>({ all: { critical: true, high: true, medium: true, low: true }, required: { critical: true, high: true, medium: true, low: true } }),
  OpenFixed: shape<OpenFixed>({ all: { open: true, fixed: true }, required: { open: true, fixed: true } }),
  OpenFinding: shape<OpenFinding>({ all: { id: true, severity: true, controls: true, summary: true, source: true }, required: { id: true, severity: true, controls: true, summary: true, source: true } }),
  Analytics: shape<Analytics>({ all: { methods: true }, required: { methods: true } }),
  AnalyticsMethod: shape<AnalyticsMethod>({ all: { id: true, versions: true, intendedUse: true, changesGmpData: true }, required: { id: true, versions: true, intendedUse: true, changesGmpData: true } }),
  PhaseRecord: shape<PhaseRecord>({ all: { kind: true, file: true, sha256: true, passed: true, summary: true, measures: true }, required: { kind: true, file: true, sha256: true, passed: true, summary: true, measures: true } }),
  Measure: shape<Measure>({ all: { name: true, value: true, unit: true, limit: true }, required: { name: true, value: true, unit: true, limit: true } }),
  Sbom: shape<Sbom>({ all: { file: true, sha256: true, format: true }, required: { file: true, sha256: true, format: true } }),
  KnownIssue: shape<KnownIssue>({ all: { id: true, severity: true, controls: true, text: true }, required: { id: true, severity: true, controls: true, text: true } }),
};

/** Enums of the schema (a $defs name, or a property of a definition) and the union type that matches each. */
const ENUMS: [string, string[]][] = [
  ['Edition', members<Edition>({ tablets: true, injectables: true, substance: true })],
  ['Severity', members<Severity>({ critical: true, high: true, medium: true, low: true })],
  ['Run.kind', members<RunKind>({ vitest: true, golden: true, playwright: true, load: true, drill: true, security: true, accessibility: true, mutation: true })],
  ['Result.status', members<ResultStatus>({ passed: true, failed: true, skipped: true })],
  ['TraceClause.status', members<ClauseTraceStatus>({ PROVEN: true, DEFERRED: true, MISSING: true })],
  ['Control.class', members<ControlClass>({ core: true, other: true })],
  ['PhaseRecord.kind', members<RecordKind>({ load: true, soak: true, restore: true, upgrade: true, 'migration-dry-run': true, security: true, accessibility: true, mutation: true, iq: true, oq: true })],
];

interface SchemaDef {
  type?: string;
  enum?: string[];
  properties?: Record<string, SchemaDef>;
  required?: string[];
  items?: { $ref?: string };
}
const DEFS = (BUNDLE_SCHEMA as { $defs: Record<string, SchemaDef> }).$defs;
function def(name: string): SchemaDef {
  if (name === '#') return BUNDLE_SCHEMA;
  const [d, prop] = name.split('.');
  const found = prop === undefined ? DEFS[d ?? ''] : DEFS[d ?? '']?.properties?.[prop];
  if (found === undefined) throw new Error(`no schema definition ${name}`);
  return found;
}

// --- Helpers --------------------------------------------------------------------------------------------------------

function fresh(): Bundle {
  return structuredClone(example) as unknown as Bundle;
}
function codeOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof BundleError) return e.code;
    throw e;
  }
  return undefined;
}
function listAt(root: unknown, path: string): unknown[] {
  let cur = root;
  for (const p of path.split('.')) cur = (cur as Record<string, unknown>)[p];
  if (!Array.isArray(cur)) throw new Error(`${path} is not an array`);
  return cur as unknown[];
}
/** The same value with every object's keys in reverse order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  }
  return v;
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('the evidence bundle v1 schema and types', () => {
  it('[meta] the example bundle parses against the v1 schema and its sort table', () => {
    const b = parseBundle(fresh());
    expect(b.bundleVersion).toBe(1);
    expect(b.register.controls.map((c) => c.id)).toEqual(['DI-31', 'IN-12', 'PR-61']);
    expect(b.register.controls.map((c) => c.class)).toEqual(['core', 'other', 'core']);
    expect(b.trace.controls.flatMap((c) => c.clauses.map((k) => k.status))).toEqual(['PROVEN', 'PROVEN', 'MISSING', 'DEFERRED']);
  });

  it('[meta] the TypeScript types name exactly the fields, required keys and enum members of the schema', () => {
    for (const [name, s] of Object.entries(SHAPES)) {
      const d = def(name);
      expect(Object.keys(d.properties ?? {}).sort(), `${name} properties`).toEqual(s.all);
      expect([...(d.required ?? [])].sort(), `${name} required`).toEqual(s.required);
    }
    const objectDefs = Object.entries(DEFS).filter(([, d]) => d.type === 'object' && d.properties !== undefined).map(([n]) => n).sort();
    expect(objectDefs, 'every object definition of the schema has a type here').toEqual(Object.keys(SHAPES).filter((n) => n !== '#').sort());
    for (const [name, m] of ENUMS) expect([...(def(name).enum ?? [])].sort(), name).toEqual(m);
  });

  it('[meta] every array of records in the schema is in the sort table, and every entry of the table is an array', () => {
    const b = fresh();
    for (const { path } of BUNDLE_SORT_KEYS) expect(Array.isArray(listAt(b, path)), path).toBe(true);
    // Every array of objects at the top level and in the register, trace, analytics and inventory is in the table.
    const listed = new Set(BUNDLE_SORT_KEYS.map((k) => k.path));
    const ofObjects = (p: SchemaDef): boolean => p.type === 'array' && DEFS[(p.items?.$ref ?? '').replace('#/$defs/', '')]?.type === 'object';
    const arrays = (prefix: string, d: SchemaDef): string[] =>
      Object.entries(d.properties ?? {})
        .filter(([, p]) => ofObjects(p))
        .map(([k]) => `${prefix}${k}`);
    const expected = [...arrays('', def('#')), ...arrays('register.', def('Register')), ...arrays('trace.', def('Trace')), ...arrays('analytics.', def('Analytics')), ...arrays('inventory.', def('Inventory'))];
    expect(expected.length).toBe(BUNDLE_SORT_KEYS.length);
    expect(expected.filter((p) => !listed.has(p))).toEqual([]);
  });
});

describe('parseBundle refusals (D-P7-0-6)', () => {
  it('[meta] a bundle of an unknown or missing version is refused with EBMR-VAL-002', () => {
    for (const v of [2, 0, '1', 1.5, null]) {
      const b = fresh() as unknown as Record<string, unknown>;
      b['bundleVersion'] = v;
      expect(codeOf(() => parseBundle(b)), JSON.stringify(v)).toBe('EBMR-VAL-002');
    }
    const b = fresh() as unknown as Record<string, unknown>;
    delete b['bundleVersion'];
    expect(codeOf(() => parseBundle(b))).toBe('EBMR-VAL-002');
    expect(() => parseBundle({ ...fresh(), bundleVersion: 2 })).toThrow(/EBMR-VAL-002: \$\.bundleVersion: the number 2 is not a bundle version this kit knows/);
  });

  it('[meta] a missing required field, an unknown field or an ill-formed value is refused with EBMR-VAL-007', () => {
    const cases: [string, (b: Bundle) => void][] = [
      ['no release', (b) => delete (b as Partial<Bundle>).release],
      ['no control class', (b) => delete (b.register.controls[0] as Partial<Control>).class],
      ['no clause tests', (b) => delete (b.register.controls[0]?.clauses[0] as Partial<Clause>).tests],
      ['no run host', (b) => delete (b.runs[0] as Partial<Run>).host],
      ['no inventory roles', (b) => delete (b.inventory as Partial<Inventory>).roles],
      ['an unknown top-level field', (b) => ((b as unknown as Record<string, unknown>)['builtAt'] = '2026-10-17T00:00:00Z')],
      ['an unknown control field', (b) => ((b.register.controls[0] as unknown as Record<string, unknown>)['notes'] = 'x')],
      ['an unknown run kind', (b) => ((b.runs[0] as unknown as Record<string, unknown>)['kind'] = 'jest')],
      ['an unknown result status', (b) => ((b.results[0] as unknown as Record<string, unknown>)['status'] = 'flaky')],
      ['an unknown clause status', (b) => ((b.trace.controls[0]?.clauses[0] as unknown as Record<string, unknown>)['status'] = 'TESTED')],
      ['an unknown control class', (b) => ((b.register.controls[0] as unknown as Record<string, unknown>)['class'] = 'minor')],
      ['an unknown edition', (b) => ((b as unknown as Record<string, unknown>)['edition'] = 'capsules')],
      ['an upper-case commit', (b) => (b.release.commit = b.release.commit.toUpperCase())],
      ['a short hash', (b) => (b.sbom.sha256 = 'abc')],
      ['a local time', (b) => (b.release.commitTime = '2026-10-17T09:30:00+05:30')],
      ['a negative duration', (b) => ((b.results[0] as Result).durationMs = -1)],
      ['a non-integer requirement row', (b) => ((b.register.requirements[0] as Requirement).n = 8.5)],
      ['an empty title', (b) => ((b.register.controls[0] as Control).title = '')],
      ['a measure as a JSON number', (b) => ((b.records[0]?.measures[0] as unknown as Record<string, unknown>)['value'] = 412.5)],
      ['another SBOM format', (b) => ((b.sbom as unknown as Record<string, unknown>)['format'] = 'SPDX 2.3')],
      ['an array that is not one', (b) => ((b as unknown as Record<string, unknown>)['runs'] = {})],
    ];
    for (const [what, change] of cases) {
      const b = fresh();
      change(b);
      expect(codeOf(() => parseBundle(b)), what).toBe('EBMR-VAL-007');
    }
    expect(codeOf(() => parseBundle(null))).toBe('EBMR-VAL-007');
    expect(codeOf(() => parseBundle([fresh()]))).toBe('EBMR-VAL-007');
  });

  it('[meta] the optional fields (a clause deferral, a result evidence) may be left out', () => {
    const b = fresh();
    for (const c of b.register.controls) for (const k of c.clauses) delete k.deferred;
    for (const r of b.results) delete r.evidence;
    expect(() => parseBundle(b)).not.toThrow();
  });

  it('[meta] every array of the sort table refuses an item out of order or a repeated key with EBMR-VAL-008', () => {
    for (const { path } of BUNDLE_SORT_KEYS) {
      const swapped = fresh();
      const list = listAt(swapped, path);
      if (list.length >= 2) {
        [list[0], list[1]] = [list[1], list[0]];
        expect(codeOf(() => parseBundle(swapped)), `${path} swapped`).toBe('EBMR-VAL-008');
      }
      const repeated = fresh();
      const r = listAt(repeated, path);
      r.splice(1, 0, structuredClone(r[0]));
      expect(codeOf(() => parseBundle(repeated)), `${path} repeated`).toBe('EBMR-VAL-008');
    }
    // The second key orders the results of one test: golden-1 before vitest-1.
    const b = fresh();
    const [a, c] = [b.results[0] as Result, b.results[1] as Result];
    [a.run, c.run] = [c.run, a.run];
    expect(() => parseBundle(b)).toThrow(/EBMR-VAL-008: results\[1\]: out of order by test, run/);
  });

  it('[meta] the sort order is by Unicode code point, not by locale or UTF-16 unit', () => {
    expect(compareText('B', 'a')).toBeLessThan(0);
    expect(compareText('a', 'B')).toBeGreaterThan(0);
    expect(compareText('ab', 'a')).toBeGreaterThan(0);
    expect(compareText('a', 'ab')).toBeLessThan(0);
    expect(compareText('same', 'same')).toBe(0);
    // U+FFFF sorts before U+1F600, although its UTF-16 unit is larger than the surrogate 0xD83D.
    expect(compareText('￿', '\u{1F600}')).toBeLessThan(0);
    expect(['\u{1F600}', '￿', 'z'].sort(compareText)).toEqual(['z', '￿', '\u{1F600}']);
  });
});

describe('canonical JSON and the bundle hash', () => {
  it('[meta] the bundle canonical JSON and SHA-256 are the same for the same content whatever its key order (determinism)', () => {
    const b = parseBundle(fresh());
    const text = canonicalJson(b);
    expect(canonicalJson(reverseKeys(b))).toBe(text);
    expect(bundleSha256(parseBundle(reverseKeys(fresh())))).toBe(bundleSha256(b));
    expect(bundleSha256(b)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(bundleSha256(b)).toMatch(/^[0-9a-f]{64}$/);
    // The canonical text parses back to a bundle with the same canonical text, and holds no whitespace outside strings.
    expect(canonicalJson(parseBundle(JSON.parse(text)))).toBe(text);
    expect(canonicalJson(JSON.parse(JSON.stringify(b, null, 2)))).toBe(text);
    // A change of content changes the hash.
    const changed = fresh();
    changed.release.version = '1.0.0-rc.2';
    expect(bundleSha256(parseBundle(changed))).not.toBe(bundleSha256(b));
  });

  it('[meta] canonical JSON sorts keys, writes no whitespace and refuses what JSON cannot hold', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x y' }, true], e: undefined })).toBe('{"a":[{"c":"x y","d":null},true],"b":1}');
    expect(canonicalJson({ é: 1, z: 2, Z: 3 })).toBe('{"Z":3,"z":2,"é":1}');
    expect(canonicalJson('line\nbreak "quoted"')).toBe('"line\\nbreak \\"quoted\\""');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1n, [undefined], new Date(0), () => 1, Symbol('s')]) {
      expect(() => canonicalJson(bad), String(typeof bad)).toThrow(TypeError);
    }
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
    // A shared (not circular) object is written twice, like JSON.stringify.
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});
