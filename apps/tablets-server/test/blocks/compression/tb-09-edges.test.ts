/**
 * TB-09@1 tooling custody and inspection (IN-36, INV-24, PR-22, PR-23, PR-27) at its edges, through its handler on a
 * minimal view: inspections before use (issue part) and after return (return part), issue only after a passing
 * inspection, each set once, the held exceptions with their titles, PERFORMED per part and the specification check.
 * Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { partOf, specificationOf, TB09 } from '../../../src/blocks/tb-09.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SPEC = { type: 'B', shape: 'ROUND', upperEmbossing: 'C3', lowerEmbossing: 'BREAKLINE', score: 'SINGLE' };

class World {
  entries: E[] = [];
  constructor(readonly config: Json) {}
  view(): blocks.HandlerView {
    return { config: this.config, stepKey: 'p@', nowUs: 0n, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[] } {
    const accept = TB09.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: 0n });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
  before(): string[] {
    return (TB09.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(this.view()).map((p) => p.message);
  }
}
const inspect = (set: string, when: string, result = 'PASS') => ({ kind: 'TOOLING_INSPECTED', set, inspectionId: U(1), when, result });
const issue = (set: string) => ({ kind: 'TOOLING_ISSUED', set, issueId: U(2), press: 'PRESS-1' });
const ret = (set: string, extra: Json = {}) => ({ kind: 'TOOLING_RETURNED', set, issueId: U(2), strokes: '120000', strokeSource: 'PRESS_COUNTER', countMismatch: false, limitExceeded: false, ...extra });

describe('TB-09 issue', () => {
  it('[IN-36][INV-24][PR-23] a set is inspected before use and issued only after its last inspection passed, once; a failed inspection is noted and the set is not issued', () => {
    const w = new World({ part: 'ISSUE', specification: SPEC });
    expect(w.rec(inspect('S1', 'AFTER')).refused).toBe('A tooling issue step records the inspection before use (TB09-PART; IN-36)');
    expect(w.rec(ret('S1')).refused).toBe('A tooling issue step returns no set (TB09-PART; IN-36)');
    expect(w.rec(issue('S1')).refused).toBe('Set S1 has no passing inspection before use in p@ (TB09-NOT-INSPECTED; IN-36, INV-24)');
    const failed = w.rec(inspect('S1', 'BEFORE', 'FAIL'));
    expect(failed.exceptions).toEqual([{ type: 'TOOLING_FAILED_BEFORE_USE', title: 'Set S1 failed its inspection before use at p@: it is not issued', controls: ['IN-36', 'PR-23'], severity: 'ALERT', category: 'DEVIATION_OR_OVERRIDE', blocks: 'NONE', item: 'S1' }]);
    expect(w.rec(issue('S1')).refused).toMatch(/TB09-NOT-INSPECTED/);
    expect(w.rec(inspect('S1', 'BEFORE')).data).toStrictEqual({ set: 'S1', inspectionId: U(1), when: 'BEFORE', result: 'PASS', inspectedBy: 'OP1' });
    w.rec(inspect('S2', 'BEFORE'));
    expect(w.rec(issue('S1')).data).toStrictEqual({ set: 'S1', issueId: U(2), press: 'PRESS-1', inspection: 'E2', issuedBy: 'OP1' });
    expect(w.rec(issue('S1')).refused).toBe('Set S1 was issued in p@ already (TB09-ISSUED-TWICE; IN-36)');
    w.rec(inspect('S3', 'BEFORE'));
    w.rec(inspect('S3', 'BEFORE', 'FAIL'));
    expect(w.rec(issue('S3')).refused).toMatch(/TB09-NOT-INSPECTED/);
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a tooling step (TB09-ENTRY; IN-36)');
  });

  it('[IN-36][INV-24] PERFORMED of the issue needs an issued set', () => {
    const w = new World({ part: 'ISSUE' });
    expect(w.before()).toEqual(['p@ has issued no tooling set (TB09-NOT-ISSUED; IN-36, INV-24)']);
    w.rec(inspect('S1', 'BEFORE'));
    w.rec(issue('S1'));
    expect(w.before()).toEqual([]);
  });
});

describe('TB-09 return', () => {
  it('[IN-36][PR-22][INV-24][PR-23] a set returns once, raising a held exception for missing punches and for its usage limit, and is inspected after return once; a failure after use holds its tablets', () => {
    const w = new World({ part: 'RETURN' });
    expect(w.rec(issue('S1')).refused).toBe('A tooling return step issues no set (TB09-PART; IN-36)');
    expect(w.rec(inspect('S1', 'BEFORE')).refused).toBe('A tooling return step records the inspection after use (TB09-PART; IN-36)');
    expect(w.rec(inspect('S1', 'AFTER')).refused).toBe('Set S1 is inspected after use once it is returned (TB09-NOT-RETURNED; IN-36)');
    const r = w.rec(ret('S1', { countMismatch: true, limitExceeded: true }));
    expect(r.data).toStrictEqual({ set: 'S1', issueId: U(2), strokes: '120000', strokeSource: 'PRESS_COUNTER', countMismatch: true, limitExceeded: true, returnedBy: 'OP1' });
    expect(r.exceptions).toEqual([
      { type: 'TOOLING_COUNT_MISMATCH', title: 'Set S1 came back with punches or dies missing at p@: the tablets compressed since its issue are held and the steps after it wait for a deviation', controls: ['IN-36', 'PR-22'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'S1' },
      { type: 'TOOLING_LIMIT_EXCEEDED', title: 'Set S1 passed its usage limit during this use (120000 strokes): the steps after it wait for a deviation', controls: ['INV-24', 'PR-23'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'S1' },
    ]);
    expect(w.rec(ret('S1')).refused).toBe('Set S1 was returned in p@ already (TB09-RETURNED-TWICE; IN-36)');
    expect(w.rec(ret('S2')).exceptions).toBeUndefined();
    expect(w.before()).toEqual(['Inspect set S1, S2 after use before the step closes (TB09-AFTER-CHECK-MISSING; IN-36, INV-24)']);
    const after = w.rec(inspect('S1', 'AFTER', 'FAIL'));
    expect(after.exceptions).toEqual([
      { type: 'TOOLING_FAILED_AFTER_USE', title: 'Set S1 failed its inspection after use at p@: the tablets compressed since its issue are held and the steps after it wait for a deviation', controls: ['IN-36', 'INV-24', 'PR-23'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'S1' },
    ]);
    expect(w.rec(inspect('S1', 'AFTER')).refused).toBe('Set S1 was inspected after this use already (TB09-INSPECTED-TWICE; IN-36)');
    expect(w.before()).toEqual(['Inspect set S2 after use before the step closes (TB09-AFTER-CHECK-MISSING; IN-36, INV-24)']);
    w.rec(inspect('S2', 'AFTER'));
    expect(w.before()).toEqual([]);
    expect(new World({ part: 'RETURN' }).before()).toEqual(['p@ has returned no tooling set (TB09-NOT-RETURNED; IN-36)']);
  });

  it('[PR-27][IN-36] the issue part names the approved specification; the configuration as read', () => {
    const P = (config: Json) => (TB09.checkConfig as (p: flow.PhaseNode, c: Json) => { code: string; message: string; controls: readonly string[] }[])({ id: 'p' } as flow.PhaseNode, config).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
    expect(P({ part: 'ISSUE' })).toEqual(['TB09-NO-SPECIFICATION [PR-27,IN-36] Tooling issue step p names no approved tooling specification']);
    expect(P({ part: 'ISSUE', specification: SPEC })).toEqual([]);
    expect(P({ part: 'RETURN' })).toEqual([]);
    expect(P({})).toEqual(['TB09-NO-SPECIFICATION [PR-27,IN-36] Tooling issue step p names no approved tooling specification']);
    expect(partOf({ part: 'RETURN' })).toBe('RETURN');
    expect(partOf({ part: 'x' })).toBe('ISSUE');
    expect(specificationOf({ specification: SPEC })).toEqual(SPEC);
    expect(specificationOf({ specification: 'x' })).toBeUndefined();
  });
});
