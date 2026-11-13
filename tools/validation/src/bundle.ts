/**
 * The evidence bundle builder (Phase 7 slice 7c; interfaces section 1; `pnpm validation:bundle`): the register and
 * its requirement rows, the trace of the run, the test reports, the inventory of a migrated database (read-only), the
 * files of compliance/validation/, the analytics method registry, the Phase 7 records, the SBOM and the known issues,
 * in one JSON file the generators read. Every array sorted by its key (compareText), no field from the clock: the same
 * inputs give the same bytes. The bundle is checked with the kit's parseBundle before it is written.
 *
 * Each control's build status in the bundle is the one its own evidence supports (R3-VAL-3): the status D-P7-2 gives
 * from this bundle (computeStatus), never above the register's (register:status is the only writer of VERIFIED). A
 * stored VERIFIED the bundle does not support is lowered, so the pack never prints a status its evidence lacks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type pg from 'pg';
import { catalogMethods } from '../../../apps/tablets-server/src/analytics/catalog.ts';
import { canonicalJson, compareText, hostOfThisMachine, parseBundle, type Bundle, type Control, type Host, type Measure, type PhaseRecord, type RecordKind } from '@ebmr/validation-kit';
import { computeStatus, statusContext, type BuildStatus } from '../../register/src/build-status.ts';
import { currentPhase, gateEditions, loadControls, loadRequirements, type ControlRecord } from '../../register/src/register.ts';
import { buildTrace, readPlaywrightResults, readVitestResults } from '../../register/src/trace.ts';
import { controlClass, loadValidationFiles } from '../../register/src/validation-files.ts';
import { inventory } from './inventory.ts';
import { reportsIn, readRuns } from './reports.ts';
import { commitOf, productVersion, ROOT, schemaReleaseOfFiles, sha256 } from './sources.ts';

export const PRODUCT = { tablets: 'Batchwright Tablets', injectables: 'Batchwright Injectables' } as const;
export const MAKER = 'Medhanta';

export interface BundleInputs {
  /** The directory of the test reports (vitest.json, vitest-golden.json, playwright.json). */
  resultsDir: string;
  /** A read-only connection to a database migrated to the release. */
  db: pg.ClientBase;
  /** The directory of the Phase 7 records (*.json, each {kind, passed, summary, measures}); optional. */
  recordsDir?: string;
  /** The SBOM file (CycloneDX 1.5 JSON), path from the repository root. */
  sbomFile: string;
  commit?: { commit: string; commitTime: string };
  version?: string;
  host?: Host;
  /** Settings the release fixes (default LOCKED_SETTINGS); a test cluster passes its own. */
  lockedSettings?: Readonly<Record<string, string>>;
}

/** The machine the bundle is built on (a run's host when its report carries none): the kit's, which the IQ uses too. */
export { hostOfThisMachine };

const dateOrNull = (d: string | undefined): string | null => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

function controlOf(c: ControlRecord, cls: 'core' | 'other'): Control {
  return {
    id: c.id,
    title: c.title,
    editions: [...c.editions],
    type: [...c.type],
    targetPhase: c.target_phase,
    sources: c.sources || '(none)',
    behaviour: c.behaviour || '(none)',
    catalogTest: c.catalog_test || '(none)',
    requirementRows: [...c.requirement_rows],
    implementedBy: Object.fromEntries(Object.entries(c.implemented_by).sort(([a], [b]) => compareText(a, b))),
    clauses: (c.clauses ?? []).map((k) => ({ clause: k.clause, tests: [...(k.tests ?? [])], ...(k.deferred ? { deferred: { phase: k.deferred.phase, reason: k.deferred.reason } } : {}), ...(k.not_required ? { notRequired: { decision: k.not_required.decision, reason: k.not_required.reason } } : {}) })),
    deferredScope: (c.deferred_scope ?? []).map((d) => ({ scope: d.scope, phase: d.phase, reason: d.reason })),
    expertDecision: { status: c.expert_decision.status, reviewer: c.expert_decision.reviewer || null, date: dateOrNull(c.expert_decision.date), packVersion: c.expert_decision.pack_version },
    buildStatus: c.build_status,
    draft: c.expert_decision.pack_version === 'draft',
    class: cls,
  };
}

/** The Phase 7 records of a directory: each JSON file with its kind, verdict, summary and measures, hashed. */
export function readRecords(dir: string | undefined): PhaseRecord[] {
  if (!dir || !existsSync(dir)) return [];
  const out: PhaseRecord[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const r = JSON.parse(text) as { kind?: RecordKind; passed?: boolean; summary?: string; measures?: Measure[] };
    if (!r.kind || typeof r.passed !== 'boolean') continue;
    out.push({ kind: r.kind, file: relative(ROOT, join(dir, f)).split('\\').join('/'), sha256: sha256(text), passed: r.passed, summary: r.summary || r.kind, measures: r.measures ?? [] });
  }
  return out.sort((a, b) => compareText(a.kind, b.kind));
}

const RANK: Readonly<Record<BuildStatus, number>> = { SPECIFIED: 0, IMPLEMENTED: 1, VERIFIED: 2 };

/** The lower of the register's status and the one the bundle supports. */
export function supportedStatus(stored: BuildStatus, computed: BuildStatus): BuildStatus {
  return RANK[computed] < RANK[stored] ? computed : stored;
}

/** Builds and checks the bundle (header). */
export async function buildBundle(inp: BundleInputs): Promise<Bundle> {
  const controls = loadControls();
  const files = loadValidationFiles();
  const ctx = statusContext(files);
  const commit = inp.commit ?? commitOf();
  const pg = (await inp.db.query<{ v: string }>('show server_version')).rows[0]?.v ?? null;
  const host = inp.host ?? hostOfThisMachine(pg);
  const { runs, results } = readRuns(inp.resultsDir, commit.commit, host);
  // The trace of the run, as `pnpm trace` builds it from the same reports.
  const reports = reportsIn(inp.resultsDir);
  const testResults = reports.flatMap((r) => (r.kind === 'playwright' ? readPlaywrightResults(r.file) : readVitestResults(r.file)));
  const editions = gateEditions();
  const phase = currentPhase();
  const trace = buildTrace(controls, testResults, phase, { editions, e2e: reports.some((r) => r.kind === 'playwright') });
  const releaseRow = (await inp.db.query<{ r: string }>('select platform.schema_release() as r')).rows[0]?.r ?? '';
  const filesRelease = schemaReleaseOfFiles();
  if (releaseRow !== filesRelease) {
    throw new Error(`the database runs schema release ${releaseRow}, but the release's migration files give ${filesRelease}: migrate it to this release first`);
  }
  const versions = new Map<string, string[]>();
  try {
    for (const r of (await inp.db.query<{ method: string; version: number }>("select distinct method, version from analytics.method_version where status = 'EFFECTIVE'")).rows) {
      versions.set(r.method, [...(versions.get(r.method) ?? []), String(r.version)]);
    }
  } catch {
    // An installation without the analytics schema has no method versions.
  }
  const sbomText = readFileSync(join(ROOT, inp.sbomFile), 'utf8');
  const bundle: Bundle = {
    bundleVersion: 1,
    edition: 'tablets',
    release: { product: PRODUCT.tablets, maker: MAKER, version: inp.version ?? productVersion(), commit: commit.commit, commitTime: commit.commitTime, schemaRelease: filesRelease },
    register: {
      controls: controls.map((c) => controlOf(c, controlClass(c.id, ctx.classes))).sort((a, b) => compareText(a.id, b.id)),
      requirements: loadRequirements()
        .map((r) => ({ n: r.n, source: `${r.source}${r.clause ? `, ${r.clause}` : ''}`.trim() || '(none)', verification: r.verified, paraphrase: r.requirement || '(none)' }))
        .sort((a, b) => a.n - b.n),
    },
    runs,
    results,
    trace: {
      phase,
      editions: [...editions],
      ok: trace.errors.length === 0,
      controls: trace.rows
        .map((row) => ({
          control: row.control.id,
          passing: [...row.passing].sort(compareText),
          clauses: row.clauses.map((k) => ({ clause: k.clause.clause, status: k.state === 'TESTED' ? ('PROVEN' as const) : k.state === 'DEFERRED' ? ('DEFERRED' as const) : k.state === 'NOT_REQUIRED' ? ('NOT_REQUIRED' as const) : ('MISSING' as const) })),
        }))
        .sort((a, b) => compareText(a.control, b.control)),
    },
    inventory: await inventory(inp.db, inp.lockedSettings ? { lockedSettings: inp.lockedSettings } : {}),
    criticalLimits: ctx.limits.map((l) => ({ key: l.key, description: l.description, controls: [...l.controls], boundaryTests: [...l.boundaryTests] })).sort((a, b) => compareText(a.key, b.key)),
    reviews: ctx.reviews.map((r) => ({ id: r.id, date: r.date, scope: [...r.scope], findings: r.findings })).sort((a, b) => compareText(a.id, b.id)),
    openFindings: ctx.findings.map((f) => ({ id: f.id, severity: f.severity, controls: [...f.controls], summary: f.summary, source: f.source })).sort((a, b) => compareText(a.id, b.id)),
    analytics: {
      methods: catalogMethods()
        .map((m) => ({ id: m.id, versions: (versions.get(m.id) ?? []).sort(compareText), intendedUse: m.intendedUse, changesGmpData: m.changesGmpData }))
        .sort((a, b) => compareText(a.id, b.id)),
    },
    records: readRecords(inp.recordsDir),
    sbom: { file: inp.sbomFile, sha256: sha256(sbomText), format: 'CycloneDX 1.5' },
    knownIssues: ctx.findings.map((f) => ({ id: f.id, severity: f.severity, controls: [...f.controls], text: f.summary })).sort((a, b) => compareText(a.id, b.id)),
  };
  // The build status the bundle's own evidence supports (computeStatus reads the runs, results and commit only).
  const byId = new Map(controls.map((c) => [c.id, c]));
  for (const c of bundle.register.controls) {
    const rec = byId.get(c.id);
    if (rec) c.buildStatus = supportedStatus(rec.build_status, computeStatus(rec, bundle, ctx).status);
  }
  return parseBundle(JSON.parse(canonicalJson(bundle)));
}
