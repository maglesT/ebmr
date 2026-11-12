/**
 * The build statuses of D-P7-2 (Phase 7 plan, "Decisions with defaults"; slice 7c), computed and checked.
 *
 *  - SPECIFIED: in the register; some part not yet proven or deferred.
 *  - IMPLEMENTED: every clause names listed tests that passed in the trace's run, nothing deferred.
 *  - VERIFIED: IMPLEMENTED on the release candidate's final run, with the evidence in the pack's bundle (each clause's
 *    listed tests passed on the bundle's commit, in runs with a report hash, and none failed); the control lies in code
 *    covered by a review pass (a review's scope matches one of its implementing files or, when it names none, one of its
 *    test files: D-P7c-3); no open critical or high finding names it; a core-class control has a database test among its
 *    tests; a control with a critical limit has that limit's boundary tests listed; and it is not a status-U draft
 *    (its regulatory text is unchecked: expert_decision.pack_version "draft").
 *
 * `register:status --bundle <file>` writes the computed status into each control file (only `build_status`): the
 * only writer of VERIFIED. `register:validate` refuses a VERIFIED the rule does not allow: without a bundle, every
 * part it can check from the files (statusProblems); with `--bundle`, the whole rule.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { isDatabaseTest, type Bundle } from '../../../packages/validation-kit/src/index.ts';
import { CONTROLS_DIR, type ControlRecord } from './register.ts';
import { controlClass, loadValidationFiles, type ControlClassEntry, type CriticalLimit, type OpenFinding, type ReviewEntry, type ValidationFiles } from './validation-files.ts';

export type BuildStatus = ControlRecord['build_status'];

export interface StatusContext {
  classes: readonly ControlClassEntry[];
  limits: readonly CriticalLimit[];
  reviews: readonly ReviewEntry[];
  findings: readonly OpenFinding[];
}

/** The context of the rule from the files under compliance/validation/ (checked by register:validate first). */
export function statusContext(files: ValidationFiles = loadValidationFiles()): StatusContext {
  const list = <T>(doc: unknown, key: string): T[] => ((doc as Record<string, T[] | undefined> | null)?.[key] ?? []);
  return {
    classes: list<ControlClassEntry>(files['control-class.yaml'], 'classes'),
    limits: list<CriticalLimit>(files['critical-limits.yaml'], 'limits'),
    reviews: list<ReviewEntry>(files['reviews.yaml'], 'reviews'),
    findings: list<OpenFinding>(files['open-findings.yaml'], 'findings'),
  };
}

/** A path glob of reviews.yaml as a regular expression: `**` any path, `*` and `?` within a segment, `[...]` a class. */
export function globRegExp(glob: string): RegExp {
  let rx = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*' && glob[i + 1] === '*') {
      rx += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (ch === '*') rx += '[^/]*';
    else if (ch === '?') rx += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) rx += '\\[';
      else {
        rx += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else rx += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`);
}

/** The repository paths a control's implementation names (the path before any parenthesised note). */
export function implementationPaths(c: ControlRecord): string[] {
  return Object.values(c.implemented_by)
    .flat()
    .map((p) => p.split(' (')[0]?.trim() ?? '')
    .filter((p) => p !== '');
}

const allTests = (c: ControlRecord): string[] => [...new Set([...(c.clauses ?? []).flatMap((k) => k.tests ?? []), ...c.tests])];
const testFile = (t: string): string => t.split(' > ')[0] ?? t;
export const isDraft = (c: ControlRecord): boolean => c.expert_decision.pack_version === 'draft';

/** What keeps a control from VERIFIED that the files alone show (no bundle needed). Empty when nothing does. */
export function staticProblems(c: ControlRecord, ctx: StatusContext): string[] {
  const out: string[] = [];
  const clauses = c.clauses ?? [];
  if (clauses.length === 0) out.push('it has no clauses');
  else if (clauses.every((k) => k.not_required)) out.push('every clause is not required by its MODIFY decision, so no clause proves what it keeps');
  for (const k of clauses) {
    if (k.deferred) out.push(`clause "${k.clause}" is deferred to phase ${String(k.deferred.phase)}`);
    else if (k.not_required) continue;
    else if ((k.tests ?? []).length === 0) out.push(`clause "${k.clause}" lists no test`);
  }
  if ((c.deferred_scope ?? []).length > 0) out.push('part of its behaviour is deferred (deferred_scope)');
  if (isDraft(c)) out.push('it is a status-U draft (its regulatory text is unchecked)');
  const tests = allTests(c);
  if (controlClass(c.id, ctx.classes) === 'core' && !tests.some(isDatabaseTest)) out.push('a core-class control without a database test among its tests');
  for (const l of ctx.limits.filter((x) => x.controls.includes(c.id))) {
    const missing = l.boundaryTests.filter((t) => !tests.includes(t));
    if (missing.length > 0) out.push(`critical limit ${l.key}: boundary tests not listed: ${missing.join('; ')}`);
  }
  for (const f of ctx.findings.filter((x) => x.controls.includes(c.id) && (x.severity === 'critical' || x.severity === 'high'))) {
    out.push(`open ${f.severity} finding ${f.id} names it`);
  }
  const paths = implementationPaths(c);
  const scoped = paths.length > 0 ? paths : tests.map(testFile);
  const covered = ctx.reviews.some((r) => r.scope.some((g) => scoped.some((p) => globRegExp(g).test(p))));
  if (!covered) out.push(`no review pass covers its ${paths.length > 0 ? 'implementation' : 'tests (it names no implementation)'}`);
  return out;
}

/** The status of a control by D-P7-2 from a bundle, with what kept it from the next status. */
export function computeStatus(c: ControlRecord, bundle: Bundle, ctx: StatusContext): { status: BuildStatus; reasons: string[] } {
  const runs = new Map(bundle.runs.map((r) => [r.id, r]));
  const results = new Map<string, typeof bundle.results>();
  for (const r of bundle.results) results.set(r.test, [...(results.get(r.test) ?? []), r]);
  const passedIn = (t: string, onCommit: boolean): boolean => {
    const rs = results.get(t) ?? [];
    if (rs.some((r) => r.status === 'failed')) return false;
    return rs.some((r) => r.status === 'passed' && (!onCommit || (runs.get(r.run)?.commit === bundle.release.commit && /^[0-9a-f]{64}$/.test(runs.get(r.run)?.reportSha256 ?? ''))));
  };
  const clauses = c.clauses ?? [];
  const reasons: string[] = [];
  // IMPLEMENTED: every clause has a listed test that passed in the run, nothing deferred.
  if (clauses.length === 0) reasons.push('it has no clauses');
  else if (clauses.every((k) => k.not_required)) reasons.push('every clause is not required by its MODIFY decision, so no clause proves what it keeps');
  for (const k of clauses) {
    if (k.deferred) reasons.push(`clause "${k.clause}" is deferred to phase ${String(k.deferred.phase)}`);
    // A clause the approved MODIFY decision left out has nothing to prove; the control's kept clauses carry its status.
    else if (k.not_required) continue;
    else if (!(k.tests ?? []).some((t) => passedIn(t, false))) reasons.push(`clause "${k.clause}" has no listed test that passed`);
  }
  if ((c.deferred_scope ?? []).length > 0) reasons.push('part of its behaviour is deferred (deferred_scope)');
  if (reasons.length > 0) return { status: 'SPECIFIED', reasons };
  // VERIFIED: every listed test of every clause passed on the bundle's commit, and the static conditions.
  for (const k of clauses) {
    for (const t of k.tests ?? []) if (!passedIn(t, true)) reasons.push(`listed test did not pass on commit ${bundle.release.commit} in a hashed run: ${t}`);
  }
  reasons.push(...staticProblems(c, ctx));
  return reasons.length > 0 ? { status: 'IMPLEMENTED', reasons } : { status: 'VERIFIED', reasons: [] };
}

/** The VERIFIED controls the rule does not allow (register:validate): the static part, or with a bundle the whole. */
export function verifiedProblems(controls: readonly ControlRecord[], ctx: StatusContext, bundle?: Bundle): string[] {
  const out: string[] = [];
  for (const c of controls.filter((x) => x.build_status === 'VERIFIED')) {
    const problems = bundle ? (() => {
      const r = computeStatus(c, bundle, ctx);
      return r.status === 'VERIFIED' ? [] : r.reasons;
    })() : staticProblems(c, ctx);
    if (problems.length > 0) out.push(`${c.id} is VERIFIED, which D-P7-2 does not allow: ${problems.join('; ')}`);
  }
  return out;
}

/** Rewrites only the `build_status` line of a control file's text (the rest of the file stays byte for byte). */
export function withBuildStatus(text: string, status: BuildStatus): string {
  const doc = YAML.parseDocument(text);
  if (!doc.has('build_status')) throw new Error('the control file has no build_status');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^build_status:/.test(l));
  if (at < 0) throw new Error('build_status is not a top-level line');
  lines[at] = `build_status: ${status}`;
  const next = lines.join('\n');
  const check = YAML.parse(next) as Record<string, unknown>;
  const before = YAML.parse(text) as Record<string, unknown>;
  if (JSON.stringify({ ...before, build_status: status }) !== JSON.stringify(check)) throw new Error('rewriting build_status changed another field');
  return next;
}

/** Sets each control's build_status from the bundle (register:status). Returns the changes made. */
export function applyStatuses(controls: readonly ControlRecord[], bundle: Bundle, ctx: StatusContext, dir = CONTROLS_DIR): { id: string; from: BuildStatus; to: BuildStatus; reasons: string[] }[] {
  const changes: { id: string; from: BuildStatus; to: BuildStatus; reasons: string[] }[] = [];
  for (const c of controls) {
    const { status, reasons } = computeStatus(c, bundle, ctx);
    if (status === c.build_status) continue;
    const file = join(dir, `${c.id}.yaml`);
    writeFileSync(file, withBuildStatus(readFileSync(file, 'utf8'), status));
    changes.push({ id: c.id, from: c.build_status, to: status, reasons });
  }
  return changes;
}
