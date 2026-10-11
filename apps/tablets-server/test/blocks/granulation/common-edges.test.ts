/**
 * The shared pieces of the Tablets blocks (granulation, forming and IPC common modules) at their edges: quantities,
 * durations and exact sums, seconds as the database writes them, G-06 inside a TB block (its problems are passed on,
 * never dropped), where a phase sits in the MBR (every flow construct), and the view a block gives another block's
 * handler. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import {
  ancestorsOf,
  durationUs,
  isRecord,
  lastAt,
  phasesOf,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  quantityOf,
  secondsText,
  sumOf,
  text,
  usableActual,
} from '../../../src/blocks/granulation/common.ts';
import { viewAs } from '../../../src/blocks/forming/common.ts';
import { TB06 } from '../../../src/blocks/forming/index.ts';
import { blockMbr, fixturePhase } from '../forming/support.ts';
import { mbrWithChildren, phase } from '../coating/support.ts';

type Json = Record<string, unknown>;

describe('values', () => {
  it('[DI-29][INV-25] records, text, quantities and durations as read; exact sums of one unit; seconds with six decimals', () => {
    expect([isRecord({}), isRecord([]), isRecord(null), isRecord('x')]).toEqual([true, false, false, false]);
    expect([text('a'), text(1)]).toEqual(['a', undefined]);
    expect(quantityOf({ value: '1.5', unit: 'kg' })).toEqual({ value: '1.5', unit: 'kg' });
    expect(quantityOf({ value: 1.5, unit: 'kg' })).toBeUndefined();
    expect(quantityOf({ value: '1.5', unit: 1 })).toBeUndefined();
    expect(quantityOf('1.5 kg')).toBeUndefined();
    expect(durationUs({ value: '1.5', unit: 's' })).toBe(1_500_000n);
    expect(durationUs({ value: '1', unit: 2 })).toBeUndefined();
    expect(sumOf([{ value: '1.25', unit: 'kg' }, { value: '2.750', unit: 'kg' }])).toEqual({ value: '4', unit: 'kg' });
    expect(sumOf([{ value: '1', unit: 'kg' }, { value: '1', unit: 'g' }])).toBeUndefined();
    expect(sumOf([{ value: '1', unit: 'kg' }, { value: '1', unit: 'kg' }, { value: '1', unit: 'g' }])).toBeUndefined();
    expect(sumOf([])).toBeUndefined();
    expect(sumOf([{ value: '0.1', unit: 'g' }])).toEqual({ value: '0.1', unit: 'g' });
    expect(secondsText(1n)).toBe('0.000001');
    expect(secondsText(1_500_000n)).toBe('1.500000');
    expect(secondsText(0n)).toBe('0.000000');
  });
});

describe('G-06 inside a TB block', () => {
  it('[PR-08][DI-31] G-06\'s definition problems, PERFORMED problems and nominal entries are passed on whole', () => {
    const p = fixturePhase(TB06);
    const actuals = ((p.config as Json)['actuals'] as Json[]) ?? [];
    const dup = { ...(p.config as Json), actuals: [...actuals, actuals[0]] };
    const q = fixturePhase(TB06, { config: dup as never });
    expect(processConfigProblems(q, dup as never, blockMbr(TB06, q)).map((x) => x.code)).toContain('G06-DUPLICATE-TAG');
    expect(processConfigProblems(p, p.config, blockMbr(TB06, p))).toEqual([]);
    const view = {
      phase: p,
      config: p.config,
      stepKey: 'p@',
      nowUs: 0n,
      entries: () => [],
      actor: { id: 'OP1' },
      parameter: () => undefined,
    } as unknown as blocks.HandlerView;
    expect(processBeforePerform(view).map((x) => x.code)).toEqual(expect.arrayContaining(['G06-RECIPE-UNCHECKED']));
    const nominal = processNominalEntries({ phase: p, config: p.config, mbr: blockMbr(TB06, p), frames: [], containers: [], target: () => undefined, nowUs: 1n } as never);
    expect(nominal.map((e) => e.kind)).toContain('ACTUAL');
  });

  it('[DI-31] a usable ACTUAL by its entry id; the last entry of a kind', () => {
    const view = {
      entries: (kind?: string) =>
        [
          { id: 'A', kind: 'ACTUAL', data: { usable: true }, recordedAt: 5n },
          { id: 'B', kind: 'ACTUAL', data: { usable: false }, recordedAt: 7n },
        ].filter((e) => kind === undefined || e.kind === kind),
    } as unknown as blocks.HandlerView;
    expect(usableActual(view, 'A')?.id).toBe('A');
    expect(usableActual(view, 'B')).toBeUndefined();
    expect(usableActual(view, 'C')).toBeUndefined();
    expect(lastAt(view, 'ACTUAL')).toBe(7n);
    expect(lastAt(view, 'OTHER')).toBeUndefined();
  });
});

describe('where a phase sits', () => {
  it('[DI-34] ancestors and phases through sequences, parallel branches, alternatives (with an empty branch), loops and replicates', () => {
    const a = phase('a');
    const b = phase('b');
    const c = phase('c');
    const d = phase('d');
    const tree: flow.FlowNode = {
      kind: 'parallel',
      id: 'par',
      branches: [
        { id: 'b1', body: { kind: 'loop', id: 'lp', name: 'L', body: a, maxIterations: 2, exit: { condition: 'x > 1', endpoint: 'x' } } },
        { id: 'b2', body: { kind: 'alternative', id: 'alt', branches: [{ id: 'x1', condition: 'true', body: b }, { id: 'x2', condition: 'false' }] } as never },
      ],
    } as never;
    const rep: flow.FlowNode = { kind: 'replicate', id: 'rep', name: 'R', over: 'SUBLOT', body: c } as never;
    const m = mbrWithChildren([tree, rep, d]);
    const ids = (ns: flow.FlowNode[]) => ns.map((n) => n.id);
    expect(ids(ancestorsOf(m, 'a')).slice(-3)).toEqual(['ops', 'par', 'lp']);
    expect(ids(ancestorsOf(m, 'b')).slice(-3)).toEqual(['ops', 'par', 'alt']);
    expect(ids(ancestorsOf(m, 'c')).slice(-2)).toEqual(['ops', 'rep']);
    expect(ids(ancestorsOf(m, 'd')).at(-1)).toBe('ops');
    expect(ancestorsOf(m, 'zz')).toEqual([]);
    expect(phasesOf(m).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('[DI-34] a block\'s view of another block\'s handler keeps the step, person and records and passes every read through', () => {
    const calls: string[] = [];
    const base = {
      phase: { id: 'p', block: { type: 'TB-16', version: '1' } },
      config: { a: 1 },
      stepKey: 'p@',
      frames: [],
      subLot: undefined,
      nowUs: 9n,
      actor: { id: 'OP1' },
      batch: { batchNumber: 'B' },
      mbr: {},
      expr: {},
      entries: (k?: string) => (calls.push(`entries:${k ?? ''}`), []),
      points: (i: string) => (calls.push(`points:${i}`), []),
      effective: (i: string) => (calls.push(`effective:${i}`), undefined),
      target: (i: string) => (calls.push(`target:${i}`), undefined),
      containers: () => (calls.push('containers'), []),
      parameter: (i: string) => (calls.push(`parameter:${i}`), undefined),
    } as unknown as blocks.HandlerView;
    const v = viewAs(base, 'TB-11', { b: 2 });
    expect([v.phase.block, v.phase.id, v.config, v.stepKey, v.nowUs, v.actor, v.batch]).toEqual([{ type: 'TB-11', version: '1' }, 'p', { b: 2 }, 'p@', 9n, { id: 'OP1' }, { batchNumber: 'B' }]);
    v.entries('X');
    v.points('i');
    v.effective('i');
    v.target('i');
    v.containers();
    v.parameter('i');
    expect(calls).toEqual(['entries:X', 'points:i', 'effective:i', 'target:i', 'containers', 'parameter:i']);
  });
});
