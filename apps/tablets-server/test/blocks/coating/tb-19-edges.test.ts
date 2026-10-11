/**
 * TB-19@1 tablet printing with the QC approval gate (IN-37, PR-29, PR-45) at its edges, through its handler on a minimal
 * view: edible ink and the segregation record, the check sample, defects against the MBR's maximum (equal passes),
 * legibility and the master content, the failure's title, PERFORMED after a passing last check, the gate after the step
 * (role, a rejecting disposition) and the mark content. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { gateProblem, nextNodeOf, TB19 } from '../../../src/blocks/tb-19.ts';
import { blockMbr, fixturePhase, mbrWithChildren, phase, QC_GATE } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const CFG: Json = { method: 'INK', content: 'C3', sampleSize: '50' };

class World {
  entries: E[] = [];
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return { config: this.config, stepKey: 'p@', nowUs: 0n, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[] } {
    const accept = TB19.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: 0n });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
  before(): string[] {
    return (TB19.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(this.view()).map((p) => p.message);
  }
}
const setup = (extra: Json = {}) => ({ kind: 'PRINT_SETUP', printer: 'PRINTER-01', inkLot: 'INK-1', inkEdibleGrade: true, otherProductsPrinting: false, ...extra });
const check = (defects: Json = {}, extra: Json = {}) => ({ kind: 'PRINT_CHECK', examined: '50', legible: true, contentMatches: true, defects, ...extra });

describe('TB-19 printing', () => {
  it('[IN-37] the set-up once, with edible ink; a segregation record exactly when others are printed at the same time', () => {
    const w = new World();
    expect(w.rec(setup({ inkEdibleGrade: false })).refused).toBe('Ink or colour lot INK-1 is used for printing tablets only when it is of edible grade (TB19-INK; IN-37)');
    expect(w.rec(setup({ otherProductsPrinting: true })).refused).toBe('Other products or batches are printed at the same time: the segregation record is required (TB19-SEGREGATION; IN-37)');
    expect(w.rec(setup({ otherProductsPrinting: true, segregationRecord: '  ' })).refused).toMatch(/the segregation record is required/);
    expect(w.rec(setup({ segregationRecord: 'SEG-1' })).refused).toBe('A segregation record is given only when other products or batches are printed at the same time (TB19-SEGREGATION; IN-37)');
    expect(w.rec(setup({ otherProductsPrinting: true, segregationRecord: 'SEG-1' })).data).toStrictEqual({ printer: 'PRINTER-01', inkLot: 'INK-1', inkEdibleGrade: true, otherProductsPrinting: true, segregationRecord: 'SEG-1', setUpBy: 'OP1' });
    expect(w.rec(setup()).refused).toBe('p@ already records its printing set-up (TB19-SETUP-TWICE; IN-37)');
    expect(new World().rec(setup()).data).toStrictEqual({ printer: 'PRINTER-01', inkLot: 'INK-1', inkEdibleGrade: true, otherProductsPrinting: false, setUpBy: 'OP1' });
    expect(new World().rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a printing step (TB19-ENTRY; IN-37)');
  });

  it('[IN-37][PR-29] a check after the set-up examines the MBR\'s sample; defects up to the MBR\'s maximum pass (D 0); illegible or not matching the master fails, with its title', () => {
    expect(new World().rec(check()).refused).toBe('Set up the printing of p@ first (TB19-NO-SETUP; IN-37)');
    const w = new World({ ...CFG, maxDefects: '2' });
    w.rec(setup());
    expect(w.rec(check({}, { examined: '49' })).refused).toBe('A print check examines the 50 tablets the MBR sets, not 49 (TB19-SAMPLE; PR-29)');
    expect(w.rec(check({ SMUDGED: '30', MISSING: '21' })).refused).toBe('More defects (51) than tablets examined (50) (TB19-DEFECTS; PR-29)');
    expect(w.rec(check({ SMUDGED: '25', MISSING: '25' })).data?.['result']).toBe('FAIL');
    const two = w.rec(check({ SMUDGED: '1', MISREGISTERED: '1', OTHER: '9' }));
    expect(two.data).toStrictEqual({ examined: '50', legible: true, contentMatches: true, content: 'C3', defects: { SMUDGED: '1', MISREGISTERED: '1', OTHER: '9' }, defectCounts: { SMUDGED: '1', MISSING: '0', MISREGISTERED: '1' }, defectTotal: '2', result: 'PASS', checkedBy: 'OP1' });
    expect(two.exceptions).toBeUndefined();
    const three = w.rec(check({ SMUDGED: '3' }));
    expect(three.exceptions?.map((x) => [x['type'], x['title'], x['until']])).toEqual([
      ['PRINT_CHECK_FAILED', 'A print check of p@ failed (3 defects in 50): the tablets printed since the last passing check are held and the steps after it wait for a deviation', 'DEVIATION'],
    ]);
    expect(w.rec(check({}, { legible: false, contentMatches: false })).exceptions?.[0]?.['title']).toBe(
      'A print check of p@ failed (illegible; mark does not match the master; 0 defects in 50): the tablets printed since the last passing check are held and the steps after it wait for a deviation',
    );
    expect(w.rec(check({}, { contentMatches: false })).data?.['result']).toBe('FAIL');
    const d0 = new World();
    d0.rec(setup());
    expect(d0.rec(check({ MISSING: '1' })).data?.['result']).toBe('FAIL');
    const noSample = new World({ method: 'INK', content: 'C3' });
    noSample.rec(setup());
    expect(noSample.rec(check()).refused).toBe('A print check examines the - tablets the MBR sets, not 50 (TB19-SAMPLE; PR-29)');
  });

  it('[IN-37][PR-29][PR-45] PERFORMED needs the set-up and a passing last check', () => {
    const w = new World();
    expect(w.before()).toEqual(['p@ has no printing set-up (TB19-NO-SETUP; IN-37)', 'p@ has no print check (TB19-NO-CHECK; IN-37, PR-29)']);
    w.rec(setup());
    w.rec(check());
    expect(w.before()).toEqual([]);
    w.rec(check({ SMUDGED: '1' }));
    expect(w.before()).toEqual(['The last print check of p@ failed: a passing check comes after it (TB19-LAST-CHECK; IN-37, PR-29)']);
  });
});

describe('TB-19 the QC gate', () => {
  const P = (config: Json, after: flow.FlowNode[]): string[] => {
    const p = fixturePhase(TB19, { config: config as never });
    const m = mbrWithChildren([p, ...after, phase('after')]);
    const check = TB19.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check(p, p.config as Json, m).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  const gate = (over: Json) => ({ ...QC_GATE, ...over }) as flow.FlowNode;

  it('[IN-37][PR-29][PR-45] the node right after the step is a hold point of the gate role (D QA) with a disposition that rejects; the mark content is named', () => {
    expect(P(CFG, [QC_GATE])).toEqual([]);
    const no = (d: string) => `TB19-NO-GATE [IN-37,PR-29] Printed tablets wait for the QC approval: ${d}`;
    expect(P(CFG, [])).toEqual([no('the node after printing step p is not a QA hold point')]);
    expect(P(CFG, [gate({ role: 'QC' })])).toEqual([no('hold point H-PRINT after printing step p is signed by QC, not QA')]);
    expect(P({ ...CFG, gateRole: 'QC' }, [gate({ role: 'QC' })])).toEqual([]);
    expect(P(CFG, [gate({ dispositions: ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED'] })])).toEqual([no('hold point H-PRINT after printing step p has no disposition that rejects the printed tablets')]);
    expect(P(CFG, [gate({ dispositions: ['APPROVED', 'REJECTED'] })])).toEqual([]);
    expect(P({ ...CFG, content: '  ' }, [QC_GATE])).toEqual(['TB19-CONTENT [IN-37] Printing step p names the mark content from the approved master']);
    expect(P({ ...CFG, content: undefined }, [QC_GATE])).toEqual(['TB19-CONTENT [IN-37] Printing step p names the mark content from the approved master']);
    const m = blockMbr(TB19);
    expect(nextNodeOf(m, 'p')?.id).toBe('H-PRINT');
    expect(nextNodeOf(m, 'after')).toBeUndefined();
    expect(gateProblem(m, fixturePhase(TB19), CFG)).toBeUndefined();
  });

  it('[DI-34] the nominal path sets up and checks the MBR\'s sample', () => {
    const p = fixturePhase(TB19);
    const nominal = TB19.simulatorModel?.nominalEntries({ phase: p, config: p.config, mbr: blockMbr(TB19, p), frames: [], containers: [], target: () => undefined });
    expect(nominal?.map((x) => [x.kind, x['examined']])).toEqual([['PRINT_SETUP', undefined], ['PRINT_CHECK', '50']]);
    const q = fixturePhase(TB19, { config: { sampleSize: undefined } as never });
    expect(TB19.simulatorModel?.nominalEntries({ phase: q, config: q.config, mbr: blockMbr(TB19, q), frames: [], containers: [], target: () => undefined })[1]?.['examined']).toBe('1');
  });
});
