/**
 * ATA.BASELINE v1: per-person audit-trail baselines (slice 6A-4; decision 0016 item 8; D-6A-12; draft control DI-53).
 * No machine learning (decision 0023): weekly metrics per person, each compared with the person's own trailing weeks by
 * a robust z (median and MAD).
 *
 * Metrics per person and site week (Monday to Sunday on the site's wall clock):
 *   ENTRIES        the person's audit entries;
 *   CORRECTIONS    their corrections (an update or void after first commit);
 *   LATE_ENTRIES   their entries recorded more than lateEntryMinutes after the time they claim;
 *   FAILED_LOGINS  their failed logins.
 * A week is assessed when it is complete (the latest site week of the input is in progress and is not) and the person
 * has at least minHistoryWeeks weeks before it, counted from their first week in the input, of which at most
 * trailingWeeks are used. A week without activity counts zero. z = (x - median) / (1.4826 MAD); when the MAD is zero
 * the scale is 1.2533 times the mean absolute deviation from the median, and when that is zero too the week is not
 * assessable for that metric (no variation to compare with; D-6A-4-6). A flag BASELINE_Z is raised at |z| above robustZ,
 * its key being the week and the metric (D-6A-4-5).
 */
import type { Method, MethodResult, Parameters, Skipped } from '../../method.ts';
import type { Evidence, FlagDraft, OutputDraft } from '../../types.ts';
import { type AuditInput, byText, compareIds, eventRef, instantMs, siteWeek, weekPlus } from './input.ts';
import { MAX_EVIDENCE } from './rules.ts';

export type BaselineMetric = 'ENTRIES' | 'CORRECTIONS' | 'LATE_ENTRIES' | 'FAILED_LOGINS';
export const BASELINE_METRICS: readonly BaselineMetric[] = ['ENTRIES', 'CORRECTIONS', 'LATE_ENTRIES', 'FAILED_LOGINS'];

export type AuditBaselineParameters = Parameters & {
  readonly minHistoryWeeks: number;
  readonly trailingWeeks: number;
  readonly robustZ: number;
  readonly lateEntryMinutes: number;
};

const LABEL: Readonly<Record<BaselineMetric, string>> = { ENTRIES: 'Audit entries', CORRECTIONS: 'Corrections', LATE_ENTRIES: 'Late entries', FAILED_LOGINS: 'Failed logins' };

/** The median of xs (empty: NaN). */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  return n % 2 === 1 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
}

/** The robust z of x against history h, or null when h shows no variation. */
export function robustZ(x: number, h: readonly number[]): { z: number; median: number; mad: number } | null {
  const m = median(h);
  const dev = h.map((v) => Math.abs(v - m));
  const mad = median(dev);
  let scale = 1.4826 * mad;
  if (scale === 0) scale = 1.2533 * (dev.reduce((s, v) => s + v, 0) / dev.length);
  if (!(scale > 0)) return null;
  return { z: (x - m) / scale, median: m, mad };
}

interface Cell {
  count: number;
  evidence: Evidence[];
}

export function runAuditBaseline(input: AuditInput, p: AuditBaselineParameters): MethodResult {
  const skipped: Skipped[] = [];
  const cells = new Map<string, Cell>();
  const first = new Map<string, string>();
  const span: { latest: string | null } = { latest: null };
  const touch = (personId: string, week: string): void => {
    const f = first.get(personId);
    if (f === undefined || week < f) first.set(personId, week);
    if (span.latest === null || week > span.latest) span.latest = week;
  };
  const add = (personId: string, week: string, metric: BaselineMetric, ev: Evidence): void => {
    const k = `${personId}|${week}|${metric}`;
    const c = cells.get(k) ?? { count: 0, evidence: [] };
    c.count += 1;
    if (c.evidence.length < MAX_EVIDENCE) c.evidence.push(ev);
    cells.set(k, c);
  };
  const events = [...input.events].sort((a, b) => instantMs(a.recordedAt) - instantMs(b.recordedAt) || compareIds(a.eventId, b.eventId));
  for (const e of events) {
    const week = siteWeek(e.recordedLocal);
    touch(e.personId, week);
    const ev = { kind: 'AUDIT_EVENT', ref: eventRef(e) };
    add(e.personId, week, 'ENTRIES', ev);
    if (e.isCorrection) add(e.personId, week, 'CORRECTIONS', ev);
    if (e.claimedAt !== null && instantMs(e.recordedAt) - instantMs(e.claimedAt) > p.lateEntryMinutes * 60_000) add(e.personId, week, 'LATE_ENTRIES', ev);
  }
  for (const a of [...input.auth].sort((x, y) => instantMs(x.at) - instantMs(y.at) || byText(x.ref, y.ref))) {
    const week = siteWeek(a.atLocal);
    touch(a.personId, week);
    if (a.kind === 'FAILED') add(a.personId, week, 'FAILED_LOGINS', { kind: 'AUTH_EVENT', ref: a.ref });
  }
  const value = (personId: string, week: string, metric: BaselineMetric): number => cells.get(`${personId}|${week}|${metric}`)?.count ?? 0;

  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const latest = span.latest;
  for (const personId of [...first.keys()].sort(byText)) {
    const start = first.get(personId) as string;
    const assessable: string[] = [];
    for (let w = weekPlus(start, p.minHistoryWeeks); latest !== null && w < latest; w = weekPlus(w, 1)) assessable.push(w);
    if (assessable.length === 0) {
      let have = 0;
      for (let w = start; latest !== null && w < latest; w = weekPlus(w, 1)) have += 1;
      skipped.push({ subject: `PERSON ${personId}`, reason: `${String(have)} complete week(s) of history; the baseline needs ${String(p.minHistoryWeeks)} before a week it assesses` });
      continue;
    }
    let raised = 0;
    let notAssessable = 0;
    const latestZ: Record<string, number> = {};
    for (const week of assessable) {
      const history: string[] = [];
      for (let k = p.trailingWeeks; k >= 1; k -= 1) {
        const w = weekPlus(week, -k);
        if (w >= start) history.push(w);
      }
      for (const metric of BASELINE_METRICS) {
        const x = value(personId, week, metric);
        const r = robustZ(x, history.map((w) => value(personId, w, metric)));
        if (r === null) {
          notAssessable += 1;
          continue;
        }
        if (week === assessable[assessable.length - 1]) latestZ[`z.${metric}`] = r.z;
        if (!(Math.abs(r.z) > p.robustZ)) continue;
        raised += 1;
        flags.push({
          subjectKind: 'PERSON', subjectRef: personId, rule: 'BASELINE_Z', severity: 'ATTENTION',
          reasons: [{
            code: 'BASELINE_Z',
            text: `${LABEL[metric]} in the site week of ${week}: ${String(x)}, against a median of ${String(r.median)} (MAD ${String(r.mad)}) over the person's ${String(history.length)} trailing weeks; robust z ${r.z.toFixed(1)} (threshold ${String(p.robustZ)})`,
            weight: r.z,
            evidence: [{ kind: 'BASELINE_WEEK', ref: `${week}|${metric}` }, ...(cells.get(`${personId}|${week}|${metric}`)?.evidence ?? [])],
          }],
        });
      }
    }
    outputs.push({
      subjectKind: 'PERSON', subjectRef: personId, kind: 'AUDIT_BASELINE',
      values: { assessedWeeks: assessable.length, flags: raised, notAssessable, latestWeek: assessable[assessable.length - 1] as string, ...latestZ },
      reasons: [{ code: 'BASELINE', text: `${String(assessable.length)} week(s) assessed against the person's own trailing weeks; ${String(raised)} above the threshold` }],
    });
  }
  return { outputs, flags, skipped };
}

export const ATA_BASELINE: Method<AuditInput, AuditBaselineParameters> = { id: 'ATA.BASELINE', versions: [1], run: (input, params) => runAuditBaseline(input, params) };
