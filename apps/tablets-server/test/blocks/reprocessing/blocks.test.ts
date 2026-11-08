/**
 * TB-08@1 through the engine (Phase 3 slice 5b): the block contract (handler, configuration and data schemas, exception
 * rules, simulator model, golden fixture) and the addition rules recipe-core's reprocessing.ts gives it, on the facts the
 * server reads from the database (here given as the server would give them).
 */
import { describe, expect, it } from 'vitest';
import { blocks, engine, type flow } from '@ebmr/recipe-core/pure';
import { TB08 } from '../../../src/blocks/reprocessing/index.ts';
import { massText, perUseRequired } from '../../../src/blocks/tb-08.ts';
import { tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, definitionCodes, fixturePhase, OP1, runGolden, sig, startRun, T0, VER1 } from '../coating/support.ts';

type Json = Record<string, unknown>;

const DAY = 86_400_000_000n;
const source = (extra: Json = {}): Json => ({
  container: '00000000-0000-4000-8000-0000000000a8',
  sourceBatchId: '00000000-0000-4000-8000-0000000000b8',
  product: 'P',
  strength: '1 mg',
  stage: 'INSPECTION',
  unit: 'kg',
  case: 'REPROCESSING_ADDITION',
  generatedAtUs: String(T0 - 10n * DAY),
  manufacturedAtUs: String(T0 - 20n * DAY),
  containsRecovered: false,
  remaining: '0.4',
  ...extra,
});
const AUTH = '00000000-0000-4000-8000-0000000000c8';
const QA = '00000000-0000-4000-8000-0000000000d8';
const add = (extra: Json = {}, src: Json = {}): Json & { kind: string } => ({
  kind: 'ADDITION', container: '00000000-0000-4000-8000-0000000000a8', gross: '0.525', tare: '0.500', unit: 'kg', authorisation: AUTH, authorisedBy: QA, source: source(src), ...extra,
});

function phase(extra: Partial<flow.PhaseNode> = {}): flow.PhaseNode {
  return fixturePhase(TB08, extra);
}
function refusalOf(p: flow.PhaseNode, entry: Json & { kind: string }, actor = OP1): string | undefined {
  const run = startRun(blockMbr(TB08, p));
  const r = run.exec({ type: 'RECORD_ENTRY', actor, step: 'p', context: [], entry });
  return r.accepted ? undefined : r.refusal?.code;
}

describe('TB-08@1 rework or recovered-material addition', () => {
  it('[DI-10][DI-34][DI-33] is registered in the Tablets edition with every execution part of the contract; its golden fixture runs: the net added is computed into the item the yield reads (C-07) and QC is flagged to decide on extra testing', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.get('TB-08', '1')).toBe(TB08);
    const report = reg.report().find((r) => r.type === 'TB-08');
    // Only the rendering parts (UI work) are missing, as for every other Tablets block version.
    expect(report?.missing).toEqual(reg.report().find((r) => r.type === 'TB-20')?.missing);
    const { run, performRefusal } = runGolden(TB08);
    expect(performRefusal).toBeUndefined();
    expect(run.status('p')).toBe('COMPLETED');
    expect(Object.values(run.state.exceptions).map((x) => x.type)).toEqual(['QC_ADDITIONAL_TESTING_DECISION']);
    expect(Object.values(run.state.points).find((p) => p.item === 'reworkAdded' && p.status === 'VALID')?.value).toEqual({ kind: 'DECIMAL', value: '0.025', unit: 'kg' });
    expect(TB08.simulatorModel?.exceptionTypes({} as never)).toEqual(['QC_ADDITIONAL_TESTING_DECISION']);
    expect(TB08.exceptionRules?.map((r) => r.type)).toEqual(['QC_ADDITIONAL_TESTING_DECISION']);
  });

  it('[PR-08][INV-25] a total the block computes at PERFORMED outside a blocking tier leaves the signature offered, so the attempt records the exception before it is refused, and the step can then be signed (owner report item 1)', () => {
    const base = blockMbr(TB08, phase());
    const limits = { unit: 'kg', ranges: [{ tier: 'VALIDATED', low: { value: '0.001', inclusive: true }, high: { value: '0.010', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] };
    const mbr = { ...base, parameters: base.parameters.map((x) => (x.id === 'reworkAdded' ? { ...x, limits } : x)) } as flow.MbrContent;
    const run = startRun(mbr);
    run.entry('p', add());
    const offered = () => engine.availableActions(run.def, run.state, OP1, { nowUs: run.nowUs }, { stepKey: 'p@' }).find((a) => a.action === 'SIGN_PERFORMED');
    // Nothing is stored yet: before, the action was greyed with the reason of an exception that did not exist.
    expect(run.exceptions('LIMIT_BREACH')).toEqual([]);
    expect(offered()?.available).toBe(true);
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) }).code).toBe('ENG-BLOCKED');
    const [ex] = run.exceptions('LIMIT_BREACH');
    expect(ex).toMatchObject({ tier: 'VALIDATED', registrationRelevant: true, status: 'OPEN' });
    // Stored now: the action is refused with its reason until the deviation is linked.
    expect(offered()).toMatchObject({ available: false, refusal: { code: 'ENG-BLOCKED' } });
    run.ok({ type: 'ATTACH_DEVIATION', actor: OP1, exception: ex?.id ?? '', deviationRef: 'TEST-DEV-0001' });
    expect(offered()?.available).toBe(true);
    expect(run.perform('p').accepted).toBe(true);
  });

  it('[PR-47][IN-19] an addition without prior authorisation, by its authoriser, of another product, over the MBR percentage, age or source-batch count, from a source holding recovered material, from material of another status, or from ad-hoc material is refused', () => {
    const p = phase();
    expect(refusalOf(p, add())).toBeUndefined();
    expect(refusalOf(p, add({ authorisation: undefined, authorisedBy: undefined }))).toBe('TB08-NOT-AUTHORISED');
    expect(refusalOf(p, add(), { ...OP1, id: QA })).toBe('TB08-SELF-AUTHORISED');
    expect(refusalOf(p, add({}, { product: 'Q' }))).toBe('TB08-OTHER-PRODUCT');
    expect(refusalOf(p, add({}, { strength: '2 mg' }))).toBe('TB08-OTHER-PRODUCT');
    // 3 % of the fixture's standard batch of 1 kg is 0.03 kg.
    expect(refusalOf(p, add({ gross: '0.531', tare: '0.500' }))).toBe('TB08-TOO-MUCH');
    expect(refusalOf(p, add({}, { generatedAtUs: String(T0 - 91n * DAY) }))).toBe('TB08-TOO-OLD');
    expect(refusalOf(p, add({}, { containsRecovered: true }))).toBe('TB08-CHAINED');
    expect(refusalOf(p, add({}, { case: 'RECOVERY' }))).toBe('TB08-SOURCE-STATUS');
    expect(refusalOf(p, add({ source: undefined }))).toBe('ENG-ENTRY-SCHEMA');
    expect(refusalOf(p, add({}, { remaining: '0.02' }))).toBe('TB08-OVER-REMAINING');
    expect(refusalOf(p, add({}, { stage: 'BLENDING' }))).toBe('TB08-SOURCE-TYPE');
    expect(refusalOf(p, add({ unit: 'g', gross: '25', tare: '0' }))).toBe('TB08-UNIT');
    expect(refusalOf(p, add({ gross: '0.500', tare: '0.500' }))).toBe('TB08-NET');
    // The age from the source batch's manufacture where the step says so.
    expect(refusalOf(phase({ config: { ...TB08.goldenFixture?.phase.config, ageFrom: 'MANUFACTURE' } }), add({}, { manufacturedAtUs: String(T0 - 100n * DAY) }))).toBe('TB08-TOO-OLD');
  });

  it('[PR-47][IN-19] the source-batch count, the cumulative percentage and a used authorisation are judged over the step\'s earlier additions', () => {
    const p = phase({ reprocessing: { case: 'REPROCESSING_ADDITION', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 1 } });
    const run = startRun(blockMbr(TB08, p));
    run.entry('p', add({ gross: '0.520', tare: '0.500' }));
    const again = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: add({ gross: '0.505', tare: '0.500' }) });
    expect(again.refusal?.code).toBe('TB08-AUTHORISATION-USED');
    const other = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: add({ authorisation: '00000000-0000-4000-8000-0000000000c9', gross: '0.505', tare: '0.500' }, { sourceBatchId: '00000000-0000-4000-8000-0000000000b9' }) });
    expect(other.refusal?.code).toBe('TB08-TOO-MANY-SOURCES');
    const much = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: add({ authorisation: '00000000-0000-4000-8000-0000000000c9', gross: '0.511', tare: '0.500' }) });
    expect(much.refusal?.code).toBe('TB08-TOO-MUCH');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: add({ authorisation: '00000000-0000-4000-8000-0000000000c9', gross: '0.510', tare: '0.500' }) }).accepted).toBe(true);
    // Keyed by hand: the step needs its second person; performing computes 0.03 kg.
    run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    run.verify('p', [], VER1);
    expect(Object.values(run.state.points).find((x) => x.item === 'reworkAdded' && x.status === 'VALID')?.value).toEqual({ kind: 'DECIMAL', value: '0.03', unit: 'kg' });
  });

  it('[PR-47] per-use authorisation is always on for a reprocessing addition and off for a recovery only with the step\'s own prior authorisation; the configuration is checked', () => {
    const recovery = { case: 'RECOVERY' as const, maxPercent: '3', maxAge: { value: '90', unit: 'd' as const }, maxSourceBatches: 1 };
    const prior = { authorisationRef: 'TEST-AUTH-1', riskEvaluationRef: 'TEST-RA-1' };
    expect(perUseRequired({ reprocessing: recovery }, { perUseAuthorisation: false, priorAuthorisation: prior })).toBe(false);
    expect(perUseRequired({ reprocessing: recovery }, { perUseAuthorisation: false })).toBe(true);
    expect(perUseRequired({ reprocessing: { ...recovery, case: 'REPROCESSING_ADDITION' } }, { perUseAuthorisation: false, priorAuthorisation: prior })).toBe(true);
    const off = phase({ reprocessing: recovery, config: { ageFrom: 'MANUFACTURE', perUseAuthorisation: false, priorAuthorisation: prior } });
    expect(refusalOf(off, add({ authorisation: undefined, authorisedBy: undefined }, { case: 'RECOVERY' }))).toBeUndefined();
    expect(definitionCodes(blockMbr(TB08, phase({ config: { ageFrom: 'GENERATION', perUseAuthorisation: false } })))).toContain('TB08-AUTHORISATION');
    expect(definitionCodes(blockMbr(TB08, phase({ config: { ageFrom: 'NONE' } })))).toContain('TB08-AGE-FROM');
    expect(definitionCodes(blockMbr(TB08, phase({ config: { ageFrom: 'GENERATION', addedItem: 'nope' } })))).toContain('TB08-ADDED-ITEM');
    expect(definitionCodes(blockMbr(TB08, phase({ config: { ageFrom: 'GENERATION', pretreatmentStep: 'nope' } })))).toContain('TB08-PRETREATMENT');
    const noCase = fixturePhase(TB08);
    delete (noCase as { reprocessing?: unknown }).reprocessing;
    expect(definitionCodes(blockMbr(TB08, noCase))).toEqual(expect.arrayContaining(['TB08-NO-CASE']));
  });

  it('[INV-25][DI-33] the computed net is exact decimal text in the item unit', () => {
    expect(massText('25', 'g', 'kg')).toBe('0.025');
    expect(massText('0.250', 'kg', 'kg')).toBe('0.25');
    expect(massText('0.25', 'kg', 'g')).toBe('250');
    expect(massText('1', 'units', 'kg')).toBeUndefined();
    expect(blocks.reprocessing.weighedNet('0.900', '0.400')).toEqual({ ok: true, net: '0.500' });
  });
});
