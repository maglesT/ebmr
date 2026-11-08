/**
 * The designer's palette is the Tablets edition's (Phase 7 slice 7j, R4; D-7j-7): every tablet block TB-01 to TB-24 and
 * every generic step block, each with its configuration schema and a default the schema accepts.
 */
import { describe, expect, it } from 'vitest';
import { blocks } from '@ebmr/recipe-core/pure';
import { LIBRARY_REPLACEMENT, paletteBlocks, RETIRED_BADGE } from '../../src/features/designer/palette.ts';
import { librarySeed } from '@ebmr/recipe-core';
import { tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';

describe('the tablets palette (slice 7j)', () => {
  it('offers TB-01 to TB-24 and the generic step blocks, each with its configuration schema', () => {
    const palette = paletteBlocks();
    const types = new Set(palette.map((b) => b.type));
    const missing = Array.from({ length: 24 }, (_, i) => `TB-${String(i + 1).padStart(2, '0')}`).filter((t) => !types.has(t));
    expect(missing, palette.map((b) => b.key).join(' ')).toEqual([]);
    for (const g of ['G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'G-09', 'G-10', 'G-11', 'G-12', 'G-13', 'G-14', 'G-15', 'G-16', 'G-17', 'G-20', 'G-21', 'G-22', 'G-23', 'G-24']) expect(types.has(g), g).toBe(true);
    for (const hidden of ['G-01', 'G-02', 'G-18', 'G-19']) expect(types.has(hidden)).toBe(false);
    for (const b of palette.filter((x) => x.type.startsWith('TB-'))) expect(Object.keys(b.configSchema).length, b.key).toBeGreaterThan(0);
  });

  it('[PR-05][PR-03] decision 0026 O-6: after the library acceptance the tablet blocks are no longer offered for a new step; they stay described for existing masters; every generic step block is still offered', () => {
    const palette = paletteBlocks();
    const tb = palette.filter((b) => b.type.startsWith('TB-'));
    expect(tb.length).toBeGreaterThanOrEqual(24);
    for (const b of tb) {
      expect(b.insertable, b.key).toBe(false);
      expect(b.badge, b.key).toBe(LIBRARY_REPLACEMENT[b.type] ? `existing masters only (use the library's ${LIBRARY_REPLACEMENT[b.type]})` : RETIRED_BADGE);
      expect(Object.keys(b.configSchema).length, b.key).toBeGreaterThan(0);
    }
    for (const b of palette.filter((x) => !x.type.startsWith('TB-'))) expect(b.insertable, b.key).toBe(true);
  });

  it('[PR-05] D-4: the badge of TB-04, TB-05 and TB-18 names the library block that replaces it, and each named block is in the seed catalogue', () => {
    const badges = Object.fromEntries(paletteBlocks().filter((b) => ['TB-04', 'TB-05', 'TB-18'].includes(b.type)).map((b) => [b.type, b.badge]));
    expect(badges).toEqual({
      'TB-04': "existing masters only (use the library's PROC-RMG)",
      'TB-05': "existing masters only (use the library's PROC-FBD)",
      'TB-18': "existing masters only (use the library's COAT- blocks)",
    });
    const codes = librarySeed.SEED_CATALOGUE.map((i) => i.definition.code);
    expect(codes).toEqual(expect.arrayContaining(['PROC-RMG', 'PROC-FBD']));
    expect(codes.some((c) => c.startsWith('COAT-'))).toBe(true);
  });

  it('every palette entry is a block version of the edition registry the definition check and the runs use', () => {
    const registry = tabletsBlockRegistry();
    for (const b of paletteBlocks()) {
      const version = registry.all().find((v) => blocks.blockKey(v.type, v.version) === b.key);
      expect(version, b.key).toBeDefined();
    }
  });
});
