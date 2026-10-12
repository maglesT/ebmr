/**
 * TB-20@2 (Phase 4 slice 1b, D-P4-11) through the engine: a lot the sampling scheme has no plan for leaves the inspection
 * with the NO_PLAN outcome only through a deviation, raising AQL_NO_PLAN for QA; everything else is TB-20@1's. The
 * database twin is tablets 1113 (tb20-v2-db.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { flow } from '@ebmr/recipe-core/pure';
import { TB20, TB20_V2 } from '../../../src/blocks/coating/index.ts';
import { tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, definitionCodes, OP1, Run, runGolden, startRun } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };

const refusal = (run: Run, entry: Entry, frames: flow.Frame[] = [], step = 'p') => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step, context: frames, entry }).code;

const sorted = (accepted: string, inspected: string): Run => {
  const run = startRun(blockMbr(TB20_V2));
  run.entry('p', { kind: 'INSPECTION_START' });
  run.advance(600_000_000n);
  run.entry('p', { kind: 'INSPECTION_END' });
  const rejects = BigInt(inspected) - BigInt(accepted);
  run.entry('p', {
    kind: 'SORT_RESULT',
    inspected: { count: inspected, mass: { value: '0.003', unit: 'kg' } },
    accepted: { count: accepted, mass: { value: '0.001', unit: 'kg' } },
    defects: rejects > 0n ? [{ code: 'CHIPPED', count: rejects.toString() }] : [],
    rejects: rejects > 0n ? [{ category: 'DESTRUCTION', container: '00000000-0000-4000-8000-000000000001', count: rejects.toString(), mass: { value: '0.002', unit: 'kg' } }] : [],
  });
  return run;
};

describe('TB-20@2 NO_PLAN through a deviation (D-P4-11)', () => {
  it('[PR-29][PR-49][INV-41] TB-20@2 is registered beside TB-20@1, with the same configuration and the AQL_NO_PLAN rule; an MBR on it validates', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-20@1', 'TB-20@2']));
    expect(TB20_V2.configSchema).toBe(TB20.configSchema);
    expect((TB20_V2.exceptionRules ?? []).map((r) => r.type)).toEqual(['FOREIGN_TABLET_FOUND', 'AQL_REJECTED', 'AQL_NO_PLAN']);
    expect(definitionCodes(blockMbr(TB20_V2))).toEqual([]);
  });

  it('[PR-29][PR-49][INV-41] a lot without a plan is recorded NO_PLAN only with a deviation reference and no sample; it raises AQL_NO_PLAN (QA, deviation required, release blocking, the steps after it blocked until dispositioned)', () => {
    const run = sorted('1', '3');
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', found: {} })).toBe('TB20-NO-PLAN');
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN' })).toBe('TB20-NO-PLAN-DEVIATION');
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: '   ' })).toBe('TB20-NO-PLAN-DEVIATION');
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: 'TEST-DEV-1', found: { MAJOR: '0' } })).toBe('TB20-NO-PLAN-FOUND');
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', found: {}, deviationRef: 'TEST-DEV-1' })).toBe('TB20-NO-PLAN-ONLY');
    run.entry('p', { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: ' TEST-DEV-1 ' });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'AQL_RESULT');
    expect(e?.data).toEqual({ result: 'NO_PLAN', severity: 'NORMAL', lotSize: '1', deviationRef: 'TEST-DEV-1', recordedBy: OP1.id });
    const ex = run.exceptions('AQL_NO_PLAN')[0];
    expect([ex?.severity, ex?.qaOnly, ex?.releaseBlocking, ex?.deviationRequired, ex?.block?.until]).toEqual(['ACTION', true, true, true, 'DISPOSITION']);
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: 'TEST-DEV-1' })).toBe('TB20-AQL-TWICE');
  });

  it('[PR-29][DI-10] NO_PLAN is refused while the scheme has a plan for the lot: such a lot is sampled and judged as in TB-20@1', () => {
    const run = sorted('2', '2');
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: 'TEST-DEV-1' })).toBe('TB20-PLAN-EXISTS');
    run.entry('p', { kind: 'AQL_RESULT', severity: 'NORMAL', found: {} });
    expect(Object.values(run.state.entries).find((x) => x.kind === 'AQL_RESULT')?.data['result']).toBe('ACCEPTED');
  });

  it('[PR-29][PR-49] the TB-20@2 golden fixture: a lot of one accepted tablet leaves through its deviation with AQL_NO_PLAN', () => {
    const { run, performRefusal } = runGolden(TB20_V2);
    expect(performRefusal).toBeUndefined();
    expect(Object.values(run.state.exceptions).map((x) => x.type).sort()).toEqual(TB20_V2.goldenFixture?.expect.exceptions);
  });
});
