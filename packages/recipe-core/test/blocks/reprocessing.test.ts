/**
 * G-24@2, the reprocessing and recovery gate on the database's facts (Phase 3 slice 5b; D-S5-7, D-S5-8): the addition
 * rules of blocks/generic/reprocessing.ts through the engine, on facts as the server reads them from the database. The
 * database repeats them at the row's time (recipe-core 0622; proven in apps/tablets-server test blocks/reprocessing).
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { G24V2, G24_ADDITION_CODES, SOURCE_FACTS_SCHEMA } from '../../src/blocks/generic/reprocessing.ts';
import { validateSchema } from '../../src/blocks/schema.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, Run, T0, VER1 } from '../engine/support.ts';

type Json = Record<string, unknown>;
const DAY = 86_400_000_000n;
const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const one = (p: Partial<PhaseNode>): MbrContent => mbrWith(seq('ops', phase('x', p), phase('z')));
const recovery = (max = 2): MbrContent => one({ block: { type: 'G-24', version: '2' }, reprocessing: { case: 'RECOVERY', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: max } });
const QA = '00000000-0000-4000-8000-0000000000d1';
const src = (extra: Json = {}): Json => ({
  container: '00000000-0000-4000-8000-0000000000a1', sourceBatchId: '00000000-0000-4000-8000-0000000000b1', product: 'P', strength: '1 mg', stage: 'COMPRESSION', unit: 'kg',
  case: 'RECOVERY', generatedAtUs: String(T0 - 5n * DAY), manufacturedAtUs: String(T0 - 6n * DAY), containsRecovered: false, remaining: '5', ...extra,
});
const add = (extra: Json = {}, s: Json = {}): Json & { kind: string } => ({
  kind: 'ADDITION', container: '00000000-0000-4000-8000-0000000000a1', quantity: { value: '0.010', unit: 'kg' }, authorisation: '00000000-0000-4000-8000-0000000000c1', authorisedBy: QA, source: src(s), ...extra,
});

describe('G-24@2 reprocessing and recovery gate on the database facts', () => {
  it('[PR-47][IN-19] an addition without prior authorisation, by its authoriser, of another product, over the MBR percentage, age or source-batch count, from a source holding recovered material, from material of another status, or from ad-hoc material is refused', () => {
    const run = Run.issue(define(recovery()));
    run.start('x');
    const code = (e: Json & { kind: string }, actor = OP1) => run.exec({ type: 'RECORD_ENTRY', actor, step: 'x', entry: e }).refusal?.code;
    expect(code(add({ authorisation: undefined, authorisedBy: undefined }))).toBe('ENG-ENTRY-SCHEMA');
    expect(code(add({ authorisedBy: undefined }))).toBe('G24-NOT-AUTHORISED');
    expect(code(add(), { ...OP1, id: QA })).toBe('G24-SELF-AUTHORISED');
    expect(code(add({}, { product: 'Q' }))).toBe('G24-OTHER-PRODUCT');
    expect(code(add({}, { containsRecovered: true }))).toBe('G24-CHAINED');
    expect(code(add({}, { generatedAtUs: String(T0 - 91n * DAY) }))).toBe('G24-TOO-OLD');
    expect(code(add({ quantity: { value: '0.031', unit: 'kg' } }))).toBe('G24-TOO-MUCH');
    expect(code(add({}, { case: 'REPROCESSING_ADDITION' }))).toBe('G24-SOURCE-STATUS');
    expect(code(add({}, { case: undefined }))).toBe('G24-SOURCE-STATUS');
    expect(code(add({}, { sourceBatchId: '00000000-0000-4000-8000-000000000001' }))).toBeUndefined();
    expect(code(add({}, { remaining: '0.001' }))).toBe('G24-OVER-REMAINING');
    expect(code(add({ quantity: { value: '10', unit: 'g' } }))).toBe('G24-UNIT');
    expect(code(add({ source: undefined }))).toBe('ENG-ENTRY-SCHEMA');
    expect(code({ kind: 'SOURCE_ADDITION' })).toBeDefined();
  });

  it('[PR-47][IN-19] the step\'s source batches, cumulative percentage and authorisations are judged together; a performed step that added material raises the QC decision on extra testing (release-blocking), and the entry needs the second person', () => {
    const run = Run.issue(define(recovery(1)));
    run.start('x');
    run.entry('x', add());
    const again = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: add() });
    expect(again.refusal?.code).toBe('G24-AUTHORISATION-USED');
    const other = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: add({ authorisation: '00000000-0000-4000-8000-0000000000c2' }, { sourceBatchId: '00000000-0000-4000-8000-0000000000b2' }) });
    expect(other.refusal?.code).toBe('G24-TOO-MANY-SOURCES');
    const much = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: add({ authorisation: '00000000-0000-4000-8000-0000000000c2', quantity: { value: '0.021', unit: 'kg' } }) });
    expect(much.refusal?.code).toBe('G24-TOO-MUCH');
    run.perform('x');
    expect(run.status('x')).toBe('AWAITING_VERIFICATION');
    run.verify('x', [], VER1);
    const ex = Object.values(run.state.exceptions);
    expect(ex.map((x) => x.type)).toEqual(['QC_ADDITIONAL_TESTING_DECISION']);
    expect(ex[0]?.releaseBlocking).toBe(true);
    expect(Object.values(run.state.entries).find((e) => e.kind === 'ADDITION')?.data).toMatchObject({ case: 'RECOVERY', addedBy: 'OP1', net: { value: '0.010', unit: 'kg' } });
  });

  it('[PR-47] G-24@2 takes no start data (the database starts it on the signed authorisation), records ADDITION entries only, and names its codes in its source', () => {
    expect(G24V2.dataSchema?.startData).toBeUndefined();
    expect(Object.keys(G24V2.dataSchema?.entries ?? {})).toEqual(['ADDITION']);
    expect(Object.values(G24_ADDITION_CODES).every((c) => c.startsWith('G24-'))).toBe(true);
    expect(validateSchema(SOURCE_FACTS_SCHEMA, src())).toEqual([]);
    expect(validateSchema(SOURCE_FACTS_SCHEMA, { ...src(), remaining: '5.0' }).length).toBeGreaterThan(0);
    const run = Run.issue(define(recovery()));
    expect(run.exec({ type: 'START_STEP', actor: OP1, step: 'x', blockData: { authorisation: 'x' } }).refusal?.code).toBe('ENG-ENTRY-SCHEMA');
    run.start('x');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: { kind: 'SOURCE_ADDITION' } }).accepted).toBe(false);
  });
});
