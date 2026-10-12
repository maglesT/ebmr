/**
 * TB-08@1 rework or recovered-material addition (tablets spec B.2 TB-08, PR-47, IN-19) at its edges: every definition
 * check with its message, the source types, the stored addition, the refusals' messages, and the net added computed
 * into an item in g or kg. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { flow } from '@ebmr/recipe-core/pure';
import { TB08 } from '../../../src/blocks/reprocessing/index.ts';
import { massText, perUseRequired } from '../../../src/blocks/tb-08.ts';
import { blockMbr, fixturePhase, OP1, startRun, T0, VER1 } from '../coating/support.ts';
import { phase as plainPhase } from '../../../../../packages/recipe-core/test/flow/support.ts';

type Json = Record<string, unknown>;
const DAY = 86_400_000_000n;
const AUTH = '00000000-0000-4000-8000-0000000000c8';
const QA = '00000000-0000-4000-8000-0000000000d8';
const source = (extra: Json = {}): Json => ({
  container: '00000000-0000-4000-8000-0000000000a8', sourceBatchId: '00000000-0000-4000-8000-0000000000b8', product: 'P', strength: '1 mg', stage: 'INSPECTION', unit: 'kg', case: 'REPROCESSING_ADDITION',
  generatedAtUs: String(T0 - 10n * DAY), manufacturedAtUs: String(T0 - 20n * DAY), containsRecovered: false, remaining: '0.4', ...extra,
});
const add = (extra: Json = {}, src: Json = {}): Json & { kind: string } => ({
  kind: 'ADDITION', container: '00000000-0000-4000-8000-0000000000a8', gross: '0.525', tare: '0.500', unit: 'kg', authorisation: AUTH, authorisedBy: QA, source: source(src), ...extra,
});
const P = (p: flow.PhaseNode, mbr: flow.MbrContent = blockMbr(TB08, p)): string[] => {
  const check = TB08.checkConfig?.bind(TB08) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
  return check(p, p.config as Json, mbr).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
};
const refusal = (p: flow.PhaseNode, entry: Json & { kind: string }): string | undefined => {
  const run = startRun(blockMbr(TB08, p));
  const r = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry });
  return r.accepted ? undefined : r.refusal?.message;
};

describe('TB-08 definition checks', () => {
  it('[PR-47][IN-19][INV-25] the case, the age reference, per-use authorisation, a mass batch size, the added item and the pre-treatment step, each with its message', () => {
    const p = fixturePhase(TB08);
    expect(P(p)).toEqual([]);
    const noCase = fixturePhase(TB08);
    delete (noCase as { reprocessing?: unknown }).reprocessing;
    expect(P(noCase)).toEqual(['TB08-NO-CASE [PR-47,IN-19] Addition step p declares the case reprocessing addition or recovery with its limits']);
    expect(P(fixturePhase(TB08, { reprocessing: { ...(p.reprocessing as flow.PhaseNode['reprocessing'] & object), case: 'OTHER' as never } }))).toEqual([
      'TB08-NO-CASE [PR-47,IN-19] Addition step p declares the case reprocessing addition or recovery with its limits',
    ]);
    expect(P(fixturePhase(TB08, { config: { ageFrom: 'NEVER' } }))).toEqual(['TB08-AGE-FROM [IN-19] Addition step p says from which instant the age of the source is counted']);
    const prior = { authorisationRef: 'A', riskEvaluationRef: 'R' };
    const recovery = { ...(p.reprocessing as object), case: 'RECOVERY' } as NonNullable<flow.PhaseNode['reprocessing']>;
    const auth = 'TB08-AUTHORISATION [PR-47] Per-use authorisation is always on for a reprocessing addition, and off for a recovery only when p carries its prior authorisation and risk evaluation';
    expect(P(fixturePhase(TB08, { config: { perUseAuthorisation: false, priorAuthorisation: prior } }))).toEqual([auth]);
    expect(P(fixturePhase(TB08, { reprocessing: recovery, config: { perUseAuthorisation: false } }))).toEqual([auth]);
    expect(P(fixturePhase(TB08, { reprocessing: recovery, config: { perUseAuthorisation: false, priorAuthorisation: prior } }))).toEqual([]);
    expect(P(fixturePhase(TB08, { config: { perUseAuthorisation: true } }))).toEqual([]);
    const mass = (unit: string) => {
      const m = blockMbr(TB08, p);
      return P(p, { ...m, header: { ...m.header, batchSizes: [{ ...(m.header.batchSizes[0] as object), quantity: { value: '1000', unit } }] as never } });
    };
    expect(mass('g')).toEqual([]);
    expect(mass('kg')).toEqual([]);
    expect(mass('L')).toEqual(["TB08-BATCH-MASS [IN-19] The maximum addition of p is a percentage of the standard batch mass, so the MBR's first batch size is a mass"]);
    const m0 = blockMbr(TB08, p);
    expect(P(p, { ...m0, header: { ...m0.header, batchSizes: [] } })).toEqual(["TB08-BATCH-MASS [IN-19] The maximum addition of p is a percentage of the standard batch mass, so the MBR's first batch size is a mass"]);
  });

  it('[PR-47][INV-25] the added item is a single decimal in kg or g the step records; the pre-treatment is a TB-02 step of the MBR', () => {
    const item = 'TB08-ADDED-ITEM [PR-47,INV-25] The added-material item reworkAdded of p is a single decimal in kg or g that the step records';
    const withParam = (param: Json, phaseExtra: Partial<flow.PhaseNode> = {}) => {
      const q = fixturePhase(TB08, phaseExtra);
      const m = blockMbr(TB08, q);
      return P(q, { ...m, parameters: m.parameters.map((x) => (x.id === 'reworkAdded' ? ({ ...x, ...param }) : x)) });
    };
    expect(withParam({ unit: 'g' })).toEqual([]);
    expect(withParam({ unit: 'mg' })).toEqual([item]);
    expect(withParam({ valueType: 'INTEGER' })).toEqual([item]);
    expect(withParam({ readings: 2 })).toEqual([item]);
    expect(withParam({ readings: 1 })).toEqual([]);
    expect(withParam({}, { records: [] })).toEqual([item]);
    expect(P(fixturePhase(TB08, { config: { addedItem: 'nope' } }))).toEqual(['TB08-ADDED-ITEM [PR-47,INV-25] The added-material item nope of p is a single decimal in kg or g that the step records']);
    expect(P(fixturePhase(TB08, { config: { pretreatmentStep: 'p' } }))).toEqual(['TB08-PRETREATMENT [PR-47] The pre-treatment of p is a sifting or milling step (TB-02) of the MBR']);
    // A TB-02 step of the MBR is accepted (the check reads the MBR's phases).
    const q = fixturePhase(TB08, { config: { pretreatmentStep: 'sift' } });
    const sift = plainPhase('sift', { block: { type: 'TB-02', version: '1' } });
    const other = plainPhase('mill', { block: { type: 'TB-04', version: '1' } });
    const m = blockMbr(TB08, q);
    const withSteps = (steps: flow.FlowNode[]) => ({ ...m, procedure: { ...m.procedure, body: { kind: 'sequence', id: 'ops2', children: [...steps, m.procedure.body] } } }) as flow.MbrContent;
    expect(P(q, withSteps([sift]))).toEqual([]);
    expect(P(q, withSteps([other]))).toEqual(['TB08-PRETREATMENT [PR-47] The pre-treatment of p is a sifting or milling step (TB-02) of the MBR']);
  });
});

describe('TB-08 additions', () => {
  it('[PR-47][IN-19] the refusals say why: not an addition, not weighed, not an allowed source type', () => {
    const p = fixturePhase(TB08);
    expect(refusal(p, add({ gross: '0.500', tare: '0.500' }))).toMatch(/^The addition is weighed: .* \(TB08-NET; PR-47, INV-33\)/);
    expect(refusal(p, add({}, { stage: 'BLENDING' }))).toMatch(/^Material filled at stage BLENDING is not a source type the MBR allows here \(INSPECTION\) \(TB08-SOURCE-TYPE; PR-47, IN-19\)/);
    expect(refusal(fixturePhase(TB08, { config: { ageFrom: 'GENERATION', sourceStages: ['INSPECTION', 'COATING'], addedItem: 'reworkAdded' } }), add({}, { stage: 'COATING' }))).toBeUndefined();
    const anyStage = fixturePhase(TB08);
    (anyStage.config as Json)['sourceStages'] = undefined;
    expect(refusal(anyStage, add({}, { stage: 'BLENDING' }))).toBeUndefined();
    const accept = TB08.handler?.acceptEntry?.bind(TB08.handler) as unknown as (v: unknown, e: Json & { kind: string }) => { problems?: { message: string }[] };
    expect(accept({}, { kind: 'OTHER' }).problems?.map((x) => x.message)).toEqual(['OTHER is not an entry of a rework or recovery addition step (TB08-ENTRY; PR-47)']);
  });

  it('[PR-47][DI-33] an accepted addition stores the weighing, the source, the case, the authorisation and its signer, and who added it; it always needs a second person', () => {
    const run = startRun(blockMbr(TB08, fixturePhase(TB08)));
    run.entry('p', add());
    const stored = Object.values(run.state.entries).find((x) => x.kind === 'ADDITION')?.data;
    expect(stored).toStrictEqual({ container: '00000000-0000-4000-8000-0000000000a8', gross: '0.525', tare: '0.500', net: { value: '0.025', unit: 'kg' }, source: source(), case: 'REPROCESSING_ADDITION', authorisation: AUTH, authorisedBy: QA, addedBy: OP1.id });
    expect(run.inst('p')?.verificationRequired).toBe(true);
    const prior = { authorisationRef: 'A', riskEvaluationRef: 'R' };
    const recovery = fixturePhase(TB08, { reprocessing: { ...(fixturePhase(TB08).reprocessing as object), case: 'RECOVERY' } as never, config: { perUseAuthorisation: false, priorAuthorisation: prior } });
    const r2 = startRun(blockMbr(TB08, recovery));
    r2.entry('p', add({ authorisation: undefined, authorisedBy: undefined }, { case: 'RECOVERY' }));
    const d2 = Object.values(r2.state.entries).find((x) => x.kind === 'ADDITION')?.data as Json;
    expect(d2).not.toHaveProperty('authorisation');
    expect(d2).not.toHaveProperty('authorisedBy');
    expect(d2['case']).toBe('RECOVERY');
  });

  it('[INV-25][DI-33] the net added is computed into an item in g as exact text; without the item nothing is computed', () => {
    const p = fixturePhase(TB08);
    const m = blockMbr(TB08, p);
    const g = { ...m, parameters: m.parameters.map((x) => (x.id === 'reworkAdded' ? { ...x, unit: 'g' } : x)) };
    const run = startRun(g);
    run.entry('p', add());
    run.entry('p', add({ authorisation: '00000000-0000-4000-8000-0000000000c9', gross: '505', tare: '500', unit: 'g' }, { unit: 'g', remaining: '400', sourceBatchId: '00000000-0000-4000-8000-0000000000b8' }));
    run.perform('p');
    run.verify('p', [], VER1);
    expect(Object.values(run.state.points).find((x) => x.item === 'reworkAdded' && x.status === 'VALID')?.value).toEqual({ kind: 'DECIMAL', value: '30', unit: 'g' });
    expect(TB08.handler?.computedItems?.(fixturePhase(TB08, { config: { addedItem: undefined } as never }), m)).toEqual([]);
    expect(TB08.handler?.computedItems?.(p, m)).toEqual(['reworkAdded']);
  });

  it('[PR-47][INV-25] per-use authorisation and mass conversion at their edges', () => {
    expect(perUseRequired({}, { perUseAuthorisation: false, priorAuthorisation: {} })).toBe(true);
    expect(perUseRequired({ reprocessing: { case: 'RECOVERY' } as never }, { perUseAuthorisation: true, priorAuthorisation: {} })).toBe(true);
    expect(perUseRequired({ reprocessing: { case: 'RECOVERY' } as never }, { perUseAuthorisation: false, priorAuthorisation: 'x' })).toBe(true);
    expect(massText('25.50', 'g', 'g')).toBe('25.5');
    expect(massText('1', 'kg', 'mg')).toBeUndefined();
    expect(massText('1', 'g', 'mg')).toBeUndefined();
    expect(massText('1', 'mg', 'g')).toBeUndefined();
  });
});
