/**
 * Change control of MBR versions (PR-04, PR-06; outline 6.5 "structured difference against the
 * predecessor").
 *
 * The database decides at approval (guards mbr_version.registered_ranges_kept and
 * mbr_version.change_control_complete, sql/0130). The same comparisons are mirrored here, pure, so
 * the designer can show them while the author edits, and the reviewer sees the structured
 * difference produced by the flow model's diff (flow/diff.ts). A test proves both sides agree.
 *
 *   registeredChanges  REGISTERED-tier ranges of parameters, calculations, yield checkpoints and
 *                      acceptance criteria, plus REGISTRATION references: which changed, and which
 *                      were widened (a value the old range refused is now accepted). Decimal bounds
 *                      are compared exactly as decimal strings, never as binary floating point.
 *   processImpact      the top-level areas that changed, ignoring titles, the product's display
 *                      name, reference titles and golden test data; a first version is a new process.
 */
import type pg from 'pg';
import { canonicalJson } from '../flow/canonical.ts';
import { compareDecimal, isDecimalLiteral } from '../flow/decimal.ts';
import { diffMbr, type MbrDiff } from '../flow/diff.ts';
import type { MbrContent } from '../flow/model.ts';
import type { LimitRange, LimitSpec } from '../limits/model.ts';
import { loadContent } from './commands.ts';

export interface RegisteredRange {
  subject: string;
  unit: string | undefined;
  low?: { value: string; inclusive: boolean };
  high?: { value: string; inclusive: boolean };
}

export interface RegisteredChange {
  subject: string;
  change: string;
  widened: boolean;
}

function registered(subject: string, unit: string | undefined, r: LimitRange): RegisteredRange {
  const out: RegisteredRange = { subject, unit };
  if (r.low && isDecimalLiteral(r.low.value)) out.low = { value: r.low.value, inclusive: r.low.inclusive };
  if (r.high && isDecimalLiteral(r.high.value)) out.high = { value: r.high.value, inclusive: r.high.inclusive };
  return out;
}

/** REGISTERED-tier ranges of a content, keyed by subject (criteria as scheme/criterion). */
export function registeredRanges(content: MbrContent): Map<string, RegisteredRange> {
  const out = new Map<string, RegisteredRange>();
  const fromLimits = (id: string, limits: LimitSpec | undefined): void => {
    for (const r of limits?.ranges ?? []) if (r.tier === 'REGISTERED') out.set(id, registered(id, limits?.unit, r));
  };
  for (const p of content.parameters) fromLimits(p.id, p.limits);
  for (const c of content.calculations) fromLimits(c.id, c.limits);
  for (const y of content.yieldCheckpoints) fromLimits(y.id, y.limits);
  for (const s of content.acceptanceSchemes) {
    for (const c of s.criteria) if (c.range.tier === 'REGISTERED') out.set(`${s.id}/${c.id}`, registered(`${s.id}/${c.id}`, c.unit, c.range));
  }
  return out;
}

const show = (r: RegisteredRange): string =>
  `${r.low?.inclusive ? '[' : '('}${r.low?.value ?? '-inf'}, ${r.high?.value ?? '+inf'}${r.high?.inclusive ? ']' : ')'}`;

/** True when `after` accepts a value `before` refused (PR-04: a widened registered range). */
export function widens(before: RegisteredRange, after: RegisteredRange): boolean {
  if (before.unit !== after.unit) return true;
  const lowWider =
    before.low !== undefined &&
    (after.low === undefined ||
      compareDecimal(after.low.value, before.low.value) < 0 ||
      (compareDecimal(after.low.value, before.low.value) === 0 && after.low.inclusive && !before.low.inclusive));
  const highWider =
    before.high !== undefined &&
    (after.high === undefined ||
      compareDecimal(after.high.value, before.high.value) > 0 ||
      (compareDecimal(after.high.value, before.high.value) === 0 && after.high.inclusive && !before.high.inclusive));
  return lowWider || highWider;
}

const sameBound = (a: { value: string; inclusive: boolean } | undefined, b: { value: string; inclusive: boolean } | undefined): boolean =>
  a === undefined || b === undefined ? a === b : compareDecimal(a.value, b.value) === 0 && a.inclusive === b.inclusive;

export function registeredChanges(before: MbrContent, after: MbrContent): RegisteredChange[] {
  const b = registeredRanges(before);
  const a = registeredRanges(after);
  const out: RegisteredChange[] = [];
  for (const subject of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const x = b.get(subject);
    const y = a.get(subject);
    if (x && !y) out.push({ subject, change: 'registered range removed', widened: true });
    else if (!x && y) out.push({ subject, change: 'registered range added', widened: false });
    else if (x && y) {
      if (x.unit !== y.unit) out.push({ subject, change: `registered range unit changed from ${x.unit ?? '(none)'} to ${y.unit ?? '(none)'}`, widened: true });
      else if (!sameBound(x.low, y.low) || !sameBound(x.high, y.high)) out.push({ subject, change: `registered range changed from ${show(x)} to ${show(y)}`, widened: widens(x, y) });
    }
  }
  const regs = (c: MbrContent) => new Map(c.references.filter((r) => r.kind === 'REGISTRATION').map((r) => [r.code, r.version]));
  const rb = regs(before);
  const ra = regs(after);
  for (const code of [...new Set([...rb.keys(), ...ra.keys()])].sort()) {
    if (rb.get(code) !== ra.get(code)) {
      out.push({ subject: `registration:${code}`, change: `registration reference ${code} changed from version ${rb.get(code) ?? '(none)'} to ${ra.get(code) ?? '(none)'}`, widened: false });
    }
  }
  return out;
}

/** The content without the parts that do not affect the process (same as recipe.process_relevant). */
export function processRelevant(content: MbrContent): Record<string, unknown> {
  const { goldenCases: _golden, header, references, ...rest } = content;
  void _golden;
  const { title: _title, product, ...headerRest } = header;
  void _title;
  const { name: _name, ...productRest } = product;
  void _name;
  return {
    ...rest,
    header: { ...headerRest, product: productRest },
    references: references.map(({ title: _t, ...r }) => {
      void _t;
      return r;
    }),
  };
}

export interface ProcessImpact {
  impacting: boolean;
  newMaster: boolean;
  areas: string[];
}

/** Areas that changed against the baselines (PR-06); no baseline means a new master. */
export function processImpact(baselines: readonly MbrContent[], after: MbrContent): ProcessImpact {
  if (baselines.length === 0) return { impacting: true, newMaster: true, areas: ['new master'] };
  const n = processRelevant(after);
  const areas = new Set<string>();
  for (const before of baselines) {
    const o = processRelevant(before);
    for (const k of new Set([...Object.keys(n), ...Object.keys(o)])) if (canonicalJson(n[k]) !== canonicalJson(o[k])) areas.add(k);
  }
  const sorted = [...areas].sort();
  return { impacting: sorted.length > 0, newMaster: false, areas: sorted };
}

export interface BaselineDiff {
  baselineVersionId: string;
  baselineVersionNumber: number;
  diff: MbrDiff;
  registeredChanges: RegisteredChange[];
}

export interface VersionDiff {
  versionId: string;
  baselines: BaselineDiff[];
  processImpact: ProcessImpact;
}

/**
 * The structured difference of a version against its baselines (the version it was derived from
 * and the newest earlier approved version), for reviewers and the bulk approval package.
 */
export async function versionDiff(db: pg.Pool | pg.PoolClient, versionId: string): Promise<VersionDiff> {
  const after = (await loadContent(db, versionId)).content;
  const { rows } = await db.query<{ id: string; version_number: number }>(
    'select v.id, v.version_number from recipe.baseline_versions($1) b join recipe.mbr_version v on v.id = b order by v.version_number desc',
    [versionId],
  );
  const baselines: BaselineDiff[] = [];
  const contents: MbrContent[] = [];
  for (const r of rows) {
    const before = (await loadContent(db, r.id)).content;
    contents.push(before);
    baselines.push({ baselineVersionId: r.id, baselineVersionNumber: r.version_number, diff: diffMbr(before, after), registeredChanges: registeredChanges(before, after) });
  }
  return { versionId, baselines, processImpact: processImpact(contents, after) };
}

/** A bulk approval package (outline 6.5): one structured difference per version; signatures stay per version. */
export async function bulkApprovalPackage(db: pg.Pool | pg.PoolClient, versionIds: readonly string[]): Promise<VersionDiff[]> {
  const out: VersionDiff[] = [];
  for (const id of versionIds) out.push(await versionDiff(db, id));
  return out;
}
