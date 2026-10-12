/**
 * TB-03@1 solution and suspension preparation with use-by (IN-36, IN-13, PR-30) at its edges, through its handler on a
 * minimal view: the preparation once with its use-by from the database time, the appearance criterion with its title,
 * discards in the prepared unit never above it in total, PERFORMED and the use-by definition check. Written for the
 * Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { TB03, useByUs } from '../../../src/blocks/tb-03.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const NOW = 1_800_000_000_000_000n;
const H = 3_600_000_000n;
const CFG: Json = { solutionType: 'FILM_COAT', solvent: 'PURIFIED_WATER', useBy: { value: '4', unit: 'h' }, appearance: 'Clear' };
const kg = (value: string) => ({ value, unit: 'kg' });

class World {
  entries: E[] = [];
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return { phase: { id: 'p' }, config: this.config, stepKey: 'p@', nowUs: NOW, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[] } {
    const accept = TB03.handler?.acceptEntry?.bind(TB03.handler) as unknown as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: NOW });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
}

describe('TB-03 solutions', () => {
  it('[IN-36][PR-30] the preparation is recorded once, at the database time, with its use-by; an appearance that does not comply holds with its title', () => {
    const w = new World();
    expect(w.rec({ kind: 'PREPARED', quantity: kg('12'), appearance: 'COMPLIES' })).toStrictEqual({ data: { quantity: kg('12'), appearance: 'COMPLIES', preparedAtUs: NOW.toString(), useByUs: (NOW + 4n * H).toString(), preparedBy: 'OP1' } });
    expect(w.rec({ kind: 'PREPARED', quantity: kg('12'), appearance: 'COMPLIES' }).refused).toBe('p@ already records its preparation (TB03-TWICE; IN-36)');
    const bad = new World().rec({ kind: 'PREPARED', quantity: kg('1'), appearance: 'DOES_NOT_COMPLY' });
    expect(bad.exceptions).toEqual([
      { type: 'SOLUTION_APPEARANCE', title: 'The film coat solution of p@ does not meet its appearance criterion: the steps after it wait for a deviation', controls: ['IN-36', 'PR-29'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true },
    ]);
    expect(new World({ ...CFG, solutionType: undefined }).rec({ kind: 'PREPARED', quantity: kg('1'), appearance: 'X' }).exceptions?.[0]?.['title']).toBe('The prepared solution of p@ does not meet its appearance criterion: the steps after it wait for a deviation');
    expect(new World({ ...CFG, useBy: undefined }).rec({ kind: 'PREPARED', quantity: kg('1'), appearance: 'COMPLIES' }).refused).toBe('p has no use-by in its MBR (TB03-NO-USE-BY; IN-36, PR-30)');
  });

  it('[IN-36][PR-30] discards follow the preparation, in its unit, never above what was prepared in total (equal allowed)', () => {
    const w = new World();
    expect(w.rec({ kind: 'DISCARD', quantity: kg('1'), method: 'DRAIN' }).refused).toBe('p@ has no preparation yet (TB03-NOT-PREPARED; IN-36)');
    w.rec({ kind: 'PREPARED', quantity: kg('10'), appearance: 'COMPLIES' });
    expect(w.rec({ kind: 'DISCARD', quantity: { value: '1', unit: 'g' }, method: 'DRAIN' }).refused).toBe('What is discarded is in the prepared unit (kg) and never more than was prepared (TB03-DISCARD; IN-36, PR-30)');
    expect(w.rec({ kind: 'DISCARD', quantity: kg('10.1'), method: 'DRAIN' }).refused).toMatch(/TB03-DISCARD/);
    expect(w.rec({ kind: 'DISCARD', method: 'DRAIN' }).refused).toMatch(/TB03-DISCARD/);
    expect(w.rec({ kind: 'DISCARD', quantity: kg('6'), method: 'DRAIN' }).data).toStrictEqual({ quantity: kg('6'), method: 'DRAIN', discardedBy: 'OP1' });
    expect(w.rec({ kind: 'DISCARD', quantity: kg('4.1'), method: 'DRAIN' }).refused).toMatch(/TB03-DISCARD/);
    expect(w.rec({ kind: 'DISCARD', quantity: kg('4'), method: 'DRAIN' }).refused).toBeUndefined();
    const noUnit = new World();
    noUnit.entries.push({ id: 'P', kind: 'PREPARED', data: {}, recordedAt: NOW });
    expect(noUnit.rec({ kind: 'DISCARD', quantity: kg('1'), method: 'DRAIN' }).refused).toBe('What is discarded is in the prepared unit (-) and never more than was prepared (TB03-DISCARD; IN-36, PR-30)');
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a solution step (TB03-ENTRY; IN-36)');
  });

  it('[IN-36][PR-30] PERFORMED needs the preparation; the MBR gives a positive use-by in whole microseconds', () => {
    const before = (w: World) => (TB03.handler?.beforePerform?.bind(TB03.handler) as unknown as (v: blocks.HandlerView) => { message: string }[])(w.view()).map((p) => p.message);
    const w = new World();
    expect(before(w)).toEqual(['p@ has no preparation yet (TB03-NOT-PREPARED; IN-36)']);
    w.rec({ kind: 'PREPARED', quantity: kg('1'), appearance: 'COMPLIES' });
    expect(before(w)).toEqual([]);
    const P = (config: Json) => (TB03.checkConfig as unknown as (p: flow.PhaseNode, c: Json) => { code: string; message: string }[])({ id: 'p' } as flow.PhaseNode, config).map((x) => `${x.code}: ${x.message}`);
    const msg = 'TB03-USE-BY: Solution step p needs a positive use-by, a whole number of microseconds (from hold-time data)';
    expect(P(CFG)).toEqual([]);
    expect(P({ ...CFG, useBy: { value: '0', unit: 'h' } })).toEqual([msg]);
    expect(P({ ...CFG, useBy: undefined })).toEqual([msg]);
    expect(P({ ...CFG, useBy: { value: '0.0000001', unit: 's' } })).toEqual([msg]);
    expect(P({ ...CFG, useBy: { value: '0.000001', unit: 's' } })).toEqual([]);
    expect(useByUs(CFG)).toBe(4n * H);
  });
});
