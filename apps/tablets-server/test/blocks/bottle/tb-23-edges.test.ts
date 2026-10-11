/**
 * The bottle line (TB-23@1; PR-37, PR-38, PR-41, IN-17, IN-22) and the packaging-line helpers it shares with TB-24, at
 * their edges, through the handler on a minimal view: scheduled checks per stream (missed strictly after the interval,
 * failed), counts, torque within both ranges (ends allowed), the seal and the tamper-evident statement, a stopped line,
 * bright stock set aside and labelled back by its scan, the good output once, PERFORMED and the definition checks.
 * Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { big, checkExceptions, deviceConfig, deviceConfigProblems, deviceStream, g21Phase, intervalOf, lastCheck, missedNow, phasesOf, sharedUnitProblem, stoppedDevices, streamProblems, usOtcRetail } from '../../../src/blocks/bottle/common.ts';
import { brightLeft, labelStepProblem, productOf, streamsOf, tamperEvidentProblem, TB23 } from '../../../src/blocks/tb-23.ts';
import { mbrWithChildren, phase } from '../coating/support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint; recordedSeq: number };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const CFG = (TB23.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;
const MBR = { header: { product: { code: 'P', name: 'Product', strength: '10 mg' }, predicates: {} } } as unknown as flow.MbrContent;

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return {
      phase: { id: 'p', block: { type: 'TB-23', version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      actor: { id: 'OP1' },
      mbr: MBR,
      batch: { batchNumber: 'B-1' },
    } as unknown as blocks.HandlerView;
  }
  push(kind: string, data: Json): void {
    this.entries.push({ id: `E${this.entries.length + 1}`, kind, data, recordedAt: this.now, recordedSeq: this.entries.length + 1 });
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[] } {
    const accept = TB23.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.push(entry.kind, r.data ?? {});
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
}

describe('packaging-line helpers', () => {
  it('[IN-22][PR-37] the last check of a stream (by recording order), missed strictly after its interval, and the held exceptions with their titles', () => {
    const w = new World();
    expect(lastCheck(w.view(), 'COUNT')).toBeUndefined();
    w.push('COUNT_CHECK', { stream: 'COUNT', result: 'PASS' });
    w.push('COUNT_CHECK', { stream: 'COUNT' });
    w.push('TORQUE_CHECK', { stream: 'TORQUE', result: 'FAIL' });
    w.entries.push({ id: 'X', kind: 'COUNT_CHECK', data: { stream: 'COUNT', result: 'FAIL' }, recordedAt: T - 1n, recordedSeq: 0 });
    expect(lastCheck(w.view(), 'COUNT')).toEqual({ recordedAt: T, data: { stream: 'COUNT', result: 'PASS' }, seq: 1 });
    w.now = T + 30n * MIN;
    expect(missedNow(w.view(), 'COUNT', 30n * MIN)).toBe(false);
    w.now = T + 30n * MIN + 1n;
    expect(missedNow(w.view(), 'COUNT', 30n * MIN)).toBe(true);
    expect(missedNow(w.view(), 'COUNT', undefined)).toBe(false);
    expect(missedNow(w.view(), 'SEAL', 1n)).toBe(false);
    expect(checkExceptions(w.view(), 'COUNT', 'count check', true, false, ['PR-37'])).toEqual([
      { type: 'LINE_CHECK_MISSED', title: 'The count check of p@ was not done within its interval: the output of the line since the last passing count check is held and the steps after it wait for a deviation', controls: ['PR-37'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'COUNT' },
      { type: 'LINE_CHECK_FAILED', title: 'A count check of p@ failed: the output of the line since the last passing count check is held and the steps after it wait for a deviation', controls: ['PR-37'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'COUNT' },
    ]);
    expect(checkExceptions(w.view(), 'COUNT', 'x', false, true, [])).toEqual([]);
    const streams = [{ stream: 'COUNT', every: 30n * MIN, what: 'count check' }, { stream: 'TORQUE', every: undefined, what: 'torque check' }, { stream: 'SEAL', every: undefined, what: 'seal check' }];
    expect(streamProblems(w.view(), streams, 'TB23', ['PR-37']).map((p) => p.message)).toEqual([
      'p@ is due for its count check (TB23-CHECK-DUE; PR-37)',
      'The last torque check of p@ failed: a passing one comes after it (TB23-LAST-CHECK; PR-37)',
      'p@ has no seal check (TB23-NO-CHECK; PR-37)',
    ]);
    w.now = T + 30n * MIN;
    expect(streamProblems(w.view(), streams.slice(0, 1), 'TB23', ['PR-37'])).toEqual([]);
  });

  it('[IN-22][PR-37] a device is stopped while its latest challenge (at the latest time) did not pass', () => {
    const w = new World();
    const ch = (device: string, result: string, at: bigint) => w.entries.push({ id: `${device}${at}`, kind: 'CHALLENGE', data: { device, result }, recordedAt: at, recordedSeq: 0 });
    ch('A', 'FAIL', T);
    ch('A', 'PASS', T + 1n);
    ch('B', 'PASS', T);
    ch('B', 'FAIL', T + 1n);
    ch('C', 'FAIL', T + 5n);
    ch('C', 'PASS', T + 5n);
    ch('D', 'FAIL', T + 9n);
    ch('D', 'PASS', T + 8n);
    expect(stoppedDevices(w.view())).toEqual(['B', 'D']);
  });

  it('[IN-22][PR-37] the line\'s unit is the step\'s own; devices are named once with whole-microsecond intervals; small helpers', () => {
    const p = (id: string, type: string, unit?: string) => phase(id, { block: { type, version: '1' }, config: unit === undefined ? {} : ({ unit } as never) });
    const m = mbrWithChildren([p('a', 'G-21', 'U1'), p('b', 'TB-23', 'U2'), p('c', 'TB-24', 'U3'), p('d', 'TB-23', 'U1')]);
    const me = phasesOf(m, 'TB-23')[0] as flow.PhaseNode;
    expect(phasesOf(m, 'TB-23').map((x) => x.id)).toEqual(['b', 'd']);
    expect(sharedUnitProblem(m, me, 'U2', 'C')).toEqual([]);
    expect(sharedUnitProblem(m, me, 'U3', 'C').map((x) => x.message)).toEqual(["b and c name the same plant unit U3: a passing check of one would vouch for the other's output"]);
    expect(sharedUnitProblem(m, me, 'U1', 'C').map((x) => [x.code, x.message, x.controls])).toEqual([['C', "b and a name the same plant unit U1: a passing check of one would vouch for the other's output", ['IN-22', 'PR-37']]]);
    expect(sharedUnitProblem(m, me, undefined, 'C').map((x) => x.message)).toEqual(['b names no plant unit of its line']);
    expect(g21Phase(m, 'a')?.id).toBe('a');
    expect(g21Phase(m, 'b')).toBeUndefined();
    expect(g21Phase(m, undefined)).toBeUndefined();
    expect(deviceConfigProblems(me, { devices: [{ id: 'X', kind: 'VISION' }, { id: 'X', kind: 'READER' }, { id: 'Y', kind: 'VISION', every: { value: '0.0000001', unit: 's' } }] }, 'D').map((x) => x.message)).toEqual([
      'b names device X twice',
      'The challenge interval of Y is not a whole number of microseconds',
    ]);
    expect(deviceConfigProblems(me, { devices: [{ id: 'X', kind: 'VISION', every: { value: '1', unit: 'h' } }] }, 'D')).toEqual([]);
    expect(deviceConfig({ devices: 'x' })).toEqual({ devices: [] });
    expect(deviceStream('SEALDET')).toBe('D.SEALDET');
    expect([big('12'), big('012'), big(3), big('x')]).toEqual([12n, 0n, 0n, 0n]);
    expect(intervalOf({ value: '2', unit: 'min' })).toBe(2n * MIN);
    expect(usOtcRetail({ header: { predicates: { usOtcRetail: true } } } as never)).toBe(true);
    expect(usOtcRetail({ header: { predicates: { usOtcRetail: 'yes' } } } as never)).toBe(false);
  });
});

describe('TB-23 bottle line', () => {
  it('[PR-37][IN-22] the scheduled checks: counts equal the MBR\'s count, desiccant present, torque within both ranges (ends allowed), seals sound; each missed or failed holds', () => {
    const w = new World();
    expect(w.rec({ kind: 'COUNT_CHECK', counts: ['30', '30'] }).data).toStrictEqual({ stream: 'COUNT', counts: ['30', '30'], expected: '30', result: 'PASS', missed: false, checkedBy: 'OP1' });
    expect(w.rec({ kind: 'COUNT_CHECK', counts: ['30', '31'] }).data?.['result']).toBe('FAIL');
    w.now = T + 30n * MIN + 1n;
    const late = w.rec({ kind: 'COUNT_CHECK', counts: ['30'] });
    expect([late.data?.['missed'], late.exceptions?.map((x) => x['type'])]).toEqual([true, ['LINE_CHECK_MISSED']]);
    expect(w.rec({ kind: 'DESICCANT_CHECK', examined: '20', missing: '21' }).refused).toBe('More bottles without a desiccant (21) than examined (20) (TB23-COUNTS; PR-37)');
    expect(w.rec({ kind: 'DESICCANT_CHECK', examined: '20', missing: '20' }).data).toMatchObject({ stream: 'DESICCANT', examined: '20', missing: '20', desiccant: 'SILICA-1G', result: 'FAIL' });
    expect(w.rec({ kind: 'DESICCANT_CHECK', examined: '20', missing: '0' }).data?.['result']).toBe('PASS');
    expect(new World({ ...CFG, desiccant: undefined }).rec({ kind: 'DESICCANT_CHECK', examined: '1', missing: '0' }).refused).toBe('The MBR names no desiccant for p (TB23-NO-DESICCANT; PR-37)');
    const torque = (application: string[], removal: string[], cfg: Json = CFG) => new World(cfg).rec({ kind: 'TORQUE_CHECK', tester: 'TQ', application, removal }).data;
    expect(torque(['1.8', '2.4'], ['1.0', '2.2'])).toStrictEqual({ stream: 'TORQUE', tester: 'TQ', application: ['1.8', '2.4'], removal: ['1.0', '2.2'], unit: 'N.m', result: 'PASS', missed: false, checkedBy: 'OP1' });
    expect(torque(['1.79'], ['1.5'])?.['result']).toBe('FAIL');
    expect(torque(['2.41'], ['1.5'])?.['result']).toBe('FAIL');
    expect(torque(['2.0'], ['0.99'])?.['result']).toBe('FAIL');
    expect(torque(['2.0'], ['2.21'])?.['result']).toBe('FAIL');
    expect(torque(['2.0'], ['1.5'], { ...CFG, torque: { unit: 'N.m', application: { min: '1.8' }, removal: { min: '1.0', max: '2.2' } } })?.['result']).toBe('FAIL');
    expect(torque(['2.0'], ['1.5'], { ...CFG, torque: undefined })).toMatchObject({ result: 'FAIL' });
    expect(new World().rec({ kind: 'SEAL_CHECK', examined: '20', defective: '21' }).refused).toBe('More defective seals (21) than bottles examined (20) (TB23-COUNTS; PR-37)');
    expect(new World().rec({ kind: 'SEAL_CHECK', examined: '20', defective: '1' }).data).toMatchObject({ stream: 'SEAL', examined: '20', defective: '1', result: 'FAIL' });
    expect(new World().rec({ kind: 'SEAL_CHECK', examined: '20', defective: '0' }).data).not.toHaveProperty('statementChecked');
  });

  it('[PR-41] a tamper-evident pack\'s seal check also checks the labelling statement; others state none', () => {
    const te = { ...CFG, tamperEvident: true };
    expect(new World(te).rec({ kind: 'SEAL_CHECK', examined: '20', defective: '0' }).refused).toBe("A US OTC retail pack's seal check also checks the labelling statement of the tamper-evident feature (TB23-TAMPER-EVIDENT; PR-41)");
    expect(new World().rec({ kind: 'SEAL_CHECK', examined: '20', defective: '0', statementChecked: true }).refused).toBe("Only a tamper-evident pack's seal check states the labelling statement check (TB23-TAMPER-EVIDENT; PR-41)");
    expect(new World(te).rec({ kind: 'SEAL_CHECK', examined: '20', defective: '0', statementChecked: false }).data).toMatchObject({ statementChecked: false, result: 'FAIL' });
    expect(new World(te).rec({ kind: 'SEAL_CHECK', examined: '20', defective: '0', statementChecked: true }).data).toMatchObject({ statementChecked: true, result: 'PASS' });
  });

  it('[PR-38][IN-17][IN-22] bright stock is set aside only where the MBR allows it, tagged and identified, and labelled back only by the scan of this batch and product, never more than is left; a stopped line counts no output', () => {
    expect(new World({ ...CFG, brightStock: false }).rec({ kind: 'BRIGHT_STOCK', bottles: '10' }).refused).toBe('The MBR does not let p set filled, unlabelled bottles aside (TB23-NO-BRIGHT-STOCK; PR-38)');
    const w = new World();
    expect(w.rec({ kind: 'BRIGHT_STOCK', bottles: '100' }).data).toStrictEqual({ tag: '1', bottles: '100', product: { code: 'P', name: 'Product', strength: '10 mg' }, batch: 'B-1', countPerBottle: '30', setAsideBy: 'OP1' });
    expect(w.rec({ kind: 'BRIGHT_STOCK', bottles: '50' }).data?.['tag']).toBe('2');
    const use = (extra: Json) => w.rec({ kind: 'BRIGHT_STOCK_USE', tag: '1', scannedBatch: 'B-1', scannedProduct: 'P', bottles: '60', ...extra });
    expect(use({ tag: '3' }).refused).toBe('3 is no bright stock of p@ (TB23-BRIGHT-STOCK-TAG; PR-38)');
    expect(use({ scannedBatch: 'B-2' }).refused).toBe('The bright stock scanned is of batch B-2 and product P: only this batch\'s own is labelled here (TB23-BRIGHT-STOCK-SCAN; PR-38)');
    expect(use({ scannedProduct: 'Q' }).refused).toMatch(/TB23-BRIGHT-STOCK-SCAN/);
    expect(use({}).data).toStrictEqual({ tag: '1', bottles: '60', scannedBatch: 'B-1', scannedProduct: 'P', usedBy: 'OP1' });
    expect(brightLeft(w.view(), '1')).toBe(40n);
    expect(use({ bottles: '41' }).refused).toBe('Only 40 bottles are left under 1 (TB23-BRIGHT-STOCK-QUANTITY; PR-38)');
    expect(use({ bottles: '40' }).data?.['bottles']).toBe('40');
    expect(brightLeft(w.view(), '1')).toBe(0n);
    expect(brightLeft(w.view(), '2')).toBe(50n);
    w.entries.push({ id: 'C', kind: 'CHALLENGE', data: { device: 'SEALDET', result: 'FAIL' }, recordedAt: T, recordedSeq: 99 });
    const stopped = 'The line of p@ is stopped: SEALDET failed its last challenge; no output is counted before a passing challenge (TB23-STOPPED; IN-22, PR-37)';
    expect(w.rec({ kind: 'BRIGHT_STOCK', bottles: '1' }).refused).toBe(stopped);
    expect(w.rec({ kind: 'BRIGHT_STOCK_USE', tag: '2', scannedBatch: 'B-1', scannedProduct: 'P', bottles: '1' }).refused).toBe(stopped);
    expect(w.rec({ kind: 'GOOD_OUTPUT', bottles: '1' }).refused).toBe(stopped);
    const g = new World();
    expect(g.rec({ kind: 'GOOD_OUTPUT', bottles: '9760' }).data).toStrictEqual({ bottles: '9760', recordedBy: 'OP1' });
    expect(g.rec({ kind: 'GOOD_OUTPUT', bottles: '1' }).refused).toBe('p@ records its good output once (TB23-OUTPUT-TWICE; IN-17)');
    expect(g.rec({ kind: 'REJECTS', reason: 'SEAL', bottles: '14' }).data).toStrictEqual({ reason: 'SEAL', bottles: '14', disposition: 'DESTRUCTION', recordedBy: 'OP1' });
    expect(g.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a bottle line step (TB23-ENTRY; IN-22)');
    expect(productOf(MBR)).toEqual({ code: 'P', name: 'Product', strength: '10 mg' });
  });

  it('[PR-37][PR-38][IN-17] PERFORMED: every stream checked and passing, the good output, no bright stock left unlabelled', () => {
    const before = (w: World) => (TB23.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(w.view()).map((p) => p.message).filter((m) => m.includes('TB23-'));
    const w = new World({ ...CFG, devices: [] });
    expect(before(w)).toEqual([
      'p@ has no count check (TB23-NO-CHECK; PR-37, IN-22)',
      'p@ has no desiccant check (TB23-NO-CHECK; PR-37, IN-22)',
      'p@ has no torque check (TB23-NO-CHECK; PR-37, IN-22)',
      'p@ has no seal check (TB23-NO-CHECK; PR-37, IN-22)',
      'Record the good bottles of p@ (TB23-NO-OUTPUT; IN-17)',
    ]);
    w.rec({ kind: 'COUNT_CHECK', counts: ['30'] });
    w.rec({ kind: 'DESICCANT_CHECK', examined: '1', missing: '0' });
    w.rec({ kind: 'TORQUE_CHECK', tester: 'T', application: ['2'], removal: ['1.5'] });
    w.rec({ kind: 'SEAL_CHECK', examined: '1', defective: '0' });
    w.rec({ kind: 'GOOD_OUTPUT', bottles: '1' });
    w.rec({ kind: 'BRIGHT_STOCK', bottles: '5' });
    expect(before(w)).toEqual(['Bright stock 1 is not labelled yet (TB23-BRIGHT-STOCK-OPEN; PR-38)']);
    w.rec({ kind: 'BRIGHT_STOCK_USE', tag: '1', scannedBatch: 'B-1', scannedProduct: 'P', bottles: '5' });
    expect(before(w)).toEqual([]);
    expect(streamsOf({ ...CFG, desiccant: undefined }).map((s) => s.stream)).toEqual(['COUNT', 'TORQUE', 'SEAL']);
    expect(streamsOf(CFG).map((s) => [s.stream, s.every])).toEqual([['COUNT', 30n * MIN], ['DESICCANT', 30n * MIN], ['TORQUE', 30n * MIN], ['SEAL', 30n * MIN]]);
  });
});

describe('TB-23 definition checks', () => {
  const lbl = (items: Json[]) => phase('lbl', { block: { type: 'G-21', version: '1' }, config: { items } as never });
  const P = (config: Json, others: flow.FlowNode[] = [lbl([{ id: 'ROLL-LABEL' }])], predicates: Json = {}): string[] => {
    const p = phase('p', { block: { type: 'TB-23', version: '1' }, config: config as never });
    const m = mbrWithChildren([...others, p]);
    const mm = { ...m, header: { ...m.header, predicates: { ...m.header.predicates, ...predicates } } } as flow.MbrContent;
    const check = TB23.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check(p, config, mm).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  it('[IN-17][INV-32][PR-37][PR-41] the label step and item, the interval, the torque ranges, and a tamper-evident check for US OTC retail', () => {
    expect(P(CFG)).toEqual([]);
    expect(P(CFG, [])).toEqual(['TB23-LABEL-STEP [IN-17,INV-32] The roll labels of p are issued and reconciled at a G-21 step: lbl is no G-21 step of the MBR']);
    expect(P({ ...CFG, labelStep: undefined })).toEqual(['TB23-LABEL-STEP [IN-17,INV-32] The roll labels of p are issued and reconciled at a G-21 step: (none) is no G-21 step of the MBR']);
    expect(P(CFG, [lbl([{ id: 'OTHER' }, 'x' as never])])).toEqual(['TB23-LABEL-STEP [IN-17,INV-32] The roll labels of p are issued and reconciled at a G-21 step: G-21 step lbl issues no printed item ROLL-LABEL']);
    expect(P({ ...CFG, labelItem: undefined }, [lbl([])])).toEqual(['TB23-LABEL-STEP [IN-17,INV-32] The roll labels of p are issued and reconciled at a G-21 step: G-21 step lbl issues no printed item (none)']);
    expect(P({ ...CFG, checkEvery: undefined })).toEqual(['TB23-INTERVAL [PR-37] The check interval of p is not a whole number of microseconds']);
    expect(P({ ...CFG, torque: { unit: 'N.m', application: { min: '2.5', max: '2.4' }, removal: { min: '1.0', max: '1.0' } } })).toEqual(['TB23-TORQUE [PR-37] The application torque limits of p are not a range']);
    expect(P({ ...CFG, torque: {} })).toEqual(['TB23-TORQUE [PR-37] The application torque limits of p are not a range', 'TB23-TORQUE [PR-37] The removal torque limits of p are not a range']);
    expect(P(CFG, undefined, { usOtcRetail: true })).toEqual(['TB23-TAMPER-EVIDENT [PR-41] A tamper-evident check is required: the MBR is for US OTC retail packs and no packaging step checks the tamper-evident feature']);
    expect(P({ ...CFG, tamperEvident: true }, undefined, { usOtcRetail: true })).toEqual([]);
    expect(P(CFG, [lbl([{ id: 'ROLL-LABEL' }]), phase('sec', { block: { type: 'TB-24', version: '1' }, config: { atd: {} } as never })], { usOtcRetail: true })).toEqual([]);
    expect(P(CFG, [lbl([{ id: 'ROLL-LABEL' }]), phase('sec', { block: { type: 'TB-24', version: '1' }, config: {} as never })], { usOtcRetail: true })[0]).toMatch(/^TB23-TAMPER-EVIDENT/);
    // Only the first TB-23 step reports the missing tamper-evident check.
    expect(P(CFG, [lbl([{ id: 'ROLL-LABEL' }]), phase('first', { block: { type: 'TB-23', version: '1' }, config: { unit: 'OTHER' } as never })], { usOtcRetail: true })).toEqual([]);
    expect(P({ ...CFG, unit: undefined })).toEqual(['TB23-UNIT [IN-22,PR-37] p names no plant unit of its line']);
    expect(P({ ...CFG, devices: [{ id: 'A', kind: 'VISION' }, { id: 'A', kind: 'VISION' }] })).toEqual(['TB23-DEVICE [IN-22] p names device A twice']);
    expect(labelStepProblem(mbrWithChildren([lbl([{ id: 'ROLL-LABEL' }])]), CFG)).toBeUndefined();
    expect(tamperEvidentProblem(mbrWithChildren([]))).toBeUndefined();
  });
});
