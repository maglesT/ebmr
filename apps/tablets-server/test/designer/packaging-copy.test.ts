/**
 * Phase 7 slice 7o (R4, R8; D-7o-3): a packaging master for a company's own product as a copy of an approved packaging
 * master of another product: the pack is the source's, the header names the new product, and every printed item takes
 * the product's own printed material and artwork version wherever the source named the old one; a printed item left with
 * another product's print is refused. The copy defines without errors.
 */
import { describe, expect, it } from 'vitest';
import { rtwPackagingContent } from '../../src/cli/demo-route-masters.ts';
import { definitionFindings } from '../../src/features/designer/definition.ts';
import { FamilyInputError } from '../../src/features/designer/family.ts';
import type { MaterialMaster } from '../../src/features/designer/material-refs.ts';
import { packagingCopy, printedItems } from '../../src/features/designer/packaging-copy.ts';

const SOURCE = rtwPackagingContent('RTW-CF-TEST');
const MATERIALS: MaterialMaster[] = [
  { versionId: '11111111-2222-4333-8444-555555555551', code: 'DMT-FOIL-1', name: 'Printed lidding foil, Demotab', kind: 'PRINTED_PACKAGING', unit: '1' },
  { versionId: '11111111-2222-4333-8444-555555555552', code: 'DMT-CTN-1', name: 'Printed carton, Demotab', kind: 'PRINTED_PACKAGING', unit: '1' },
  { versionId: '11111111-2222-4333-8444-555555555553', code: 'DMT-API-1', name: 'Demotab active', kind: 'API', unit: 'kg' },
];
const REQUEST = {
  familyCode: 'DMT-CF-1',
  markets: ['IN'],
  product: { code: 'DMT400-T', strength: '400 mg', name: 'Demotab 400 mg, wet granulation, film coated, alu-alu', dosageForm: 'Film-coated tablet' },
  printed: [
    { item: 'FOIL', material: 'DMT-FOIL-1', artwork: 'ART-DMT-FOIL-1' },
    { item: 'CARTON', material: 'DMT-CTN-1', artwork: 'ART-DMT-CTN-1' },
  ],
};

describe('a packaging master copied for another product (slice 7o, D-7o-3)', () => {
  it('[PR-32][IN-38][PR-01] the copy names the new product, carries its own printed materials and artworks for its markets everywhere the source named the old ones, and defines without errors', () => {
    expect(printedItems(SOURCE).map((i) => i.item)).toEqual(['FOIL', 'CARTON']);
    const c = packagingCopy(SOURCE, REQUEST, MATERIALS);
    expect([c.header.family, c.header.product.code, c.header.product.strength, c.header.recordKind, c.header.packType, c.header.marketSet]).toEqual(['DMT-CF-1', 'DMT400-T', '400 mg', 'PACKAGING', 'ALU-ALU-BLISTER', ['IN']]);
    expect(c.header.batchSizes).toEqual(SOURCE.header.batchSizes);
    const text = JSON.stringify(c.procedure);
    for (const old of printedItems(SOURCE).map((i) => i.material)) expect(text, old).not.toContain(`"${old}"`);
    expect(printedItems(c)).toEqual([{ item: 'FOIL', material: 'DMT-FOIL-1' }, { item: 'CARTON', material: 'DMT-CTN-1' }]);
    expect(text).toContain('"artwork":{"IN":"ART-DMT-FOIL-1"}');
    // The TB-21 lidding web is the new foil; the forming laminate (unprinted) stays the source's.
    expect(text).toContain('"role":"LIDDING_FOIL","material":"DMT-FOIL-1"');
    expect(c.bom).toEqual(SOURCE.bom);
    expect(c.references.filter((r) => r.kind === 'MATERIAL').map((r) => r.id).sort()).toEqual(['DMT-CTN-1', 'DMT-FOIL-1', SOURCE.bom[0]?.material ?? ''].sort());
    expect(definitionFindings(c).filter((f) => f.severity === 'ERROR')).toEqual([]);
  });

  it('[PR-43][PR-32] the copy\'s printed-materials step states the new product\'s shelf life from its product master, not the source product\'s (D-7r-2)', () => {
    const g21 = (c: typeof SOURCE): unknown[] => {
      const out: unknown[] = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n !== null && typeof n === 'object') {
          const o = n as Record<string, unknown>;
          if (o['kind'] === 'phase' && (o['block'] as Record<string, unknown> | undefined)?.['type'] === 'G-21') out.push((o['config'] as Record<string, unknown>)['shelfLifeMonths']);
          Object.values(o).forEach(walk);
        }
      };
      walk(c.procedure);
      return out;
    };
    expect(g21(SOURCE)).toEqual([24]);
    expect(g21(packagingCopy(SOURCE, { ...REQUEST, product: { ...REQUEST.product, shelfLifeMonths: '36' } }, MATERIALS))).toEqual([36]);
    // Without the product master's shelf life the copy keeps the step as it was (the GMP batch data refuses a mismatch).
    expect(g21(packagingCopy(SOURCE, REQUEST, MATERIALS))).toEqual([24]);
    expect(() => packagingCopy(SOURCE, { ...REQUEST, product: { ...REQUEST.product, shelfLifeMonths: '2.5' } }, MATERIALS)).toThrow(/not a whole number of months/);
  });

  it('[PR-32][IN-38] refused: a printed item left with another product\'s print, a material that is not printed packaging, a processing master, the same product', () => {
    expect(() => packagingCopy(SOURCE, { ...REQUEST, printed: REQUEST.printed.slice(0, 1) }, MATERIALS)).toThrow(/CARTON: a pack never carries another product's print/);
    expect(() => packagingCopy(SOURCE, { ...REQUEST, printed: [REQUEST.printed[0], { item: 'CARTON', material: 'DMT-API-1', artwork: 'ART-X' }] as typeof REQUEST.printed }, MATERIALS)).toThrow(/not printed packaging/);
    expect(() => packagingCopy(SOURCE, { ...REQUEST, printed: [...REQUEST.printed, { item: 'LEAFLET', material: 'DMT-CTN-1', artwork: 'ART-X' }] }, MATERIALS)).toThrow(/no printed item LEAFLET/);
    expect(() => packagingCopy(SOURCE, { ...REQUEST, product: { ...REQUEST.product, code: SOURCE.header.product.code, strength: SOURCE.header.product.strength } }, MATERIALS)).toThrow(FamilyInputError);
    // P7O-1: the source's own foil or carton (or the other item's) is another product's print, whatever the artwork.
    const [foil, carton] = printedItems(SOURCE);
    const withSourceMaterials: MaterialMaster[] = [
      ...MATERIALS,
      ...[foil, carton].map((i, n) => ({ versionId: `11111111-2222-4333-8444-55555555556${n}`, code: i?.material ?? '', name: `Source ${i?.item ?? ''}`, kind: 'PRINTED_PACKAGING' as const, unit: '1' })),
    ];
    expect(() => packagingCopy(SOURCE, { ...REQUEST, printed: [{ item: 'FOIL', material: foil?.material ?? '', artwork: 'ART-X' }, REQUEST.printed[1]] as typeof REQUEST.printed }, withSourceMaterials)).toThrow(/is the source's own printed material/);
    expect(() => packagingCopy(SOURCE, { ...REQUEST, printed: [REQUEST.printed[0], { item: 'CARTON', material: carton?.material ?? '', artwork: 'ART-X' }] as typeof REQUEST.printed }, withSourceMaterials)).toThrow(/is the source's own printed material/);
    expect(() => packagingCopy(SOURCE, { ...REQUEST, printed: [{ item: 'FOIL', material: carton?.material ?? '', artwork: 'ART-X' }, { item: 'CARTON', material: foil?.material ?? '', artwork: 'ART-Y' }] }, withSourceMaterials)).toThrow(/another product's print/);
    const processing = { ...SOURCE, header: { ...SOURCE.header, recordKind: 'PROCESSING' as const } };
    expect(() => packagingCopy(processing, REQUEST, MATERIALS)).toThrow(/approved packaging master/);
  });
});
