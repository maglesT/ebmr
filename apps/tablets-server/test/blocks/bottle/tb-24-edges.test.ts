/**
 * TB-24@1 secondary and tertiary packaging (PR-37, PR-41, PR-42, IN-17, IN-22) at its edges, through its handler on a
 * minimal view: the anti-tampering check, the in-run and end-of-run examinations (sample at least the MBR's), unusual
 * events set aside and re-entered, shippers by SSCC with its GS1 check digit and the one part shipper, the pack
 * reconciliation at its limit (either sign), counting after reconciliation, a stopped line, PERFORMED and the definition
 * checks. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { gs1CheckDigitOk, packBalance, packStreams, setAsideLeft, TB24 } from '../../../src/blocks/tb-24.ts';
import { mbrWithChildren, phase } from '../coating/support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint; recordedSeq: number };
const T = 1_800_000_000_000_000n;
const H = 3_600_000_000n;
const CFG = (TB24.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;
const MBR = { header: { product: { code: 'P', name: 'Product', strength: '10 mg' } } } as unknown as flow.MbrContent;
const S1 = '089012345000000019';
const S2 = '089012345000000026';

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return {
      phase: { id: 'p', block: { type: 'TB-24', version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      actor: { id: 'OP1' },
      mbr: MBR,
      batch: { batchNumber: 'B-1' },
    } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB24.handler?.acceptEntry?.bind(TB24.handler) as unknown as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now, recordedSeq: this.entries.length + 1 });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
}
const exam = (timing: string, examined: string, extra: Json = {}) => ({ kind: 'EXAMINATION', timing, examined, defective: '0', labelCorrect: true, ...extra });

describe('TB-24 checks and examinations', () => {
  it('[PR-41][PR-42] the anti-tampering check is configured, counts at most what was examined, fails on a defect and is missed strictly after its interval', () => {
    expect(new World({ ...CFG, atd: undefined }).rec({ kind: 'ATD_CHECK', examined: '10', defective: '0' }).refused).toBe('The MBR configures no anti-tampering check for p (TB24-NO-ATD; PR-41, PR-42)');
    const w = new World();
    expect(w.rec({ kind: 'ATD_CHECK', examined: '10', defective: '11' }).refused).toBe('More defective (11) than examined (10) (TB24-COUNTS; PR-41)');
    expect(w.rec({ kind: 'ATD_CHECK', examined: '10', defective: '0' }).data).toStrictEqual({ stream: 'ATD', examined: '10', defective: '0', result: 'PASS', missed: false, checkedBy: 'OP1' });
    w.now = T + H;
    expect(w.rec({ kind: 'ATD_CHECK', examined: '10', defective: '0' }).data?.['missed']).toBe(false);
    w.now = T + 2n * H + 1n;
    const late = w.rec({ kind: 'ATD_CHECK', examined: '10', defective: '10' });
    expect([late.data?.['missed'], late.data?.['result'], late.exceptions?.map((x) => x['type'])]).toEqual([true, 'FAIL', ['LINE_CHECK_MISSED', 'LINE_CHECK_FAILED']]);
  });

  it('[PR-37][IN-22] the packs are examined during finishing (at least the MBR\'s sample) before one end-of-run examination; a defect or a wrong label fails', () => {
    const w = new World();
    expect(w.rec(exam('END', '20')).refused).toBe('The packs are examined during finishing before the end-of-run sample (TB24-NO-IN-RUN; PR-37)');
    expect(w.rec(exam('IN_RUN', '4')).refused).toBe('A in-run examination takes at least 5 packs, not 4 (TB24-SAMPLE; PR-37)');
    expect(w.rec(exam('IN_RUN', '5', { defective: '6' })).refused).toBe('More defective (6) than examined (5) (TB24-COUNTS; PR-37)');
    expect(w.rec(exam('IN_RUN', '5', { labelCorrect: false })).exceptions?.map((x) => [x['type'], x['title']])).toEqual([
      ['LINE_CHECK_FAILED', 'A in-run examination of p@ failed: the output of the line since the last passing in-run examination is held and the steps after it wait for a deviation'],
    ]);
    expect(w.rec(exam('IN_RUN', '6', { defective: '1' })).data?.['result']).toBe('FAIL');
    expect(w.rec(exam('IN_RUN', '5')).data).toStrictEqual({ stream: 'EXAM', timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true, result: 'PASS', missed: false, checkedBy: 'OP1' });
    w.now = T + H + 1n;
    expect(w.rec(exam('IN_RUN', '5')).data?.['missed']).toBe(true);
    expect(w.rec(exam('END', '19')).refused).toBe('A end-of-run examination takes at least 20 packs, not 19 (TB24-SAMPLE; PR-37)');
    w.now = T + 9n * H;
    expect(w.rec(exam('END', '20')).data).toMatchObject({ timing: 'END', result: 'PASS', missed: false });
    expect(w.rec(exam('IN_RUN', '5')).refused).toBe('p@ had its end-of-run examination (TB24-ENDED; PR-37)');
    const noExam = new World({ ...CFG, examination: undefined });
    expect(noExam.rec(exam('IN_RUN', '0', { labelCorrect: 'yes' })).data).toMatchObject({ labelCorrect: false, result: 'FAIL' });
  });
});

describe('TB-24 packs, shippers and the reconciliation', () => {
  it('[PR-37][IN-22] an unusual event sets packs aside once (QA decides, the step waits); they re-enter after a passing special inspection, never more than set aside', () => {
    const w = new World();
    const ex = w.rec({ kind: 'SET_ASIDE', event: 'JAM-1', description: 'Carton jam', packs: '8' });
    expect(ex.data).toStrictEqual({ event: 'JAM-1', description: 'Carton jam', packs: '8', setAsideBy: 'OP1' });
    expect(ex.exceptions).toEqual([
      {
        type: 'UNUSUAL_EVENT',
        title: "8 packs of p@ are set aside after unusual event JAM-1 (Carton jam): they re-enter only after a special inspection, an investigation and QA's approval",
        controls: ['PR-37', 'IN-22'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'STEP', until: 'DISPOSITION', deviationRequired: true, qaOnly: true, item: 'JAM-1',
      },
    ]);
    expect(w.rec({ kind: 'SET_ASIDE', event: 'JAM-1', description: 'again', packs: '1' }).refused).toBe('Event JAM-1 has its set-aside already (TB24-EVENT-TWICE; PR-37, IN-22)');
    expect(w.rec({ kind: 'RE_ENTRY', event: 'SAMPLE', packs: '1', inspection: 'PASS' }).refused).toBe('SAMPLE is no set-aside event of p@: only units of an unusual event re-enter (samples never do) (TB24-EVENT; PR-37, IN-22)');
    expect(w.rec({ kind: 'RE_ENTRY', event: 'JAM-1', packs: '1', inspection: 'FAIL' }).refused).toBe('Packs of event JAM-1 re-enter only after a passing special inspection (TB24-INSPECTION; PR-37, IN-22)');
    expect(w.rec({ kind: 'RE_ENTRY', event: 'JAM-1', packs: '5', inspection: 'PASS', investigation: 'INV-1' })).toStrictEqual({ data: { event: 'JAM-1', packs: '5', inspection: 'PASS', investigation: 'INV-1', approvedBy: 'OP1' }, verificationRequired: true });
    expect(setAsideLeft(w.view(), 'JAM-1')).toBe(3n);
    expect(w.rec({ kind: 'RE_ENTRY', event: 'JAM-1', packs: '4', inspection: 'PASS' }).refused).toBe('Only 3 packs of event JAM-1 are set aside (TB24-RE-ENTRY-QUANTITY; PR-37)');
    expect(w.rec({ kind: 'RE_ENTRY', event: 'JAM-1', packs: '3', inspection: 'PASS' }).refused).toBeUndefined();
  });

  it('[PR-42][PR-37] a shipper carries an SSCC of the MBR\'s prefix with its check digit, once; a full shipper holds the MBR\'s count; one part shipper of fewer', () => {
    expect([gs1CheckDigitOk(S1), gs1CheckDigitOk(S2), gs1CheckDigitOk('089012345000000018'), gs1CheckDigitOk('4006381333931'), gs1CheckDigitOk('4006381333932'), gs1CheckDigitOk('1'), gs1CheckDigitOk('12a')]).toEqual([true, true, false, true, false, false, false]);
    const w = new World();
    expect(w.rec({ kind: 'SHIPPER', sscc: '089012345000000018', packs: '20' }).refused).toBe("089012345000000018 is no SSCC of the MBR's GS1 prefix with a valid check digit (TB24-SSCC; PR-42)");
    expect(w.rec({ kind: 'SHIPPER', sscc: '189012345000000016', packs: '20' }).refused).toMatch(/TB24-SSCC/);
    expect(w.rec({ kind: 'SHIPPER', sscc: '89012345000000019', packs: '20' }).refused).toMatch(/TB24-SSCC/);
    expect(w.rec({ kind: 'SHIPPER', sscc: S1, packs: '19' }).refused).toBe('A full shipper holds 20 packs, not 19 (TB24-SHIPPER-COUNT; PR-37)');
    expect(w.rec({ kind: 'SHIPPER', sscc: S1, packs: '20' }).data).toStrictEqual({ sscc: S1, packs: '20', part: false, label: { sscc: S1, batch: 'B-1', product: 'P', name: 'Product', strength: '10 mg', packs: '20' }, labelledBy: 'OP1' });
    expect(w.rec({ kind: 'SHIPPER', sscc: S1, packs: '20' }).refused).toBe(`SSCC ${S1} labels a shipper already (TB24-SSCC-TWICE; PR-42)`);
    expect(w.rec({ kind: 'SHIPPER', sscc: S2, packs: '20', part: true }).refused).toBe('A batch has one marked part shipper of fewer than 20 packs (TB24-PART-SHIPPER; PR-37)');
    expect(w.rec({ kind: 'SHIPPER', sscc: S2, packs: '19', part: true }).data?.['part']).toBe(true);
    expect(w.rec({ kind: 'SHIPPER', sscc: '089012345000000033', packs: '1', part: true }).refused).toMatch(/TB24-PART-SHIPPER/);
    expect(new World({ ...CFG, ssccPrefix: undefined }).rec({ kind: 'SHIPPER', sscc: '000000000000000000', packs: '20' }).data?.['sscc']).toBe('000000000000000000');
  });

  it('[PR-37][IN-17] the reconciliation: made = shipped + rejects + samples + set aside not re-entered, within the MBR\'s limit either way (D 0); after it nothing more is counted', () => {
    const run = (made: string, cfg: Json = CFG) => {
      const w = new World(cfg);
      w.rec({ kind: 'PACKS_MADE', packs: made });
      w.rec({ kind: 'SET_ASIDE', event: 'JAM', description: 'jam', packs: '8' });
      w.rec({ kind: 'RE_ENTRY', event: 'JAM', packs: '3', inspection: 'PASS' });
      w.rec({ kind: 'PACK_SAMPLE', purpose: 'QC', packs: '4' });
      w.rec({ kind: 'REJECTS', reason: 'ATD', packs: '2' });
      w.rec({ kind: 'SHIPPER', sscc: S1, packs: '20' });
      return w;
    };
    const ok = run('31');
    expect(packBalance(ok.view())).toEqual({ made: '31', shipped: '20', rejects: '2', samples: '4', setAside: '8', reEntered: '3', unexplained: '0', withinLimits: true });
    const r = ok.rec({ kind: 'RECONCILIATION' });
    expect(r.data).toMatchObject({ unexplained: '0', withinLimits: true, reconciledBy: 'OP1' });
    expect(r.exceptions).toBeUndefined();
    expect(ok.rec({ kind: 'RECONCILIATION' }).refused).toBe('p@ is reconciled already (TB24-RECONCILED; PR-37, IN-17)');
    for (const kind of ['PACKS_MADE', 'REJECTS', 'PACK_SAMPLE', 'SET_ASIDE', 'RE_ENTRY', 'SHIPPER']) expect(ok.rec({ kind, packs: '1' }).refused, kind).toBe('p@ is reconciled: nothing more is counted (TB24-RECONCILED; PR-37, IN-17)');
    const over = run('32').rec({ kind: 'RECONCILIATION' });
    expect(over.exceptions?.map((x) => [x['type'], x['title'], x['releaseBlocking']])).toEqual([
      ['PACK_RECONCILIATION', 'The pack reconciliation of p@ leaves 1 packs unexplained of 32 made, outside its limit: an investigation is needed and release is blocked', true],
    ]);
    expect(run('30').rec({ kind: 'RECONCILIATION' }).data).toMatchObject({ unexplained: '-1', withinLimits: false });
    expect(run('32', { ...CFG, maxUnexplained: '1' }).rec({ kind: 'RECONCILIATION' }).data).toMatchObject({ unexplained: '1', withinLimits: true });
    expect(run('30', { ...CFG, maxUnexplained: '1' }).rec({ kind: 'RECONCILIATION' }).data).toMatchObject({ unexplained: '-1', withinLimits: true });
    expect(run('29', { ...CFG, maxUnexplained: '1' }).rec({ kind: 'RECONCILIATION' }).data).toMatchObject({ withinLimits: false });
  });

  it('[IN-22][PR-37] a stopped line counts no packs and labels no shipper; samples and rejects still count', () => {
    const w = new World();
    w.entries.push({ id: 'C', kind: 'CHALLENGE', data: { device: 'CW', result: 'FAIL' }, recordedAt: T, recordedSeq: 0 });
    expect(w.rec({ kind: 'PACKS_MADE', packs: '1' }).refused).toBe('The line of p@ is stopped: CW failed its last challenge (TB24-STOPPED; IN-22, PR-37)');
    expect(w.rec({ kind: 'SHIPPER', sscc: S1, packs: '20' }).refused).toMatch(/TB24-STOPPED/);
    expect(w.rec({ kind: 'REJECTS', reason: 'OTHER', packs: '1' }).data).toStrictEqual({ reason: 'OTHER', packs: '1', disposition: 'DESTRUCTION', recordedBy: 'OP1' });
    expect(w.rec({ kind: 'PACK_SAMPLE', purpose: 'QC', packs: '1' }).data).toStrictEqual({ purpose: 'QC', packs: '1', takenBy: 'OP1' });
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a secondary packaging step (TB24-ENTRY; PR-37)');
  });

  it('[PR-37][PR-41][IN-17] PERFORMED: the ATD stream, an in-run and a passing end-of-run examination, and the reconciliation', () => {
    const before = (w: World) => (TB24.handler?.beforePerform?.bind(TB24.handler) as unknown as (v: blocks.HandlerView) => { message: string }[])(w.view()).map((p) => p.message).filter((m) => m.includes('TB24-'));
    const w = new World({ ...CFG, devices: [] });
    expect(before(w)).toEqual([
      'p@ has no anti-tampering check (TB24-NO-CHECK; PR-41, PR-37)',
      'p@ has no examination of the packs during finishing (TB24-NO-IN-RUN; PR-37)',
      'p@ has no end-of-run examination of a representative sample (TB24-NO-END-EXAM; PR-37)',
      'Reconcile the packs of p@: the reconciliation always runs (TB24-NOT-RECONCILED; PR-37, IN-17)',
    ]);
    w.rec({ kind: 'ATD_CHECK', examined: '1', defective: '0' });
    w.rec(exam('IN_RUN', '5'));
    w.rec(exam('END', '20', { defective: '1' }));
    w.rec({ kind: 'RECONCILIATION' });
    expect(before(w)).toEqual(['The end-of-run examination of p@ failed (TB24-END-EXAM-FAILED; PR-37)']);
    expect(packStreams({ atd: { every: { value: '1', unit: 'h' } } })).toEqual([{ stream: 'ATD', every: H, what: 'anti-tampering check' }]);
    expect(packStreams({})).toEqual([]);
  });
});

describe('TB-24 definition checks', () => {
  const prt = phase('prt', { block: { type: 'G-21', version: '1' }, config: {} });
  const P = (config: Json, opts: { markets?: string[]; otc?: boolean; others?: flow.FlowNode[] } = {}): string[] => {
    const p = phase('p', { block: { type: 'TB-24', version: '1' }, config: config as never });
    const m = mbrWithChildren([...(opts.others ?? [prt]), p]);
    const mm = { ...m, header: { ...m.header, marketSet: opts.markets ?? ['IN'], predicates: { ...m.header.predicates, ...(opts.otc ? { usOtcRetail: true } : {}) } } } as flow.MbrContent;
    const check = TB24.checkConfig?.bind(TB24) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check(p, config, mm).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  it('[IN-17][PR-41][PR-42][PR-37] the printed-material step, the ATD for the EU and for US OTC retail, whole-microsecond intervals', () => {
    expect(P(CFG)).toEqual([]);
    expect(P(CFG, { others: [] })).toEqual(['TB24-PRINTED-STEP [IN-17,PR-42] The cartons and leaflets of p are issued, coded and reconciled at a G-21 step: prt is none']);
    expect(P({ ...CFG, printedStep: undefined })).toEqual(['TB24-PRINTED-STEP [IN-17,PR-42] The cartons and leaflets of p are issued, coded and reconciled at a G-21 step: (none) is none']);
    const noAtd = { ...CFG, atd: undefined };
    expect(P(noAtd)).toEqual([]);
    expect(P(noAtd, { markets: ['IN', 'EU'] })).toEqual(['TB24-ATD-REQUIRED [PR-42,PR-41] p packs for the EU and checks no anti-tampering device']);
    expect(P(CFG, { markets: ['IN', 'EU'] })).toEqual([]);
    expect(P(noAtd, { otc: true })).toEqual(['TB24-ATD-REQUIRED [PR-41] p packs for US OTC retail and no packaging step checks the tamper-evident feature']);
    expect(P(noAtd, { otc: true, others: [prt, phase('btl', { block: { type: 'TB-23', version: '1' }, config: { tamperEvident: true } })] })).toEqual([]);
    expect(P(noAtd, { otc: true, others: [prt, phase('btl', { block: { type: 'TB-23', version: '1' }, config: { tamperEvident: false } })] })).toHaveLength(1);
    expect(P(CFG, { otc: true })).toEqual([]);
    expect(P({ ...CFG, atd: {} })).toEqual(['TB24-INTERVAL [PR-41] The anti-tampering check interval of p is not a whole number of microseconds']);
    expect(P({ ...CFG, examination: {} })).toEqual(['TB24-INTERVAL [PR-37] The in-run examination interval of p is not a whole number of microseconds']);
    expect(P({ ...CFG, unit: undefined })).toEqual(['TB24-UNIT [IN-22,PR-37] p names no plant unit of its line']);
  });
});
