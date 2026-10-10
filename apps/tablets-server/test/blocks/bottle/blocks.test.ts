/**
 * Phase 3 slice 4b (builder B): the packaging-line blocks TB-23 (bottle line) and TB-24 (secondary and tertiary packaging,
 * finished-pack examination) through the engine with the tablets registry and catalogue: the block contract, each golden
 * fixture, and each block's rules (definition checks, entry refusals, exceptions, the schedule at the entries' times, the
 * close). The database's copy of the rules, the container holds and the bypass attempts are proven in db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks, engine } from '@ebmr/recipe-core/pure';
import { BOTTLE_BLOCK_VERSIONS, TB23, TB24 } from '../../../src/blocks/bottle/index.ts';
import { gs1CheckDigitOk, ssccOf } from '../../../src/blocks/tb-24.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, definitionCodes, fixturePhase, MIN, OP1, OP2, phase, runGolden, sig, startRun, VER1 } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
type R = ReturnType<typeof startRun>;
const perform = (run: R) => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
const refusal = (run: R, entry: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry }).code;
const last = (run: R, kind: string): Json => {
  const es = Object.values(run.state.entries).filter((e) => e.kind === kind && e.stepKey === 'p@');
  return (es.sort((a, b) => a.recordedSeq - b.recordedSeq).at(-1)?.data ?? {});
};
const types = (run: R) => run.exceptions().map((e) => e.type).sort();
const performCodes = (run: R): string => {
  const r = perform(run);
  return r.accepted ? 'ok' : `${r.refusal?.code ?? '?'} ${r.refusal?.message ?? ''}`;
};

describe('the packaging-line block versions (contract)', () => {
  it('[DI-10][DI-34] TB-23@1 and TB-24@1 are registered in the tablets registry with every execution part of the block contract and are significant steps of the edition catalogue; their CHALLENGE entry is G-21@1\'s own', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-23@1', 'TB-24@1']));
    for (const r of reg.report().filter((x) => BOTTLE_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of BOTTLE_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.phase.allowed], b.type).toEqual(['tablets', true, true]);
      expect(b.dataSchema?.entries['CHALLENGE']).toBe(blocks.G21.dataSchema?.entries['CHALLENGE']);
    }
  });
});

describe('golden fixtures of the packaging-line blocks', () => {
  for (const b of BOTTLE_BLOCK_VERSIONS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runGolden(b);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      expect(out.run.exceptions().map((e) => e.type).sort()).toEqual(f.expect.exceptions);
      expect(out.run.status('p')).toBe(f.expect.status);
    });
  }

  it('[DI-34] the simulator model of each block plays a nominal path the engine accepts, and the step is then performed', () => {
    for (const b of BOTTLE_BLOCK_VERSIONS) {
      const run = startRun(b);
      const node = run.def.steps.get('p')?.node as never;
      const entries = b.simulatorModel?.nominalEntries({ phase: node, config: fixturePhase(b).config, mbr: blockMbr(b), frames: [], containers: [], target: () => undefined }) ?? [];
      for (const e of entries) {
        const r = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: e });
        expect(r.accepted, `${b.type} ${e.kind}: ${r.refusal?.code ?? ''} ${r.refusal?.message ?? ''}`).toBe(true);
      }
      expect(performCodes(run), b.type).toBe('ok');
    }
  });
});

const tb23 = (config: Json = {}, header: Json = {}) => startRun(TB23, blockMbr(TB23, fixturePhase(TB23, { config: config as never }), [], header));
const tb24 = (config: Json = {}, header: Json = {}) => startRun(TB24, blockMbr(TB24, fixturePhase(TB24, { config: config as never }), [], header));
const ok = (run: R, entry: Entry) => run.entry('p', entry);
const challenge = (device: string, trigger: string, result = 'PASS'): Entry => ({ kind: 'CHALLENGE', device, trigger, result });
const passingTb23 = (run: R): void => {
  ok(run, challenge('SEALDET', 'START'));
  ok(run, { kind: 'COUNT_CHECK', counts: ['30', '30'] });
  ok(run, { kind: 'DESICCANT_CHECK', examined: '10', missing: '0' });
  ok(run, { kind: 'TORQUE_CHECK', tester: 'TQ-01', application: ['2.0'], removal: ['1.5'] });
  ok(run, { kind: 'SEAL_CHECK', examined: '10', defective: '0' });
};

describe('TB-23 bottle line (definition)', () => {
  it('[IN-17][INV-32][IN-22][PR-41] the MBR names the G-21 step that issues and reconciles the roll labels with that item; the line unit is no other packaging step\'s; torque limits are ranges; a US OTC retail MBR checks the tamper-evident seal', () => {
    expect(definitionCodes(blockMbr(TB23))).toEqual([]);
    expect(definitionCodes(blockMbr(TB23, fixturePhase(TB23, { config: { labelStep: 'nope' } })))).toContain('TB23-LABEL-STEP');
    expect(definitionCodes(blockMbr(TB23, fixturePhase(TB23, { config: { labelItem: 'CARTON' } })))).toContain('TB23-LABEL-STEP');
    const shared = phase('lbl2', { block: { type: 'G-21', version: '1' }, config: { unit: 'BTL-LINE-1' } });
    expect(definitionCodes(blockMbr(TB23, fixturePhase(TB23), [shared]))).toContain('TB23-UNIT');
    expect(definitionCodes(blockMbr(TB23, fixturePhase(TB23, { config: { torque: { unit: 'N.m', application: { min: '2.4', max: '1.8' }, removal: { min: '1.0', max: '2.2' } } } })))).toContain('TB23-TORQUE');
    expect(definitionCodes(blockMbr(TB23, fixturePhase(TB23), [], { predicates: { usOtcRetail: true }, marketSet: ['IN', 'US'] }))).toContain('TB23-TAMPER-EVIDENT');
    expect(definitionCodes(blockMbr(TB23, fixturePhase(TB23, { config: { tamperEvident: true } }), [], { predicates: { usOtcRetail: true }, marketSet: ['IN', 'US'] }))).toEqual([]);
  });
});

describe('TB-23 bottle line (checks, challenges, bright stock)', () => {
  it('[PR-37][IN-22] the count, desiccant, torque and seal checks are judged by the block on the MBR\'s limits; a failing one raises LINE_CHECK_FAILED and one later than the interval after its stream\'s previous check LINE_CHECK_MISSED', () => {
    const run = tb23();
    ok(run, { kind: 'COUNT_CHECK', counts: ['30', '31'] });
    expect(last(run, 'COUNT_CHECK')).toMatchObject({ stream: 'COUNT', expected: '30', result: 'FAIL', missed: false });
    expect(types(run)).toEqual(['LINE_CHECK_FAILED']);
    run.advance(31n * MIN);
    ok(run, { kind: 'COUNT_CHECK', counts: ['30'] });
    expect(last(run, 'COUNT_CHECK')).toMatchObject({ result: 'PASS', missed: true });
    expect(types(run)).toEqual(['LINE_CHECK_FAILED', 'LINE_CHECK_MISSED']);
    ok(run, { kind: 'TORQUE_CHECK', tester: 'TQ-01', application: ['2.0', '2.5'], removal: ['1.5'] });
    expect(last(run, 'TORQUE_CHECK')).toMatchObject({ result: 'FAIL', unit: 'N.m' });
    ok(run, { kind: 'TORQUE_CHECK', tester: 'TQ-01', application: ['2.4'], removal: ['1.0', '2.2'] });
    expect(last(run, 'TORQUE_CHECK')).toMatchObject({ result: 'PASS' });
    ok(run, { kind: 'DESICCANT_CHECK', examined: '10', missing: '1' });
    expect(last(run, 'DESICCANT_CHECK')).toMatchObject({ result: 'FAIL', desiccant: 'SILICA-1G' });
    expect(refusal(run, { kind: 'DESICCANT_CHECK', examined: '1', missing: '2' })).toBe('TB23-COUNTS');
    expect(refusal(tb23({ desiccant: undefined }), { kind: 'DESICCANT_CHECK', examined: '1', missing: '0' })).toBe('TB23-NO-DESICCANT');
    // PR-41: a tamper-evident pack's seal check also checks the labelling statement.
    const te = tb23({ tamperEvident: true });
    expect(refusal(te, { kind: 'SEAL_CHECK', examined: '10', defective: '0' })).toBe('TB23-TAMPER-EVIDENT');
    ok(te, { kind: 'SEAL_CHECK', examined: '10', defective: '0', statementChecked: false });
    expect(last(te, 'SEAL_CHECK')).toMatchObject({ result: 'FAIL', statementChecked: false });
    expect(refusal(run, { kind: 'SEAL_CHECK', examined: '10', defective: '0', statementChecked: true })).toBe('TB23-TAMPER-EVIDENT');
  });

  it('[IN-22][PR-37] an inspection device is challenged by G-21\'s own rule (two persons): a failed challenge raises CHALLENGE_FAILED that stops the step until QA decides, and no output is counted while its last challenge failed', () => {
    const run = tb23();
    expect(refusal(run, challenge('NOPE', 'START'))).toBe('G21-DEVICE');
    expect(refusal(run, { ...challenge('SEALDET', 'START'), event: '00000000-0000-4000-8000-000000000001', at: '1' })).toBe('G21-EVENT');
    ok(run, challenge('SEALDET', 'START'));
    expect(run.state.steps['p@']?.verificationRequired).toBe(true);
    expect(last(run, 'CHALLENGE')).toMatchObject({ device: 'SEALDET', trigger: 'START', result: 'PASS', missed: false, challengedBy: OP1.id });
    ok(run, challenge('SEALDET', 'INTERVAL', 'FAIL'));
    expect(types(run)).toEqual(['CHALLENGE_FAILED']);
    expect(refusal(run, { kind: 'GOOD_OUTPUT', bottles: '10' })).toBe('TB23-STOPPED');
    expect(refusal(run, { kind: 'BRIGHT_STOCK', bottles: '10' })).toBe('TB23-STOPPED');
    ok(run, challenge('SEALDET', 'INTERVAL'));
    ok(run, { kind: 'GOOD_OUTPUT', bottles: '10' });
    expect(refusal(run, { kind: 'GOOD_OUTPUT', bottles: '10' })).toBe('TB23-OUTPUT-TWICE');
    // A late challenge: CHALLENGE_MISSED (the interval is 2 h).
    run.advance(121n * MIN);
    ok(run, challenge('SEALDET', 'INTERVAL'));
    expect(types(run)).toEqual(['CHALLENGE_FAILED', 'CHALLENGE_MISSED']);
  });

  it('[PR-38] bright stock: set aside only where the MBR allows it, identified by the record (product, strength, batch, bottles); labelled back only by the scan of this batch and product and never more than is left; the step is not performed with bright stock left', () => {
    expect(refusal(tb23({ brightStock: false }), { kind: 'BRIGHT_STOCK', bottles: '10' })).toBe('TB23-NO-BRIGHT-STOCK');
    const run = tb23();
    passingTb23(run);
    ok(run, { kind: 'BRIGHT_STOCK', bottles: '100' });
    expect(last(run, 'BRIGHT_STOCK')).toEqual({ tag: '1', bottles: '100', product: { code: 'P', name: 'Product', strength: '1 mg' }, batch: run.state.header.batchNumber, countPerBottle: '30', setAsideBy: OP1.id });
    const use = (over: Json): Entry => ({ kind: 'BRIGHT_STOCK_USE', tag: '1', scannedBatch: run.state.header.batchNumber, scannedProduct: 'P', bottles: '60', ...over });
    expect(refusal(run, use({ scannedBatch: 'B9999' }))).toBe('TB23-BRIGHT-STOCK-SCAN');
    expect(refusal(run, use({ scannedProduct: 'Q' }))).toBe('TB23-BRIGHT-STOCK-SCAN');
    expect(refusal(run, use({ tag: '2' }))).toBe('TB23-BRIGHT-STOCK-TAG');
    ok(run, use({}));
    expect(refusal(run, use({}))).toBe('TB23-BRIGHT-STOCK-QUANTITY');
    ok(run, { kind: 'GOOD_OUTPUT', bottles: '1000' });
    ok(run, challenge('SEALDET', 'END'));
    expect(performCodes(run)).toMatch(/TB23-BRIGHT-STOCK-OPEN/);
    ok(run, use({ bottles: '40' }));
    expect(performCodes(run)).toBe('ok');
  });

  it('[PR-37][IN-22][IN-17] the step is performed only with each stream checked, its last check passing and none due, the devices\' START and END challenges passing and the good output recorded', () => {
    const run = tb23();
    expect(performCodes(run)).toMatch(/TB23-NO-CHECK/);
    passingTb23(run);
    ok(run, { kind: 'SEAL_CHECK', examined: '10', defective: '2' });
    expect(performCodes(run)).toMatch(/TB23-LAST-CHECK.*G21-CHALLENGE-DUE.*TB23-NO-OUTPUT|TB23-LAST-CHECK/s);
    ok(run, { kind: 'SEAL_CHECK', examined: '10', defective: '0' });
    ok(run, { kind: 'GOOD_OUTPUT', bottles: '1000' });
    expect(performCodes(run)).toMatch(/G21-CHALLENGE-DUE/);
    ok(run, challenge('SEALDET', 'END'));
    run.advance(31n * MIN);
    expect(performCodes(run)).toMatch(/TB23-CHECK-DUE/);
  });
});

describe('TB-24 secondary packaging (definition)', () => {
  it('[IN-17][PR-42][PR-41] the MBR names the G-21 step of the cartons; an EU pack and a US OTC retail pack check the anti-tampering or tamper-evident feature', () => {
    expect(definitionCodes(blockMbr(TB24))).toEqual([]);
    expect(definitionCodes(blockMbr(TB24, fixturePhase(TB24, { config: { printedStep: 'after' } })))).toContain('TB24-PRINTED-STEP');
    expect(definitionCodes(blockMbr(TB24, fixturePhase(TB24, { config: { atd: undefined } as never }), [], { marketSet: ['IN', 'EU'] }))).toContain('TB24-ATD-REQUIRED');
    expect(definitionCodes(blockMbr(TB24, fixturePhase(TB24, { config: { atd: undefined } as never }), [], { marketSet: ['IN', 'US'], predicates: { usOtcRetail: true } }))).toContain('TB24-ATD-REQUIRED');
    expect(definitionCodes(blockMbr(TB24, fixturePhase(TB24), [], { marketSet: ['IN', 'EU'] }))).toEqual([]);
  });
});

describe('TB-24 secondary packaging (examination, samples, unusual events, shippers, reconciliation)', () => {
  it('[PR-37] finished packs are examined during finishing and a representative sample at completion, each of the MBR\'s size at least; a failing examination raises LINE_CHECK_FAILED, a late in-run one LINE_CHECK_MISSED; nothing is examined after the end-of-run sample', () => {
    const run = tb24();
    const ex = (timing: string, examined: string, defective = '0', labelCorrect = true): Entry => ({ kind: 'EXAMINATION', timing, examined, defective, labelCorrect });
    expect(refusal(run, ex('END', '20'))).toBe('TB24-NO-IN-RUN');
    expect(refusal(run, ex('IN_RUN', '4'))).toBe('TB24-SAMPLE');
    ok(run, ex('IN_RUN', '5', '0', false));
    expect(last(run, 'EXAMINATION')).toMatchObject({ stream: 'EXAM', timing: 'IN_RUN', result: 'FAIL', labelCorrect: false });
    run.advance(61n * MIN);
    ok(run, ex('IN_RUN', '5'));
    expect(types(run)).toEqual(['LINE_CHECK_FAILED', 'LINE_CHECK_MISSED']);
    expect(refusal(run, ex('END', '19'))).toBe('TB24-SAMPLE');
    ok(run, ex('END', '20'));
    expect(refusal(run, ex('IN_RUN', '5'))).toBe('TB24-ENDED');
    expect(refusal(run, ex('END', '20'))).toBe('TB24-ENDED');
  });

  it('[PR-37][IN-22] samples never return to good output; units of an unusual event are set aside under its event with UNUSUAL_EVENT (QA decides before the step completes) and re-enter only after a passing special inspection, with the investigation, checked by a second person, never more than were set aside', () => {
    const run = tb24();
    ok(run, { kind: 'PACKS_MADE', packs: '100' });
    ok(run, { kind: 'PACK_SAMPLE', purpose: 'QC', packs: '3' });
    ok(run, { kind: 'SET_ASIDE', event: 'DROP-1', description: 'Tray dropped', packs: '6' });
    const ue = run.exceptions('UNUSUAL_EVENT')[0];
    expect([ue?.source.item, ue?.qaOnly, ue?.deviationRequired, ue?.block?.until]).toEqual(['DROP-1', true, true, 'DISPOSITION']);
    expect(refusal(run, { kind: 'SET_ASIDE', event: 'DROP-1', description: 'again', packs: '1' })).toBe('TB24-EVENT-TWICE');
    const re = (over: Json): Entry => ({ kind: 'RE_ENTRY', event: 'DROP-1', packs: '4', inspection: 'PASS', investigation: 'DV-0001', ...over });
    expect(refusal(run, re({ event: 'QC' }))).toBe('TB24-EVENT');
    expect(refusal(run, re({ inspection: 'FAIL' }))).toBe('TB24-INSPECTION');
    expect(refusal(run, re({ packs: '7' }))).toBe('TB24-RE-ENTRY-QUANTITY');
    ok(run, re({}));
    expect(last(run, 'RE_ENTRY')).toEqual({ event: 'DROP-1', packs: '4', inspection: 'PASS', investigation: 'DV-0001', approvedBy: OP1.id });
    expect(run.state.steps['p@']?.verificationRequired).toBe(true);
    expect(refusal(run, re({ packs: '3' }))).toBe('TB24-RE-ENTRY-QUANTITY');
  });

  it('[PR-42][PR-37] a shipper is labelled from the record under an SSCC of the MBR\'s GS1 prefix with a valid check digit, once; a full shipper holds the MBR\'s count; one marked part shipper per batch; no output while a device\'s last challenge failed', () => {
    expect(gs1CheckDigitOk('106141411234567897')).toBe(true);
    expect(gs1CheckDigitOk('106141411234567898')).toBe(false);
    expect(gs1CheckDigitOk('08901234567890')).toBe(true); // the GTIN-14 of the 4a fixtures (G-21 checks it)
    const run = tb24();
    const sh = (n: bigint, packs: string, part = false, prefix = '089012345'): Entry => ({ kind: 'SHIPPER', sscc: ssccOf(prefix, n), packs, part });
    expect(refusal(run, { ...sh(1n, '20'), sscc: '089012345000000018' })).toBe('TB24-SSCC');
    expect(refusal(run, sh(1n, '20', false, '089099999'))).toBe('TB24-SSCC');
    expect(refusal(run, sh(1n, '19'))).toBe('TB24-SHIPPER-COUNT');
    ok(run, sh(1n, '20'));
    expect(last(run, 'SHIPPER')).toEqual({ sscc: ssccOf('089012345', 1n), packs: '20', part: false, label: { sscc: ssccOf('089012345', 1n), batch: run.state.header.batchNumber, product: 'P', name: 'Product', strength: '1 mg', packs: '20' }, labelledBy: OP1.id });
    expect(refusal(run, sh(1n, '20'))).toBe('TB24-SSCC-TWICE');
    expect(refusal(run, sh(2n, '20', true))).toBe('TB24-PART-SHIPPER');
    ok(run, sh(2n, '7', true));
    expect(refusal(run, sh(3n, '5', true))).toBe('TB24-PART-SHIPPER');
    ok(run, challenge('CW', 'START', 'FAIL'));
    expect(refusal(run, sh(3n, '20'))).toBe('TB24-STOPPED');
    expect(refusal(run, { kind: 'PACKS_MADE', packs: '1' })).toBe('TB24-STOPPED');
  });

  it('[PR-37][IN-17] the reconciliation is computed from the step\'s counts, set-aside units not re-entered counted apart; outside its limit PACK_RECONCILIATION blocks release; nothing is counted after it; the step is performed only with both examinations and the reconciliation', () => {
    const run = tb24();
    ok(run, challenge('CW', 'START'));
    ok(run, { kind: 'ATD_CHECK', examined: '10', defective: '0' });
    ok(run, { kind: 'EXAMINATION', timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true });
    ok(run, { kind: 'PACKS_MADE', packs: '45' });
    ok(run, { kind: 'REJECTS', reason: 'CHECKWEIGHER', packs: '2' });
    ok(run, { kind: 'PACK_SAMPLE', purpose: 'RETENTION', packs: '2' });
    ok(run, { kind: 'SHIPPER', sscc: ssccOf('089012345', 1n), packs: '20', part: false });
    ok(run, { kind: 'SHIPPER', sscc: ssccOf('089012345', 2n), packs: '20', part: false });
    expect(performCodes(run)).toMatch(/TB24-NO-END-EXAM/);
    ok(run, { kind: 'EXAMINATION', timing: 'END', examined: '20', defective: '0', labelCorrect: true });
    ok(run, challenge('CW', 'END'));
    expect(performCodes(run)).toMatch(/TB24-NOT-RECONCILED/);
    ok(run, { kind: 'RECONCILIATION' });
    expect(last(run, 'RECONCILIATION')).toEqual({ made: '45', shipped: '40', rejects: '2', samples: '2', setAside: '0', reEntered: '0', unexplained: '1', withinLimits: false, reconciledBy: OP1.id });
    const pr = run.exceptions('PACK_RECONCILIATION')[0];
    expect([pr?.releaseBlocking, pr?.deviationRequired]).toEqual([true, true]);
    expect(refusal(run, { kind: 'PACKS_MADE', packs: '1' })).toBe('TB24-RECONCILED');
    expect(refusal(run, { kind: 'RECONCILIATION' })).toBe('TB24-RECONCILED');
    expect(performCodes(run)).toBe('ok');
    const within = tb24({ maxUnexplained: '1' });
    ok(within, { kind: 'PACKS_MADE', packs: '1' });
    ok(within, { kind: 'RECONCILIATION' });
    expect(types(within)).toEqual([]);
    void OP2;
    void VER1;
  });
});
