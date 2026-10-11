/**
 * TB-20@1 inspection, sorting and AQL (PR-46, PR-47, PR-50, IN-35) at its edges, through its handler on a minimal view:
 * the inspection's order, the sort result's reconciliation (counts, defects, masses at zero remainder), the foreign
 * tablet, the AQL evaluation at each class's accept number, the sample capped at the lot, the plan's absence, PERFORMED,
 * the destruction step and every definition check. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { defectsOf, destructionProblem, evaluateAql, TB20 } from '../../../src/blocks/tb-20.ts';
import { blockMbr, DESTROY, fixturePhase, mbrWithChildren, phase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const T = 1_800_000_000_000_000n;
const CFG = (TB20.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;
const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return {
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      actor: { id: 'OP1' },
    } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB20.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  sorted(): World {
    this.rec({ kind: 'INSPECTION_START' });
    this.now += 60_000_000n;
    this.rec({ kind: 'INSPECTION_END' });
    return this;
  }
}
const kg = (value: string) => ({ value, unit: 'kg' });
const sort = (o: { inspected?: [string, string]; accepted?: [string, string]; defects?: [string, string][]; rejects?: Json[] } = {}): Json & { kind: string } => ({
  kind: 'SORT_RESULT',
  inspected: { count: o.inspected?.[0] ?? '1000', mass: kg(o.inspected?.[1] ?? '0.250') },
  accepted: { count: o.accepted?.[0] ?? '990', mass: kg(o.accepted?.[1] ?? '0.2475') },
  defects: (o.defects ?? [['CHIPPED', '10']]).map(([code, count]) => ({ code, count })),
  rejects: o.rejects ?? [{ category: 'DESTRUCTION', container: C1, count: '10', mass: kg('0.0025') }],
});

describe('TB-20 inspection and sorting', () => {
  it('[PR-46] the inspection starts and ends once, in order; the sort result comes after it, once', () => {
    const w = new World();
    expect(w.rec({ kind: 'INSPECTION_END' }).refused).toBe('p@ has not started its inspection (TB20-NOT-STARTED; PR-46)');
    expect(w.rec(sort()).refused).toBe('The sort result of p@ is recorded after the sort ends (TB20-NOT-SORTED; PR-46, IN-35)');
    expect(w.rec({ kind: 'INSPECTION_START' }).data).toStrictEqual({ inspector: 'OP1' });
    expect(w.rec({ kind: 'INSPECTION_START' }).refused).toBe('p@ already started its inspection (TB20-INSPECTION-TWICE; PR-46)');
    w.now += 90_000_000n;
    expect(w.rec({ kind: 'INSPECTION_END' }).data).toStrictEqual({ inspectionSeconds: '90.000000', inspector: 'OP1' });
    expect(w.rec({ kind: 'INSPECTION_END' }).refused).toBe('p@ already ended its inspection (TB20-INSPECTION-TWICE; PR-46)');
    expect(w.rec(sort())).toMatchObject({ verificationRequired: true });
    expect(w.rec(sort()).refused).toBe('p@ already records its sort result (TB20-SORT-TWICE; DI-29)');
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of an inspection step (TB20-ENTRY; PR-46)');
  });

  it('[PR-46][IN-35] the sort result reconciles exactly: catalogue defects counted once, rejects in distinct containers, one unit, inspected = accepted + rejected, one defect per reject, no more mass out than in (zero remainder allowed)', () => {
    const r = (o: Parameters<typeof sort>[0]) => new World().sorted().rec(sort(o));
    expect(r({ defects: [['CRACKED', '10']] }).refused).toBe("Defect CRACKED is not in the MBR's defect catalogue (TB20-DEFECT; PR-46)");
    expect(r({ defects: [['CHIPPED', '5'], ['CHIPPED', '5']] }).refused).toBe('Each defect code is counted once (TB20-DEFECT; PR-46)');
    expect(r({ rejects: [{ category: 'REUSABLE_RESIDUE', container: C1, count: '10', mass: kg('0.0025') }] }).refused).toBe(
      'Reusable residue is a category only where the MBR has a recovery step (TB-08) to use it; rejects are for destruction (TB20-RESIDUE; PR-46, PR-47)',
    );
    expect(new World({ ...CFG, reusableResidue: true }).sorted().rec(sort({ rejects: [{ category: 'REUSABLE_RESIDUE', container: C1, count: '10', mass: kg('0.0025') }] })).refused).toBeUndefined();
    expect(r({ rejects: [{ category: 'DESTRUCTION', container: C1, count: '5', mass: kg('0.001') }, { category: 'DESTRUCTION', container: C1, count: '5', mass: kg('0.001') }] }).refused).toBe('Each reject container is named once (TB20-CONTAINER; PR-46, IN-35)');
    expect(r({ rejects: [{ category: 'DESTRUCTION', container: C1, count: '10', mass: { value: '2.5', unit: 'g' } }] }).refused).toBe('The masses of a sort result are in one unit (TB20-UNIT; PR-46)');
    expect(r({ accepted: ['991', '0.2475'] }).refused).toBe('Inspected 1000 tablets are not the 991 accepted and the 10 rejected (TB20-RECONCILE; PR-46, IN-35)');
    expect(r({ defects: [['CHIPPED', '9']] }).refused).toBe('Every rejected tablet carries one defect code: 9 defects, 10 rejected (TB20-RECONCILE; PR-46, IN-35)');
    expect(r({ accepted: ['990', '0.2476'] }).refused).toBe('The accepted and rejected masses come to more than the mass inspected (TB20-RECONCILE; PR-46, IN-35)');
    const exact = r({});
    expect(exact.data).toStrictEqual({
      inspected: { count: '1000', mass: kg('0.250') },
      accepted: { count: '990', mass: kg('0.2475') },
      defects: [{ code: 'CHIPPED', count: '10' }],
      rejects: [{ category: 'DESTRUCTION', container: C1, count: '10', mass: kg('0.0025') }],
      rejectCount: '10',
      defectsByClass: { CRITICAL: '0', MAJOR: '10', MINOR: '0' },
      unaccountedMass: { value: '0', unit: 'kg' },
      recordedBy: 'OP1',
    });
    expect(exact.exceptions).toBeUndefined();
    const two = r({ defects: [['CHIPPED', '6'], ['BLACK-SPOT', '4']], rejects: [{ category: 'DESTRUCTION', container: C1, count: '6', mass: kg('0.0015') }, { category: 'DESTRUCTION', container: C2, count: '4', mass: kg('0.001') }], inspected: ['1000', '0.251'] });
    expect(two.data).toMatchObject({ rejectCount: '10', defectsByClass: { CRITICAL: '0', MAJOR: '6', MINOR: '4' }, unaccountedMass: { value: '0.001', unit: 'kg' } });
  });

  it('[PR-50][PR-46] a foreign tablet found is critical: QA decides, release is blocked, a deviation is required; a zero count is not a finding', () => {
    const found = new World().sorted().rec(sort({ defects: [['CHIPPED', '9'], ['FOREIGN', '1']] }));
    expect(found.exceptions).toEqual([
      {
        type: 'FOREIGN_TABLET_FOUND',
        title: 'Foreign or other-product tablets (FOREIGN) were found sorting p@: QA decides, and the investigation extends to the other batches that may be affected',
        controls: ['PR-50', 'PR-46', 'IN-35'],
        severity: 'CRITICAL',
        category: 'DEVIATION_OR_OVERRIDE',
        blocks: 'DOWNSTREAM',
        until: 'DISPOSITION',
        deviationRequired: true,
        qaOnly: true,
        releaseBlocking: true,
      },
    ]);
    expect(found.data?.['defectsByClass']).toEqual({ CRITICAL: '1', MAJOR: '9', MINOR: '0' });
    expect(new World().sorted().rec(sort({ defects: [['CHIPPED', '10'], ['FOREIGN', '0']] })).exceptions).toBeUndefined();
  });

  it('[PR-46] the defect catalogue as read: an unknown class is critical, foreign only when stated', () => {
    expect(defectsOf({ defects: [{ code: 'A', class: 'MAJOR' }, { code: 'B', class: 'ODD', foreign: 'yes' }, 'x', { code: 'C', class: 'MINOR', foreign: true }] })).toEqual([
      { code: 'A', class: 'MAJOR', foreign: false },
      { code: 'B', class: 'CRITICAL', foreign: false },
      { code: 'C', class: 'MINOR', foreign: true },
    ]);
    expect(defectsOf({})).toEqual([]);
  });
});

describe('TB-20 AQL', () => {
  it('[PR-29][DI-10] the plan of the scheme: letter by lot size and level, each class at its accept number (equal accepts), critical at zero, the sample capped at the lot', () => {
    const ev = (lot: bigint, found: Record<string, bigint>, sev: 'NORMAL' | 'TIGHTENED' = 'NORMAL', cfg: Json = CFG) => evaluateAql(cfg, sev, lot, found);
    // 199 680 at level II: letter P (800); major 0.65 at P: 10/11; minor 2.5 at P: arrow to N (500) 21/22.
    expect(ev(199680n, { MAJOR: 10n, MINOR: 21n })).toStrictEqual({
      scheme: 'AQL-SINGLE-SAMPLING', schemeVersion: '1', severity: 'NORMAL', level: 'II', lotSize: '199680', letter: 'P', sampleSize: '800',
      classes: {
        CRITICAL: { ac: '0', re: '1', found: '0', accepted: true },
        MAJOR: { aql: '0.65', letter: 'P', n: '800', ac: '10', re: '11', found: '10', accepted: true },
        MINOR: { aql: '2.5', letter: 'N', n: '500', ac: '21', re: '22', found: '21', accepted: true },
      },
      result: 'ACCEPTED',
    });
    expect(ev(199680n, { MAJOR: 11n })?.['result']).toBe('REJECTED');
    expect(ev(199680n, { MINOR: 22n })?.['result']).toBe('REJECTED');
    expect(ev(199680n, { CRITICAL: 1n })?.['result']).toBe('REJECTED');
    // The larger of the two plans' samples, capped at the lot (a lot of 2 tablets: letter A).
    expect(ev(2n, {})?.['sampleSize']).toBe('2');
    expect(ev(1n, {})).toBeUndefined();
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: { level: 'II', major: '0.010', minor: '2.5' } })?.['sampleSize']).toBe('1250');
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: { level: 'II', major: '2.5', minor: '0.010' } })?.['sampleSize']).toBe('1250');
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: undefined })).toBeUndefined();
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: { level: 'IV', major: '0.65', minor: '2.5' } })).toBeUndefined();
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: { level: 'II', major: '0.65' } })).toBeUndefined();
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: { level: 'II', major: '0.65', minor: '9.9' } })).toBeUndefined();
    expect(ev(199680n, {}, 'NORMAL', { ...CFG, aql: { level: 'II', major: '9.9', minor: '0.65' } })).toBeUndefined();
    expect(ev(199680n, {}, 'TIGHTENED')?.['severity']).toBe('TIGHTENED');
  });

  it('[PR-29][PR-46][INV-41] the AQL sample is drawn from the sorted lot once; findings beyond the sample are refused; a rejected lot waits for QA', () => {
    const w = new World().sorted();
    expect(w.rec({ kind: 'AQL_RESULT', severity: 'NORMAL', found: {} }).refused).toBe('The AQL sample of p@ is drawn from the sorted lot (TB20-AQL-EARLY; PR-29, PR-46)');
    w.rec(sort({ inspected: ['200000', '50'], accepted: ['199990', '49.9975'] }));
    expect(w.rec({ kind: 'AQL_RESULT', severity: 'NORMAL', found: { MINOR: '801' } }).refused).toBe('More defects in a class than the 800 tablets of the sample (TB20-FOUND; PR-29)');
    const rej = w.rec({ kind: 'AQL_RESULT', severity: 'ODD', found: { MAJOR: '11', MINOR: 5 } });
    expect(rej.data).toMatchObject({ severity: 'NORMAL', lotSize: '199990', result: 'REJECTED', classes: { MINOR: { found: '0' } }, recordedBy: 'OP1' });
    expect(rej.exceptions?.map((x) => [x['type'], x['title'], x['until'], x['releaseBlocking']])).toEqual([
      ['AQL_REJECTED', 'The AQL sample of p@ (800 tablets, normal inspection) rejects the lot: QA decides; it is re-inspected or re-sorted only through an approved reprocessing', 'DISPOSITION', true],
    ]);
    expect(w.rec({ kind: 'AQL_RESULT', severity: 'NORMAL', found: {} }).refused).toBe(
      'p@ already records its AQL result: a rejected lot is re-inspected only through an approved reprocessing, never by a new sample here (TB20-AQL-TWICE; INV-41, PR-47)',
    );
    const small = new World().sorted();
    small.rec(sort({ inspected: ['11', '0.00275'], accepted: ['1', '0.00025'] }));
    expect(small.rec({ kind: 'AQL_RESULT', severity: 'NORMAL', found: {} }).refused).toBe("The sampling scheme has no plan for a lot of 1 tablets at the MBR's AQL values (TB20-NO-PLAN; PR-29, DI-10)");
    const ok = new World().sorted();
    ok.rec(sort());
    expect(ok.rec({ kind: 'AQL_RESULT', severity: 'TIGHTENED', found: {} })).toMatchObject({ data: { result: 'ACCEPTED' } });
  });

  it('[PR-46][PR-29] PERFORMED needs the inspection ended, the sort result and the AQL result', () => {
    const before = (w: World) => (TB20.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(w.view()).map((p) => p.message);
    const w = new World();
    expect(before(w)).toEqual(['p@ has not finished its inspection (TB20-NOT-SORTED; PR-46)', 'p@ has no sort result (TB20-NO-SORT; PR-46, IN-35)', 'p@ has no AQL result (TB20-NO-AQL; PR-29)']);
    w.sorted();
    w.rec(sort());
    w.rec({ kind: 'AQL_RESULT', severity: 'NORMAL', found: {} });
    expect(before(w)).toEqual([]);
  });
});

describe('TB-20 definition checks', () => {
  const P = (config: Json, after: flow.FlowNode[] = [DESTROY], extra: flow.FlowNode[] = []): string[] => {
    const p = fixturePhase(TB20, { config: config as never });
    const m = mbrWithChildren([...extra, p, ...after, phase('after')]);
    const check = TB20.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check(p, p.config as Json, m).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  it('[PR-46][PR-50][PR-29] the catalogue (each code once; a foreign tablet critical), the AQL, the vision recipe, residue only with a recovery step', () => {
    expect(P({})).toEqual([]);
    expect(P({ defects: [] })).toEqual(['TB20-CATALOGUE [PR-46] Inspection step p has a defect catalogue, each code once']);
    expect(P({ defects: [{ code: 'A', class: 'MAJOR' }, { code: 'A', class: 'MINOR' }] })).toEqual(['TB20-CATALOGUE [PR-46] Inspection step p has a defect catalogue, each code once']);
    expect(P({ defects: [{ code: 'F', class: 'MAJOR', foreign: true }] })).toEqual(['TB20-CATALOGUE [PR-46,PR-50] A foreign or other-product tablet is a critical defect (p)']);
    expect(P({ aql: undefined })).toEqual(['TB20-AQL [PR-29] Inspection step p sets the inspection level and the AQL of the major and minor defects']);
    expect(P({ mode: 'VISION' })).toEqual(['TB20-VISION [PR-46] The vision sorter of p runs a named recipe']);
    expect(P({ mode: 'VISION', visionRecipe: 'VR-1' })).toEqual([]);
    expect(P({ reusableResidue: true })).toEqual(['TB20-RESIDUE [PR-46,PR-47] Reusable residue of p needs a recovery step (TB-08) in the MBR']);
    expect(P({ reusableResidue: true }, [DESTROY], [phase('rec', { block: { type: 'TB-08', version: '1' } })])).toEqual([]);
  });

  it('[PR-46][IN-35] the rejects are destroyed in a later, witnessed, never skippable G-23 step of the same sequence', () => {
    const msg = (d: string) => `TB20-DESTRUCTION [PR-46,IN-35] The rejects of p are destroyed in a witnessed G-23 step: ${d}`;
    expect(P({ destructionStep: undefined })).toEqual([msg('(none) is not a G-23 step of the MBR')]);
    expect(P({ destructionStep: 'after' })).toEqual([msg('after is not a G-23 step of the MBR')]);
    expect(P({}, [{ ...DESTROY, config: { witness: false } }])).toEqual([msg('G-23 step destroy does not destroy under a witness')]);
    expect(P({}, [{ ...DESTROY, signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } } }])).toEqual([msg('G-23 step destroy does not destroy under a witness')]);
    expect(P({}, [{ ...DESTROY, config: { skippable: true } }])).toEqual([msg('G-23 step destroy is declared skippable')]);
    expect(P({}, [], [DESTROY])).toEqual([msg('G-23 step destroy is not a later step of the inspection\'s sequence')]);
    const p = fixturePhase(TB20);
    expect(destructionProblem(blockMbr(TB20, p), 'p', p.config as Json)).toBeUndefined();
  });
});
