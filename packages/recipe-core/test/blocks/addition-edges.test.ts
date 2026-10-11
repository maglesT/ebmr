/**
 * The addition rules of reprocessing and recovery (PR-47, IN-19, INV-33) at their edges, on additionProblems directly:
 * only at an addition step, only a container of an earlier batch of this product and strength in the step's case, no
 * chained recovery, not older than the MBR maximum (counted from generation or manufacture; equal allowed), at most the
 * MBR's source batches, in the container's unit and never above what it holds, the step's cumulative net never above
 * the MBR's percentage of the standard batch size (equal allowed; earlier additions converted), and a per-use
 * authorisation by someone else, used once. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { Dec } from '@ebmr/expr';
import { additionProblems, cumulativeNet, G24_ADDITION_CODES, G24V2, qcDecisionOnPerform, sourceOf, type AdditionInput, type SourceFacts } from '../../src/blocks/generic/reprocessing.ts';
import type { HandlerView } from '../../src/blocks/contract.ts';

type Json = Record<string, unknown>;
const NOW = 1_000_000_000_000_000n;
const H = 3_600_000_000n;
const RP = { case: 'RECOVERY', maxAge: { value: '240', unit: 'h' }, maxSourceBatches: 2, maxPercent: '10' };
const SRC: SourceFacts = {
  container: 'C1',
  sourceBatchId: 'B1',
  product: 'P',
  strength: '10 mg',
  stage: 'GRAN',
  unit: 'kg',
  case: 'RECOVERY',
  generatedAtUs: String(NOW - 240n * H),
  manufacturedAtUs: String(NOW - 1000n * H),
  containsRecovered: false,
  remaining: '6',
};
const A: AdditionInput = { net: '5', unit: 'kg', source: SRC, authorisation: 'AUTH-1', authorisedBy: 'QA1', authorisationRequired: true, ageFrom: 'GENERATION' };

function view(over: { rp?: Json | null; prior?: Json[]; size?: Json | null } = {}): HandlerView {
  const rp = over.rp === null ? undefined : (over.rp ?? RP);
  const prior = over.prior ?? [];
  return {
    phase: { id: 'p', reprocessing: rp },
    stepKey: 'p@',
    batch: { batchId: 'B0', productCode: 'P' },
    mbr: { header: { product: { strength: '10 mg' }, batchSizes: over.size === null ? [] : [{ quantity: over.size ?? { value: '100', unit: 'kg' } }] } },
    nowUs: NOW,
    actor: { id: 'OP1' },
    entries: (k?: string) => (k === undefined || k === 'ADDITION' ? prior.map((data, i) => ({ id: `A${i}`, kind: 'ADDITION', data, recordedAt: 0n })) : []),
    expr: { convert: (v: string, from: string, to: string) => (from === 'g' && to === 'kg' ? Dec.parse(v).div(Dec.parse('1000')).toString() : undefined) },
  } as unknown as HandlerView;
}
const codes = (v: HandlerView, a: Partial<AdditionInput> = {}, s: Partial<SourceFacts> | null = {}) =>
  additionProblems(v, G24_ADDITION_CODES, { ...A, ...a, source: s === null ? undefined : { ...SRC, ...s } }).map((p) => p.code);
const msgs = (v: HandlerView, a: Partial<AdditionInput> = {}, s: Partial<SourceFacts> = {}) => additionProblems(v, G24_ADDITION_CODES, { ...A, ...a, source: { ...SRC, ...s } }).map((p) => p.message);
const prior = (net: Json, sourceBatchId = 'B1', authorisation: unknown = 'AUTH-0'): Json => ({ net, source: { sourceBatchId }, authorisation });

describe('addition rules', () => {
  it('[PR-47][IN-19] only at a recovery or reprocessing-addition step; only a container of the step\'s case, of an earlier batch of this product and strength, never chained', () => {
    expect(codes(view())).toEqual([]);
    expect(codes(view({ rp: null }))).toEqual(['G24-NO-ADDITION']);
    expect(codes(view({ rp: { ...RP, case: 'REWORK' } }))).toEqual(['G24-NO-ADDITION']);
    expect(codes(view({ rp: { ...RP, case: 'REPROCESSING_ADDITION' } }), {}, { case: 'REPROCESSING_ADDITION' })).toEqual([]);
    expect(codes(view(), {}, null)).toEqual(['G24-AD-HOC']);
    expect(msgs(view(), {}, { case: undefined })).toEqual(['Container C1 is not conforming material released by QA (G24-SOURCE-STATUS; PR-47, IN-19)']);
    expect(msgs(view({ rp: { ...RP, case: 'REPROCESSING_ADDITION' } }), {}, { case: 'RECOVERY' })).toEqual(['Container C1 is not reject material the quality unit reserved for reprocessing (G24-SOURCE-STATUS; PR-47, IN-19)']);
    expect(codes(view(), {}, { sourceBatchId: 'B0' })).toEqual(['G24-OWN-BATCH']);
    expect(codes(view(), {}, { product: 'Q' })).toEqual(['G24-OTHER-PRODUCT']);
    expect(msgs(view(), {}, { strength: '20 mg' })).toEqual(['Material of P 20 mg cannot be added to a batch of P 10 mg (G24-OTHER-PRODUCT; PR-47, IN-19)']);
    expect(codes(view(), {}, { containsRecovered: true })).toEqual(['G24-CHAINED']);
  });

  it('[IN-19][PR-47] the age from generation or manufacture, the MBR maximum allowed exactly; no maximum or no instant is too old', () => {
    expect(codes(view(), {}, { generatedAtUs: String(NOW - 240n * H - 1n) })).toEqual(['G24-TOO-OLD']);
    expect(codes(view(), { ageFrom: 'MANUFACTURE' })).toEqual(['G24-TOO-OLD']);
    expect(codes(view(), { ageFrom: 'MANUFACTURE' }, { manufacturedAtUs: String(NOW - 240n * H) })).toEqual([]);
    expect(codes(view(), {}, { generatedAtUs: 'x' })).toEqual(['G24-TOO-OLD']);
    expect(msgs(view({ rp: { ...RP, maxAge: undefined } }))).toEqual(['The material of container C1 is older than the MBR maximum of ?  (G24-TOO-OLD; IN-19, PR-47)']);
    expect(msgs(view(), {}, { generatedAtUs: '1' })).toEqual(['The material of container C1 is older than the MBR maximum of 240 h (G24-TOO-OLD; IN-19, PR-47)']);
  });

  it('[IN-19][PR-47][INV-33] the source batches up to the MBR number; the container\'s unit and what it holds; the cumulative net up to the MBR percentage, earlier additions converted', () => {
    expect(codes(view({ prior: [prior({ value: '1', unit: 'kg' }, 'B2')] }))).toEqual([]);
    expect(codes(view({ prior: [prior({ value: '1', unit: 'kg' }, 'B2'), prior({ value: '1', unit: 'kg' }, 'B3', 'AUTH-9')] }))).toEqual(['G24-TOO-MANY-SOURCES']);
    expect(msgs(view({ rp: { ...RP, maxSourceBatches: undefined } }))).toEqual(['At most 0 source batches may be added at p (G24-TOO-MANY-SOURCES; IN-19)']);
    expect(codes(view(), { unit: 'g' })).toEqual(['G24-UNIT']);
    expect(codes(view(), { net: '6' })).toEqual([]);
    expect(msgs(view(), { net: '6.001' })).toEqual(['Container C1 holds 6 kg; 6.001 kg cannot be taken from it (G24-OVER-REMAINING; PR-47, INV-33)']);
    const fourKg = [prior({ value: '4000', unit: 'g' })];
    expect(cumulativeNet(view({ prior: fourKg }), 'kg', { value: '6', unit: 'kg' })).toBe('10');
    expect(cumulativeNet(view({ prior: [prior(undefined as never)] }), 'kg')).toBeUndefined();
    expect(codes(view({ prior: fourKg }), { net: '6' })).toEqual([]);
    expect(codes(view({ prior: fourKg }), { net: '6.001' }, { remaining: '7' })).toEqual(['G24-TOO-MUCH']);
    expect(codes(view({ prior: [prior({ value: '1', unit: 'lb' })] }))).toEqual(['G24-TOO-MUCH']);
    expect(codes(view({ size: null }))).toEqual(['G24-TOO-MUCH']);
    expect(msgs(view({ rp: { ...RP, maxPercent: undefined } }))).toEqual(['The material added at p would exceed ? % of the standard batch size (G24-TOO-MUCH; IN-19, PR-47)']);
  });

  it('[PR-47] a per-use authorisation by the quality unit, never the one who adds, used once; optional where the step does not require it', () => {
    expect(codes(view(), { authorisation: undefined })).toEqual(['G24-NOT-AUTHORISED']);
    expect(codes(view(), { authorisation: undefined, authorisationRequired: false })).toEqual([]);
    expect(msgs(view(), { authorisedBy: undefined })).toEqual(['Authorisation AUTH-1 is not signed by the quality unit (G24-NOT-AUTHORISED; PR-47)']);
    expect(codes(view(), { authorisedBy: 'OP1' })).toEqual(['G24-SELF-AUTHORISED']);
    expect(codes(view({ prior: [prior({ value: '0.1', unit: 'kg' }, 'B1', 'AUTH-1')] }))).toEqual(['G24-AUTHORISATION-USED']);
    expect(codes(view({ prior: [prior({ value: '0.1', unit: 'kg' }, 'B1', 'AUTH-1')] }), { authorisedBy: 'OP1' })).toEqual(['G24-SELF-AUTHORISED', 'G24-AUTHORISATION-USED']);
  });

  it('[PR-47][IN-19] an entry carries source facts only as a record naming its container', () => {
    expect(sourceOf({ source: SRC })).toBe(SRC);
    expect(sourceOf({ source: { ...SRC, container: 1 } })).toBeUndefined();
    expect(sourceOf({ source: [SRC] })).toBeUndefined();
    expect(sourceOf({ source: null })).toBeUndefined();
    expect(sourceOf({ source: 'C1' })).toBeUndefined();
    expect(sourceOf({})).toBeUndefined();
  });
});

describe('G-24@2 reprocessing step (mutation follow-up)', () => {
  type R = { ok: boolean; data?: Json; problems?: { code: string; message: string }[]; verificationRequired?: boolean };
  const accept = (v: HandlerView, e: Json & { kind: string }) => (G24V2.handler?.acceptEntry as (v: HandlerView, e: Json) => R)(v, e);
  const perform = (v: HandlerView) => (G24V2.handler?.onPerform as (v: HandlerView) => { exceptions: Json[] })(v).exceptions.map((x) => x['type']);
  const add = (over: Json = {}) => ({ kind: 'ADDITION', container: 'C1', quantity: { value: '5', unit: 'kg' }, authorisation: 'AUTH-1', authorisedBy: 'QA1', source: SRC, ...over });

  it('[PR-47][IN-19] only additions; each needs its per-use authorisation (an empty one is none); an accepted addition is stored with its case and needs a second person', () => {
    expect(accept(view(), { kind: 'OTHER' }).problems?.map((p) => p.message)).toEqual(['OTHER is not an entry of a reprocessing step (G24-ENTRY; PR-47)']);
    expect(accept(view(), add({ authorisation: '' })).problems?.map((p) => p.code)).toEqual(['G24-NOT-AUTHORISED']);
    expect(accept(view(), add({ authorisedBy: '' })).problems?.map((p) => p.code)).toEqual(['G24-NOT-AUTHORISED']);
    expect(accept(view(), add({ authorisedBy: 7 })).problems?.map((p) => p.code)).toEqual(['G24-NOT-AUTHORISED']);
    expect(accept(view(), add())).toStrictEqual({ ok: true, data: { container: 'C1', net: { value: '5', unit: 'kg' }, source: SRC, case: 'RECOVERY', authorisation: 'AUTH-1', authorisedBy: 'QA1', addedBy: 'OP1' }, verificationRequired: true });
    expect(accept(view(), add({ source: undefined })).problems?.map((p) => p.code)).toEqual(['G24-AD-HOC']);
  });

  it('[PR-47][IN-19] the release-blocking QC decision: always after whole-batch reprocessing, after an addition only when one was made', () => {
    expect(perform(view())).toEqual([]);
    expect(perform(view({ prior: [prior({ value: '1', unit: 'kg' })] }))).toEqual(['QC_ADDITIONAL_TESTING_DECISION']);
    expect(perform(view({ rp: { case: 'WHOLE_BATCH_REPROCESSING' } }))).toEqual(['QC_ADDITIONAL_TESTING_DECISION']);
    expect(perform(view({ rp: null }))).toEqual([]);
    expect(qcDecisionOnPerform(view(), true).exceptions[0]).toEqual({
      type: 'QC_ADDITIONAL_TESTING_DECISION',
      title: 'p@ added reprocessed or recovered material: QC must record a decision on additional testing before release',
      controls: ['PR-47', 'IN-19'],
      severity: 'ALERT',
      category: 'DEVIATION_OR_OVERRIDE',
      blocks: 'NONE',
      releaseBlocking: true,
    });
    const check = (reprocessing: unknown) => G24V2.checkConfig?.({ id: 'p', ...(reprocessing ? { reprocessing } : {}) } as never, {}, {} as never);
    expect(check(undefined)).toEqual([{ code: 'G24-NO-CASE', severity: 'ERROR', message: 'Reprocessing step p declares no case (whole-batch reprocessing, reprocessing addition, recovery)', controls: ['PR-47', 'IN-19'] }]);
    expect(check({ case: 'RECOVERY' })).toEqual([]);
  });
});
