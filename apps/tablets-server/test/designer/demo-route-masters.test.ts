/**
 * Phase 7 slice 7l (requirement R1): the demo route masters are GMP masters the designer accepts (they parse, the
 * execution definition finds nothing to refuse) and carry the blocks their route is there to show; the references they
 * pin are in the DEMO-ONLY catalogue (pinned() throws otherwise). Approval and authorisation run in the demo set-up
 * (cli/demo-routes.ts) through the real signed acts, as the release path's masters do.
 */
import { describe, expect, it } from 'vitest';
import type { flow } from '@ebmr/recipe-core/pure';
import { definitionFindings } from '../../src/features/designer/definition.ts';
import { rtwPackagingContent, rtwProcessingContent } from '../../src/cli/demo-route-masters.ts';
import { rtdPackagingContent, rtdProcessingContent } from '../../src/cli/demo-route-masters-ds.ts';

function blocksOf(n: unknown, out: Map<string, Record<string, unknown>[]> = new Map()): Map<string, Record<string, unknown>[]> {
  if (Array.isArray(n)) for (const x of n) blocksOf(x, out);
  else if (n && typeof n === 'object') {
    const o = n as Record<string, unknown>;
    if (o['kind'] === 'phase') {
      const b = o['block'] as { type: string };
      out.set(b.type, [...(out.get(b.type) ?? []), (o['config'] ?? {}) as Record<string, unknown>]);
    }
    for (const v of Object.values(o)) blocksOf(v, out);
  }
  return out;
}

const errors = (mbr: flow.MbrContent) => definitionFindings(mbr).filter((f) => f.severity === 'ERROR');

describe('demo route W masters (slice 7l, R1)', () => {
  it('the processing master defines without errors and shows the wet route\'s blocks: TB-01 to TB-05, TB-07 to TB-15, TB-18 (functional film), TB-20', () => {
    const mbr = rtwProcessingContent('RTW-WG-TEST');
    expect(errors(mbr)).toEqual([]);
    const b = blocksOf(mbr.procedure);
    for (const t of ['TB-01', 'TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07', 'TB-08', 'TB-09', 'TB-10', 'TB-11', 'TB-12', 'TB-13', 'TB-14', 'TB-15', 'TB-18', 'TB-20']) expect(b.has(t), t).toBe(true);
    expect(b.get('TB-18')?.some((c) => c['coatingType'] === 'FC_F' && c['minGain'] === '2.5')).toBe(true);
    expect(b.get('TB-15')?.[0]?.['tabletType']).toBe('GASTRO_RESISTANT');
    expect(mbr.header.product.code).toBe('EXZ-GR-250');
  });

  it('the packaging master defines without errors and packs in alu-alu cold-form blisters: TB-21 COLD_FORM, TB-22, TB-24', () => {
    const mbr = rtwPackagingContent('RTW-CF-TEST');
    expect(errors(mbr)).toEqual([]);
    const b = blocksOf(mbr.procedure);
    expect(b.get('TB-21')?.every((c) => (c['packFormat'] as { form: string }).form === 'COLD_FORM')).toBe(true);
    for (const t of ['TB-22', 'TB-24', 'G-21', 'G-23']) expect(b.has(t), t).toBe(true);
    expect(mbr.header.packType).toBe('ALU-ALU-BLISTER');
  });
});

describe('demo route D masters (slice 7m, R1)', () => {
  it('the processing master defines without errors and shows the dry route\'s blocks: TB-01, TB-06 roller compaction, TB-02, TB-07 for both layers, TB-09, TB-10, TB-16 bilayer, TB-17, TB-19 printing behind its gate', () => {
    const mbr = rtdProcessingContent('RTD-DC-TEST');
    expect(errors(mbr)).toEqual([]);
    const b = blocksOf(mbr.procedure);
    for (const t of ['TB-01', 'TB-02', 'TB-06', 'TB-07', 'TB-09', 'TB-10', 'TB-16', 'TB-17', 'TB-19']) expect(b.has(t), t).toBe(true);
    for (const t of ['TB-03', 'TB-04', 'TB-05', 'TB-11', 'TB-18']) expect(b.has(t), t).toBe(false);
    expect(b.get('TB-07')).toHaveLength(2);
    expect((b.get('TB-16')?.[0]?.['layers'] as { stage: string }[]).map((l) => l.stage)).toEqual(['BLEND_L1', 'BLEND_L2']);
    expect(b.get('TB-19')?.[0]?.['method']).toBe('INK');
    expect(mbr.header.product.code).toBe('EXZ-BL-250');
  });

  it('the packaging master defines without errors and packs in aluminium strips: TB-21 STRIP, TB-22, TB-24', () => {
    const mbr = rtdPackagingContent('RTD-ST-TEST');
    expect(errors(mbr)).toEqual([]);
    const b = blocksOf(mbr.procedure);
    expect(b.get('TB-21')?.every((c) => (c['packFormat'] as { form: string }).form === 'STRIP')).toBe(true);
    for (const t of ['TB-22', 'TB-24', 'G-21', 'G-23']) expect(b.has(t), t).toBe(true);
    expect(mbr.header.packType).toBe('ALU-STRIP');
  });
});
