/**
 * Phase 7 slice 7u (owner report #20): every entry kind of every Tablets block version has a plain sentence, declared by
 * the block next to its entry schema (BlockVersion.entrySummaries) and built from the entry's stored data and the
 * master's names; the step screens (and the whole batch record view) show it instead of the kind's name.
 */
import { describe, expect, it } from 'vitest';
import { blocks, type engine, type flow } from '@ebmr/recipe-core/pure';
import { tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import { summaryOf } from '../../src/features/execution/views.ts';
import { TB04 } from '../../src/blocks/granulation/index.ts';
import { blockMbr, runGolden } from './granulation/support.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CODE = /\b[A-Z]{2,}_[A-Z0-9_]+\b/;

/** What a sentence never shows: the kind's name, raw JSON, an absent value, an internal id or an upper-case code. */
function problemsOf(kind: string, text: string): string[] {
  const out: string[] = [];
  if (text.trim() === '') out.push('empty');
  if (text.toLowerCase() === kind.toLowerCase().replace(/_/g, ' ')) out.push('the kind name');
  if (/undefined|null|NaN|\[object|[{}"]/.test(text)) out.push('raw value');
  if (UUID.test(text)) out.push('internal id');
  if (CODE.test(text)) out.push(`code ${String(CODE.exec(text)?.[0])}`);
  return out;
}

const mbr = blockMbr(TB04);

describe('entry sentences of the Tablets blocks (owner report #20)', () => {
  it('[DI-40] every entry kind of every block version has its own sentence, never the kind name, raw JSON, an id or a code, for the fixture entries and for an empty entry', () => {
    const missing: string[] = [];
    const bad: string[] = [];
    let kinds = 0;
    for (const b of tabletsBlockRegistry().all()) {
      const key = `${b.type}@${b.version}`;
      const ctx = blocks.summaries.entrySummaryContext(mbr, b.goldenFixture?.phase.config ?? {});
      for (const kind of Object.keys(b.dataSchema?.entries ?? {})) {
        kinds += 1;
        const f = b.entrySummaries?.[kind];
        if (!f) {
          missing.push(`${key} ${kind}`);
          continue;
        }
        const samples = (b.goldenFixture?.script ?? []).flatMap((s) => ('entry' in s && s.entry.kind === kind ? [s.entry] : []));
        for (const data of [{}, ...samples]) {
          const text = f(data, ctx);
          for (const p of problemsOf(kind, text)) bad.push(`${key} ${kind}: ${p} in "${text}"`);
        }
      }
    }
    expect(kinds).toBeGreaterThan(100);
    expect(missing).toEqual([]);
    expect(bad).toEqual([]);
  });

  it('[DI-40] the step screen shows the block\'s sentence from the stored entry: the recipe check and the end point of a granulation run', () => {
    const { run } = runGolden(TB04);
    const step = run.def.steps.get('p');
    const sentences = Object.values(run.state.entries)
      .filter((e) => e.kind === 'RECIPE_CHECK' || e.kind === 'END_POINT')
      .map((e) => summaryOf(e, run.def.mbr, step));
    expect(sentences).toContain('Recipe RCP-GRAN v3 matches');
    expect(sentences.find((s) => s.startsWith('End point by '))).toMatch(/^End point by (time|power|torque): [0-9.]+ \S+, (within|out of) range/);
  });

  it('[DI-40] sentences give the master\'s names and the stored values, never the keys', () => {
    const named: flow.MbrContent = {
      ...mbr,
      parameters: [...mbr.parameters, { ...(mbr.parameters[0] as flow.Parameter), id: 'disp_api', name: 'Dispensed atorvastatin' }],
      references: [...mbr.references, { id: 'MAT-API', kind: 'MATERIAL', code: 'ATV-API', version: '1', title: 'Atorvastatin calcium' }],
      bom: [...mbr.bom, { id: 'BOM-1', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '10', unit: 'kg' } }],
    };
    const of = (type: string, version: string, kind: string, data: Record<string, unknown>, config: Record<string, flow.JsonValue> = {}): string => {
      const b = tabletsBlockRegistry().get(type, version);
      const entry = { id: 'e1', kind, data, stepKey: 'p@', recordedSeq: 1, recordedAt: 0n } as unknown as engine.EntryRecord;
      return summaryOf(entry, named, { block: b, config } as unknown as engine.StepDef);
    };
    expect(of('TB-04', '1', 'END_POINT', { criterion: 'TIME', value: '31.6', unit: 's', withinRange: true })).toBe('End point by time: 31.6 s, within range');
    expect(of('G-06', '1', 'RECIPE_CHECK', { recipe: 'RCP-CF-RTW', recipeVersion: '1', matches: true })).toBe('Recipe RCP-CF-RTW v1 matches');
    expect(of('G-10', '2', 'AREA_OCCUPANCY', { areaCode: 'GRN-RM-02', occupancyId: '0b9c4a7e-3d1f-4f7a-9c1e-2a3b4c5d6e7f' })).toBe('Area GRN-RM-02 occupied by the batch');
    expect(of('G-08', '1', 'CHARGE_LOT', { bomLine: 'BOM-1', container: 'C-7', lot: { id: 'L-22' }, quantity: { value: '2.5', unit: 'kg' } })).toBe(
      'Charged lot L-22 of Atorvastatin calcium (ATV-API): 2.5 kg from container C-7',
    );
    expect(of('TB-21', '1', 'COUNT', { formed: '1000', good: '950', rejects: '20', setupWaste: '20', samples: '10', unexplained: '0' })).toBe(
      'Count: 1000 blisters formed, 950 good, 20 rejected, 20 set-up waste, 10 samples; 0 unexplained',
    );
    expect(of('TB-11', '1', 'DT_END', { stage: 'MAIN', units: [{ disintegrated: true }, { disintegrated: true }], elapsedSeconds: '412', capture: 'DEVICE', result: 'PASS' })).toBe(
      'Disintegration (main stage) ended after 412 s: 2 of 2 units disintegrated: passes',
    );
    expect(of('TB-24', '1', 'PACK_SAMPLE', { purpose: 'RETENTION', packs: '4' })).toBe('4 packs taken for retention');
    // The weighing of a dispensing step names the parameter it counts towards; its kept case on the screen too.
    const weighing = tabletsBlockRegistry().get('G-07', '1')?.entrySummaries?.['CONTAINER_WEIGHING'];
    expect(weighing?.({ item: 'disp_api', bomLine: 'BOM-1', container: 'C-1', lot: { id: 'L-1' }, gross: '10.5', tare: '0.5', net: '10.0', unit: 'kg', balance: 'BAL-3', source: 'MANUAL' }, blocks.summaries.entrySummaryContext(named))).toBe(
      'Dispensed atorvastatin: container C-1, lot L-1, net 10.0 kg (gross 10.5 kg, tare 0.5 kg) on BAL-3, keyed by hand',
    );
    // A key the master does not name is never shown.
    expect(of('G-08', '1', 'CHARGE_LOT', { bomLine: 'BOM-UNKNOWN', container: 'C-7', lot: { id: 'L-22' } })).toBe('Charged lot L-22 of an item the master does not name from container C-7');
  });
});
