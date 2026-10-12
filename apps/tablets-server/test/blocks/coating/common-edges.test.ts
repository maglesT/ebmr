/**
 * The tablet sample of the coating blocks (TB-18, TB-20; tablets spec C-16) at its edges: the MBR's count, a group
 * weighing with one total, one-by-one weighing with each weight, the stored members. Written for the Phase 3 exit
 * mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { sampleData, sampleOf } from '../../../src/blocks/coating/common.ts';

describe('coating samples', () => {
  it('[PR-29][DI-29] the count is the MBR\'s; a group weighing records one total and no weights; one-by-one weighing records each weight and no total', () => {
    const msg = (e: Record<string, unknown>, want?: string) => {
      const r = sampleOf(e, want);
      return r.ok ? 'ok' : r.message;
    };
    expect(msg({ count: '10', weighing: 'GROUP', total: '2.5', unit: 'g' }, '20')).toBe('The sample is 20 tablets as the MBR sets it, not 10');
    expect(msg({ count: '10', weighing: 'GROUP', total: '2.5', unit: 'g' }, '10')).toBe('ok');
    expect(msg({ count: '10', weighing: 'GROUP', total: '2.5', unit: 'g' })).toBe('ok');
    expect(msg({ count: '2', weighing: 'GROUP', unit: 'g' })).toBe('A group weighing records one total and no single weights');
    expect(msg({ count: '2', weighing: 'GROUP', total: 2.5, unit: 'g' })).toBe('A group weighing records one total and no single weights');
    expect(msg({ count: '2', weighing: 'GROUP', total: '2.5', weights: ['1', '1.5'], unit: 'g' })).toBe('A group weighing records one total and no single weights');
    expect(msg({ count: '2', weighing: 'INDIVIDUAL', weights: ['250', '251'], total: '501', unit: 'mg' })).toBe('Weighing one by one records each of the 2 tablet weights and no total');
    expect(msg({ count: '2', weighing: 'INDIVIDUAL', unit: 'mg' })).toBe('Weighing one by one records each of the 2 tablet weights and no total');
    expect(msg({ count: '3', weighing: 'INDIVIDUAL', weights: ['250', '251'], unit: 'mg' })).toBe('Weighing one by one records each of the 3 tablet weights and no total');
  });

  it('[PR-29][DI-29] the stored sample: the entered values with the computed total and mean in mg', () => {
    const g = sampleOf({ instrument: 'BAL-1', count: '4', weighing: 'GROUP', total: '1.0010', unit: 'g' }, '4');
    if (!g.ok) throw new Error(g.message);
    expect(sampleData(g.sample)).toStrictEqual({ instrument: 'BAL-1', weighing: 'GROUP', count: '4', unit: 'g', total: '1.0010', totalMg: '1001', meanMg: '250.250000' });
    const i = sampleOf({ instrument: 'BAL-2', count: '2', weighing: 'INDIVIDUAL', weights: ['250.1', '250.2'], unit: 'mg' }, undefined);
    if (!i.ok) throw new Error(i.message);
    expect(sampleData(i.sample)).toStrictEqual({ instrument: 'BAL-2', weighing: 'INDIVIDUAL', count: '2', unit: 'mg', weights: ['250.1', '250.2'], totalMg: '500.3', meanMg: '250.150000' });
  });
});
