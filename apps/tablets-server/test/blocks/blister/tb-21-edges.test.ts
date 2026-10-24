/**
 * TB-21@1 blister or strip line set-up, line check and sealing (IN-38, PR-33, PR-37) at its edges, through its handler on
 * a minimal view: the change parts and reels the pack format takes, the independent check, the run's order, reel
 * changes, defect checks at the MBR's maximum, rejects, the count reconciliation (zero unexplained, either sign
 * otherwise) and PERFORMED per part; then every definition check. Written for the Phase 3 exit mutation run
 * (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { changePartsOf, materialsOf, TB21 } from '../../../src/blocks/tb-21.ts';
import { countSum } from '../../../src/blocks/blister/common.ts';
import { fixturePhase, mbrWithChildren, phase } from '../coating/support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const RUN = (TB21.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;
const LINE: Json = { ...RUN, part: 'LINE_CHECK', defectCheck: undefined, actuals: undefined, manualFallback: undefined, maxAgeSeconds: undefined };

class World {
  entries: E[] = [];
  constructor(readonly config: Json) {}
  view(): blocks.HandlerView {
    return { phase: { id: 'p', block: { type: 'TB-21', version: '1' }, equipment: [] }, config: this.config, stepKey: 'p@', nowUs: 0n, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB21.handler?.acceptEntry?.bind(TB21.handler) as unknown as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: 0n });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return (TB21.handler?.beforePerform?.bind(TB21.handler) as unknown as (v: blocks.HandlerView) => { message: string }[])(this.view()).map((p) => p.message).filter((m) => m.includes('TB21-'));
  }
}
const reels = [{ role: 'FORMING_FILM', material: 'PVC-250', lot: 'L1' }, { role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L2' }];
const setup = (extra: Json = {}) => ({ kind: 'LINE_SETUP', machine: 'M-1', artworkSet: 'FOIL:ART-1', changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'], materials: reels, ...extra });

describe('TB-21 line check', () => {
  it('[IN-38][PR-33] the set-up scans exactly the pack format\'s change parts and one reel of each web of its material, once', () => {
    const r = (extra: Json, cfg: Json = LINE) => new World(cfg).rec(setup(extra));
    expect(r({ changeParts: ['FORM-TOOL-10'] }).refused).toBe("The change parts scanned are not the pack format's (missing SEAL-PLATE-10) (TB21-CHANGE-PART; IN-38, PR-33)");
    expect(r({ changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10', 'X'] }).refused).toBe("The change parts scanned are not the pack format's (not of the format X) (TB21-CHANGE-PART; IN-38, PR-33)");
    expect(r({ changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10', 'FORM-TOOL-10'] }).refused).toBe("The change parts scanned are not the pack format's (one scanned twice) (TB21-CHANGE-PART; IN-38, PR-33)");
    expect(r({ changeParts: 'x' }).refused).toMatch(/missing FORM-TOOL-10, missing SEAL-PLATE-10/);
    expect(r({ materials: [reels[0]] }).refused).toBe('One reel of the lidding foil is scanned at the set-up (TB21-MATERIAL; PR-33)');
    expect(r({ materials: [reels[0], reels[0], reels[1]] }).refused).toBe('One reel of the forming film is scanned at the set-up (TB21-MATERIAL; PR-33)');
    expect(r({ materials: [reels[0], { ...reels[1], material: 'ALU-30' }] }).refused).toBe('The lidding foil of the pack format is ALU-20, not ALU-30 (TB21-MATERIAL; PR-33)');
    expect(r({ materials: [...reels, { role: 'STRIP_FOIL', material: 'S', lot: 'L3' }] }).refused).toBe('A reel scanned is not a web of the pack format (TB21-MATERIAL; PR-33)');
    expect(r({ materials: [...reels, 'x'] }).refused).toBe('A reel scanned is not a web of the pack format (TB21-MATERIAL; PR-33)');
    const printed = { ...LINE, materials: [{ role: 'FORMING_FILM', material: 'PVC-250' }, { role: 'LIDDING_FOIL', material: 'ALU-20', item: 'FOIL' }] };
    const w = new World(printed);
    expect(w.rec(setup()).data).toStrictEqual({
      machine: 'M-1', artworkSet: 'FOIL:ART-1', changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'], materials: reels,
      reels: [{ role: 'FORMING_FILM', material: 'PVC-250', lot: 'L1' }, { role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L2', item: 'FOIL' }], setUpBy: 'OP1',
    });
    expect(w.rec(setup()).refused).toBe('p@ already records its line set-up (TB21-SETUP-TWICE; IN-38)');
  });

  it('[IN-38] the independent check follows the set-up; it passes only with rogues removed, change parts fitted and the detector passing; PERFORMED needs a passing last check', () => {
    const w = new World(LINE);
    const check = (extra: Json = {}) => ({ kind: 'EQUIPMENT_CHECK', rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS', ...extra });
    expect(w.rec(check()).refused).toBe('Set up the line of p@ first (TB21-NO-SETUP; IN-38)');
    expect(w.before()).toEqual(['p@ has no line set-up (TB21-NO-SETUP; IN-38)', 'p@ has no passing independent equipment check (TB21-CHECK; IN-38)']);
    w.rec(setup());
    for (const bad of [{ rogueRemoved: false }, { changePartsFitted: false }, { emptyPocketDetector: 'FAIL' }]) expect(w.rec(check(bad)).data?.['result'], JSON.stringify(bad)).toBe('FAIL');
    expect(w.before()).toEqual(['p@ has no passing independent equipment check (TB21-CHECK; IN-38)']);
    expect(w.rec(check())).toStrictEqual({ data: { rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS', result: 'PASS', checkedBy: 'OP1' }, verificationRequired: true });
    expect(w.before()).toEqual([]);
    expect(w.rec({ kind: 'RUN_START' }).refused).toBe('RUN_START is not an entry of the line check part of a blister step (TB21-PART; IN-38)');
  });
});

describe('TB-21 run', () => {
  it('[PR-37] the run starts once; only its entries; nothing before the start; after the end only the count and defect checks', () => {
    const w = new World(RUN);
    expect(w.rec({ kind: 'LINE_SETUP' }).refused).toBe('LINE_SETUP is not an entry of a blister run (TB21-ENTRY; PR-37)');
    expect(w.rec({ kind: 'RUN_END' }).refused).toBe('p@ has not started its run (TB21-NOT-STARTED; PR-37)');
    expect(w.rec({ kind: 'RUN_START', machine: 'M-1' }).data).toStrictEqual({ machine: 'M-1', startedBy: 'OP1' });
    expect(w.rec({ kind: 'RUN_START', machine: 'M-1' }).refused).toBe('p@ has started its run already; a new run is a new step (TB21-TWICE; PR-37)');
    expect(w.rec({ kind: 'COUNT', formed: '1', good: '1', setupWaste: '0', samples: '0' }).refused).toBe('The run of p@ has not ended: the count comes after it (TB21-RUNNING; PR-37)');
    expect(w.rec({ kind: 'RUN_END' }).data).toStrictEqual({ endedBy: 'OP1' });
    expect(w.rec({ kind: 'REJECTS', emptyPocket: '1' }).refused).toBe('The run of p@ has ended (TB21-ENDED; PR-37)');
    expect(w.rec({ kind: 'REEL_CHANGE', ...reels[0] }).refused).toBe('The run of p@ has ended (TB21-ENDED; PR-37)');
    expect(w.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: {} }).data?.['result']).toBe('PASS');
  });

  it('[PR-33][PR-37] a reel change is a web of the format of its material, checked by a second person', () => {
    const w = new World({ ...RUN, materials: [{ role: 'FORMING_FILM', material: 'PVC-250', item: 'F' }, { role: 'LIDDING_FOIL', material: 'ALU-20' }] });
    w.rec({ kind: 'RUN_START', machine: 'M-1' });
    expect(w.rec({ kind: 'REEL_CHANGE', role: 'STRIP_FOIL', material: 'X', lot: 'L' }).refused).toBe('STRIP_FOIL is not a web of the pack format (TB21-MATERIAL; PR-33)');
    expect(w.rec({ kind: 'REEL_CHANGE', role: 'FORMING_FILM', material: 'PVC-300', lot: 'L' }).refused).toBe('The forming film of the pack format is PVC-250, not PVC-300 (TB21-MATERIAL; PR-33)');
    expect(w.rec({ kind: 'REEL_CHANGE', role: 'FORMING_FILM', material: 'PVC-250', lot: 'L9' })).toStrictEqual({ data: { role: 'FORMING_FILM', material: 'PVC-250', lot: 'L9', item: 'F', changedBy: 'OP1' }, verificationRequired: true });
    expect(w.rec({ kind: 'REEL_CHANGE', role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L8' }).data).toStrictEqual({ role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L8', changedBy: 'OP1' });
  });

  it('[IN-38][PR-37] a defect check examines the MBR\'s sample; defects up to the maximum pass (D 0); more fail and hold, with the title', () => {
    const w = new World({ ...RUN, defectCheck: { examined: '20', maxDefects: '1' } });
    w.rec({ kind: 'RUN_START', machine: 'M-1' });
    expect(w.rec({ kind: 'DEFECT_CHECK', examined: '19', defects: {} }).refused).toBe('A defect check examines the 20 blisters the MBR sets, not 19 (TB21-SAMPLE; PR-37)');
    expect(w.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: { MISPRINT: '20', FOIL_CUT: '1' } }).refused).toBe('More defects (21) than blisters examined (20) (TB21-DEFECTS; PR-37)');
    expect(w.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: { MISPRINT: '1', OTHER: '5' } })).toStrictEqual({
      data: { examined: '20', defectCounts: { MISPRINT: '1', FOIL_CUT: '0', MISSING_TABLET: '0', IMPROPER_SEAL: '0' }, defectTotal: '1', result: 'PASS', checkedBy: 'OP1' },
    });
    expect(w.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: { MISPRINT: '1', IMPROPER_SEAL: '1' } }).exceptions?.map((x) => [x['type'], x['title'], x['until']])).toEqual([
      ['DEFECT_CHECK_FAILED', "A defect check failed (2 defects in 20 blisters); the machine's output since the last passing check is held at p@: the steps after it wait for a deviation", 'DEVIATION'],
    ]);
    const d0 = new World(RUN);
    d0.rec({ kind: 'RUN_START', machine: 'M-1' });
    expect(d0.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: { FOIL_CUT: '1' } }).data?.['result']).toBe('FAIL');
    const none = new World({ ...RUN, defectCheck: undefined });
    none.rec({ kind: 'RUN_START', machine: 'M-1' });
    expect(none.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: {} }).refused).toBe('A defect check examines the - blisters the MBR sets, not 20 (TB21-SAMPLE; PR-37)');
  });

  it('[PR-37] the count reconciles formed blisters against good, rejects, set-up waste and samples: nothing unexplained, or BLISTER_COUNT_UNEXPLAINED either way; good units by blister size', () => {
    const counted = (count: Json, rejects: Json[] = [{ emptyPocket: '18', brokenPocket: '4', vision: '8' }], cfg: Json = RUN) => {
      const w = new World(cfg);
      w.rec({ kind: 'RUN_START', machine: 'M-1' });
      for (const r of rejects) w.rec({ kind: 'REJECTS', ...r });
      w.rec({ kind: 'RUN_END' });
      return { w, r: w.rec({ kind: 'COUNT', ...count }) };
    };
    const ok = counted({ formed: '10000', good: '9900', setupWaste: '60', samples: '10' });
    expect(ok.r).toStrictEqual({ data: { formed: '10000', good: '9900', rejects: '30', setupWaste: '60', samples: '10', unexplained: '0', goodUnits: '99000', recordedBy: 'OP1' } });
    expect(ok.w.rec({ kind: 'COUNT', formed: '1', good: '1', setupWaste: '0', samples: '0' }).refused).toBe('p@ already records its count (TB21-COUNT-TWICE; PR-37)');
    const over = counted({ formed: '10001', good: '9900', setupWaste: '60', samples: '10' }).r;
    expect(over.exceptions?.map((x) => [x['type'], x['title']])).toEqual([
      ['BLISTER_COUNT_UNEXPLAINED', '1 blisters of the run are not explained by good output, rejects, set-up waste and samples at p@: the steps after it wait for a deviation'],
    ]);
    expect(counted({ formed: '9999', good: '9900', setupWaste: '60', samples: '10' }).r.data?.['unexplained']).toBe('-1');
    expect(counted({ formed: '100', good: '90', setupWaste: '0', samples: '0' }, [{ emptyPocket: '4' }, { vision: '6' }]).r.data).toMatchObject({ rejects: '10', unexplained: '0' });
    expect(counted({ formed: '5', good: '5', setupWaste: '0', samples: '0' }, [], { ...RUN, packFormat: { form: 'THERMOFORM' } }).r.data).toMatchObject({ goodUnits: '5' });
    const w = new World(RUN);
    w.rec({ kind: 'RUN_START', machine: 'M-1' });
    expect(w.rec({ kind: 'REJECTS', emptyPocket: '2', vision: 3 })).toStrictEqual({ data: { emptyPocket: '2', brokenPocket: '0', vision: '0', total: '2', recordedBy: 'OP1' } });
    w.rec({ kind: 'RUN_END' });
    expect(w.rec({ kind: 'COUNT', formed: '2', good: '0', setupWaste: '0', samples: '0' }).data).toMatchObject({ rejects: '2', unexplained: '0' });
    expect(w.rec({ kind: 'REJECTS', emptyPocket: '1' }).refused).toBe('The run of p@ has ended (TB21-ENDED; PR-37)');
    expect(countSum(['1', 2, '03', 'x', '9999999999999999999'])).toBe(4n);
  });

  it('[PR-37] PERFORMED of the run: ended, counted, and a passing last defect check', () => {
    const w = new World(RUN);
    w.rec({ kind: 'RUN_START', machine: 'M-1' });
    expect(w.before()).toEqual(['The run of p@ has not ended (TB21-RUNNING; PR-37)']);
    w.rec({ kind: 'RUN_END' });
    expect(w.before()).toEqual(['Record the count of p@ first (TB21-NO-COUNT; PR-37)', 'p@ has no defect check (TB21-NO-CHECK; PR-37)']);
    w.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: { MISPRINT: '1' } });
    w.rec({ kind: 'COUNT', formed: '0', good: '0', setupWaste: '0', samples: '0' });
    expect(w.before()).toEqual(['The last defect check of p@ failed: a passing check comes after it (TB21-LAST-CHECK; PR-37)']);
    w.rec({ kind: 'DEFECT_CHECK', examined: '20', defects: {} });
    expect(w.before()).toEqual([]);
  });
});

describe('TB-21 definition checks', () => {
  const g21 = (items: Json[]) => phase('pr', { block: { type: 'G-21', version: '1' }, config: { items } as never });
  const P = (config: Json, extra: Partial<flow.PhaseNode> = {}, others: flow.FlowNode[] = []): string[] => {
    const p = fixturePhase(TB21, { ...extra, config: config as never });
    const check = TB21.checkConfig?.bind(TB21) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check(p, p.config as Json, mbrWithChildren([...others, p, phase('after')])).filter((x) => x.code.startsWith('TB21')).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  const W = 'Blister step p';

  it('[PR-33] a peel-off blister (slice 7q, C8): the pack format states its opening; a cold-form or thermoform blister may be peel-off or peel-push, a strip pack has no lidding foil to peel', () => {
    const FORMAT = RUN['packFormat'] as Json;
    const cold = { role: 'FORMING_FILM', material: 'OPA-ALU-PVC' };
    const peel = { role: 'LIDDING_FOIL', material: 'PAPER-PET-ALU-PEEL' };
    expect(P({ packFormat: { ...FORMAT, form: 'COLD_FORM', opening: 'PEEL_OFF' }, materials: [cold, peel] })).toEqual([]);
    expect(P({ packFormat: { ...FORMAT, form: 'THERMOFORM', opening: 'PEEL_PUSH' } })).toEqual([]);
    expect(P({ packFormat: { ...FORMAT, opening: 'PUSH_THROUGH' } })).toEqual([]);
    const strip = { materials: [{ role: 'STRIP_FOIL', material: 'S' }], actuals: (RUN['actuals'] as Json[]).slice(1) };
    expect(P({ ...strip, packFormat: { ...FORMAT, form: 'STRIP', opening: 'PEEL_OFF' } })).toEqual([`TB21-OPENING [PR-33] ${W}: a strip pack has no lidding foil to peel; a peel-off opening is a blister's (THERMOFORM or COLD_FORM)`]);
    expect(P({ ...strip, packFormat: { ...FORMAT, form: 'STRIP', opening: 'PUSH_THROUGH' } })).toEqual([]);
    const opening = (((TB21.configSchema as blocks.ObjectSchema).fields['packFormat'] as blocks.ObjectSchema).fields['opening'] as unknown as { enum: string[]; optional: boolean });
    expect([opening.enum, opening.optional]).toEqual([['PUSH_THROUGH', 'PEEL_OFF', 'PEEL_PUSH'], true]);
  });

  it('[IN-38][PR-33] the pack format: change parts once; the webs its form takes, each once; printed webs named on the MBR\'s G-21 step with their material', () => {
    expect(P({})).toEqual([]);
    expect(P({ packFormat: { form: 'THERMOFORM', changeParts: ['A', 'A'] } })).toEqual([`TB21-FORMAT [IN-38] ${W} lists a change part twice`]);
    expect(P({ materials: [{ role: 'FORMING_FILM', material: 'P' }] })).toEqual([`TB21-MATERIALS [PR-33] ${W}: a thermoform pack takes FORMING_FILM and LIDDING_FOIL, each once`]);
    expect(P({ materials: [{ role: 'FORMING_FILM', material: 'P' }, { role: 'LIDDING_FOIL', material: 'A' }, { role: 'LIDDING_FOIL', material: 'B' }] })).toEqual([`TB21-MATERIALS [PR-33] ${W}: a thermoform pack takes FORMING_FILM and LIDDING_FOIL, each once`]);
    expect(P({ materials: [{ role: 'FORMING_FILM', material: 'P' }, { role: 'LIDDING_FOIL', material: 'A' }, { role: 'STRIP_FOIL', material: 'S' }] })).toEqual([`TB21-MATERIALS [PR-33] ${W}: a thermoform pack takes FORMING_FILM and LIDDING_FOIL, each once`]);
    expect(P({ packFormat: { form: 'STRIP' }, materials: [{ role: 'STRIP_FOIL', material: 'S' }], actuals: (RUN['actuals'] as Json[]).slice(1) })).toEqual([]);
    expect(P({ packFormat: { form: 'COLD_FORM' }, materials: [{ role: 'STRIP_FOIL', material: 'S' }] })).toEqual([`TB21-MATERIALS [PR-33] ${W}: a cold form pack takes FORMING_FILM and LIDDING_FOIL, each once`]);
    expect(P({ packFormat: {}, materials: [] })).toEqual([`TB21-MATERIALS [PR-33] ${W}: a  pack takes FORMING_FILM and LIDDING_FOIL, each once`]);
    const printed = { materials: [{ role: 'FORMING_FILM', material: 'PVC-250' }, { role: 'LIDDING_FOIL', material: 'ALU-20', item: 'FOIL' }] };
    expect(P(printed)).toEqual([`TB21-PRINTED [PR-33] ${W} names no G-21 step of the MBR for its printed webs`]);
    expect(P({ ...printed, printedStep: 'after' })).toEqual([`TB21-PRINTED [PR-33] ${W} names no G-21 step of the MBR for its printed webs`]);
    expect(P({ ...printed, printedStep: 'pr' }, {}, [g21([{ id: 'FOIL', material: 'ALU-30' }])])).toEqual(['TB21-PRINTED [PR-33] G-21 step pr has no item FOIL of material ALU-20']);
    expect(P({ ...printed, printedStep: 'pr' }, {}, [g21([{ id: 'LEAF', material: 'ALU-20' }, 'x' as never])])).toEqual(['TB21-PRINTED [PR-33] G-21 step pr has no item FOIL of material ALU-20']);
    expect(P({ ...printed, printedStep: 'pr' }, {}, [g21([{ id: 'FOIL', material: 'ALU-20' }])])).toEqual([]);
    expect(P({ printedStep: 'pr' }, {}, [g21([])])).toEqual([`TB21-PRINTED [PR-33] ${W} names a G-21 step but no printed web`]);
  });

  it('[IN-38] the line check: an independent verifier, and none of the run\'s members', () => {
    expect(P(LINE, { signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } } })).toEqual([]);
    expect(P(LINE, { signatures: { perform: { role: 'OPERATOR' } } })).toEqual([`TB21-INDEPENDENT [IN-38] ${W}: the independent line check has a verifier besides the performer`]);
    expect(P({ ...LINE, setpoints: [], actuals: [], criticalAlarms: [], defectCheck: {} }, { signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } } })).toEqual([
      `TB21-PART [IN-38] ${W}: setpoints belongs to the run part`,
      `TB21-PART [IN-38] ${W}: actuals belongs to the run part`,
      `TB21-PART [IN-38] ${W}: criticalAlarms belongs to the run part`,
      `TB21-PART [IN-38] ${W}: defectCheck belongs to the run part`,
    ]);
  });

  it('[PR-37] the run: a machine it uses, the sealing values (and forming for a thermoform) with both limits, the defect-check sample', () => {
    expect(P({}, { equipment: [{ ref: 'LINE', use: 'STATUS_CHECK' }] })).toEqual([`TB21-NO-EQUIPMENT [PR-37] ${W} names no blister machine it uses`]);
    const actuals = RUN['actuals'] as Json[];
    expect(P({ actuals: [actuals[0], actuals[1], actuals[2], { ...actuals[3], max: undefined }] })).toEqual([`TB21-SEALING [PR-37] ${W} collects blister.seal_dwell_s with its validated range (lower and upper limit)`]);
    expect(P({ actuals: [actuals[0], { ...actuals[1], min: undefined }, actuals[2], actuals[3]] })).toEqual([`TB21-SEALING [PR-37] ${W} collects blister.seal_temp_C with its validated range (lower and upper limit)`]);
    expect(P({ actuals: actuals.slice(1) })).toEqual([`TB21-FORMING [PR-37] ${W} collects blister.form_temp_C with its validated range`]);
    expect(P({ packFormat: { form: 'COLD_FORM', changeParts: [] }, actuals: actuals.slice(1) })).toEqual([]);
    expect(P({ defectCheck: {} })).toEqual([`TB21-SAMPLE [PR-37] ${W} sets the blisters a defect check examines`]);
    expect(P({ defectCheck: 'x' })).toEqual([`TB21-SAMPLE [PR-37] ${W} sets the blisters a defect check examines`]);
  });

  it('[PR-33] the pack format as read', () => {
    expect(changePartsOf({ packFormat: { changeParts: ['A', 2, 'B'] } })).toEqual(['A', 'B']);
    expect(changePartsOf({ packFormat: 'x' })).toEqual([]);
    expect(materialsOf({ materials: [{ role: 'R', material: 'M', item: 3 }, 'x'] })).toEqual([{ role: 'R', material: 'M' }]);
    expect(materialsOf({})).toEqual([]);
  });

  it('[DI-34] the nominal path of each part', () => {
    const nominal = (config: Json) => {
      const p = fixturePhase(TB21, { config: config as never });
      return (TB21.simulatorModel?.nominalEntries({ phase: p, config: p.config, mbr: mbrWithChildren([p]), frames: [], containers: [], target: () => undefined }) ?? []).filter((x) => !['RECIPE_CHECK', 'ACTUAL', 'SETPOINT_READBACK'].includes(x.kind));
    };
    expect(nominal(LINE)).toEqual([
      { kind: 'LINE_SETUP', machine: 'TEST-BLISTER-01', artworkSet: 'FOIL:ART-1', changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'], materials: [{ role: 'FORMING_FILM', material: 'PVC-250', lot: 'LOT-FORMING_FILM' }, { role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'LOT-LIDDING_FOIL' }] },
      { kind: 'EQUIPMENT_CHECK', rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS' },
    ]);
    expect(nominal({}).map((x) => x.kind)).toEqual(['RUN_START', 'DEFECT_CHECK', 'RUN_END', 'COUNT']);
    expect(nominal({ defectCheck: undefined }).find((x) => x.kind === 'DEFECT_CHECK')?.['examined']).toBe('1');
    expect(TB21.simulatorModel?.exceptionTypes({ config: LINE } as never)).toEqual([]);
    expect(TB21.simulatorModel?.exceptionTypes({ config: RUN } as never)).toEqual(['PROCESS_VALUE_OUT_OF_LIMITS', 'DEFECT_CHECK_FAILED', 'BLISTER_COUNT_UNEXPLAINED']);
  });
});
