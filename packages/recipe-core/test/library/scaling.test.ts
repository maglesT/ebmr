/**
 * Batch generation with scaling (decision 0026, slice S10; owner decision O-8): a master lists its approved batch sizes
 * and its BOM is written for the reference size, the first listed. A library calculation reads the formula line scaled
 * exactly to the batch's issued size, and the batch size itself; a size the master does not list is refused at issue
 * (IN-13: no free scaling). The definitions are the master's pinned snapshot, so issuing at another size changes
 * nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { batchSizeOf, libraryBlockType, libraryBlockVersion, scaledInputs, scaledLine, type BlockDefinition } from '../../src/library/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';

const SIZES: MbrContent['header']['batchSizes'] = [
  { id: 'BS-100', quantity: { value: '100', unit: 'kg' } },
  { id: 'BS-250', quantity: { value: '250', unit: 'kg' } },
  { id: 'BS-HALF-T', quantity: { value: '50000', unit: 'g' } },
];
const BOM: MbrContent['bom'] = [{ id: 'BOM-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '12.5', unit: 'kg' } }];

const def: BlockDefinition = {
  code: 'PROC-SCALE-CHECK',
  version: 1,
  title: 'Charge the active',
  category: 'PROCESS',
  inputs: [
    { id: 'line', label: 'Formula quantity', kind: 'FORMULA_LINE', unit: 'g', slot: 'activeLine' },
    { id: 'size', label: 'Batch size', kind: 'BATCH_SIZE', unit: 'kg' },
  ],
  sections: [
    {
      id: 'charge',
      title: 'Charge',
      fields: [
        { id: 'target', label: 'Quantity to charge', type: 'CALC', expression: 'line', unit: 'kg' },
        { id: 'share', label: 'Share of the batch', type: 'CALC', expression: 'line / size * 100 [%]', unit: '%' },
        { id: 'done', label: 'Charged', type: 'YES_NO', expected: true },
      ],
    },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'OPERATOR' }],
};
const config = { bomLines: { activeLine: 'BOM-API' } };

function issuedAt(size: string): Run {
  const p = phase('p', { block: { type: libraryBlockType(def.code), version: '1' }, config });
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, { bom: BOM });
  const withSizes: MbrContent = { ...mbr, header: { ...mbr.header, batchSizes: SIZES } };
  const d = define(withSizes, { registry: testRegistry().extend(libraryBlockVersion(def, expr)) });
  const run = Run.issue(d, { batchSize: size }, T0);
  run.start('p');
  return run;
}

function computed(run: Run): Record<string, string> {
  const e = Object.values(run.state.entries).find((x) => x.kind === 'charge');
  return Object.fromEntries(Object.entries((e?.data['computed'] ?? {}) as Record<string, { value: string }>).map(([k, v]) => [k, v.value]));
}

describe('batch generation with scaling', () => {
  const mbr = { header: { batchSizes: SIZES }, bom: BOM } as unknown as MbrContent;

  it('[PR-01][IN-13] the formula line scales exactly from the reference size (the first listed) to the batch size', () => {
    expect(scaledLine(mbr, 'BOM-API', 'BS-100', expr)).toEqual({ value: '12.5', unit: 'kg' });
    expect(scaledLine(mbr, 'BOM-API', 'BS-250', expr)).toEqual({ value: '31.25', unit: 'kg' });
    // a size in another unit is converted to the reference unit first: 50000 g = 50 kg
    expect(scaledLine(mbr, 'BOM-API', 'BS-HALF-T', expr)).toEqual({ value: '6.25', unit: 'kg' });
    expect(scaledLine(mbr, 'BOM-API', 'BS-999', expr)).toBeUndefined();
    expect(scaledLine(mbr, 'BOM-NONE', 'BS-100', expr)).toBeUndefined();
    expect(batchSizeOf(mbr, 'BS-250')).toEqual({ value: '250', unit: 'kg' });
  });

  it('[PR-01] the inputs are given in the unit the definition declares', () => {
    expect(scaledInputs(def, config, mbr, 'BS-250', expr)).toEqual({ line: { value: '31250', unit: 'g' }, size: { value: '250', unit: 'kg' } });
    expect(scaledInputs(def, {}, mbr, 'BS-250', expr)).toEqual({ size: { value: '250', unit: 'kg' } });
  });

  it('[PR-01][IN-13][DI-33] one approved master runs each listed size, and the calculation reads the quantity scaled to the issued size', () => {
    for (const [size, target] of [['BS-100', '12.5'], ['BS-250', '31.25'], ['BS-HALF-T', '6.25']] as const) {
      const run = issuedAt(size);
      run.entry('p', { kind: 'charge', done: true });
      const c = computed(run);
      expect(Number.parseFloat(c['target'] ?? 'NaN') === Number.parseFloat(target), `${size}: ${String(c['target'])}`).toBe(true);
      expect(c['share']?.startsWith('12.5'), `${size}: ${String(c['share'])}`).toBe(true);
    }
  });

  it('[IN-13] a size the master does not list is refused at issue: no free scaling', () => {
    expect(() => issuedAt('BS-300')).toThrow();
  });
});
