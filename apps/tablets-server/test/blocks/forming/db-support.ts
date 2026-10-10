/**
 * Database support for the forming blocks (tablets 0930 to 0932): a dc-mini variant whose dispensing preparation runs
 * the forming blocks, the TB-09 tooling issue and the TB-10 set-up of the press their runs need, and a TB-02 step that
 * shares a mill screen with TB-06, in parallel branches; the compactor and the press bound in the stage.
 */
import type { flow } from '@ebmr/recipe-core';
import { dcMiniVariant } from '../../execution/support.ts';
import { PRESS_CLASS, SPEC } from '../compression/db-support.ts';

type Json = Record<string, unknown>;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Forming step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

export const COMPACTOR_CLASS = 'EQC-RC-3D';
export const SCREEN = { id: 'RS-15', aperture: { value: '1.5', unit: 'mm' } };

const ribbon = (every: string, grace: string): Json => ({
  every: { value: every, unit: 's' }, grace: { value: grace, unit: 's' }, qrmRef: 'QRM-RC-01',
  thickness: { action: { min: '2.50', max: '3.50' }, alert: { min: '2.70', max: '3.30' } },
});

const tb06 = (id: string, every: string, grace: string): Json =>
  phaseOf(id, 'TB-06', {
    actuals: [{ tag: 'roller.gap_mm', unit: 'mm', min: '2.50', max: '3.50' }], manualFallback: true, maxAgeSeconds: 600,
    ribbon: ribbon(every, grace), screens: [SCREEN], finesRecycle: { maxPercent: '10' }, yield: { min: '95.00', max: '100.00' },
  }, { equipment: [{ ref: 'COMPACTOR', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-RC', recipe: 'RCP-RC', recipeVersion: '2' } });

const LAYER_WEIGHT = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '150.0', n: 10, weighing: 'GROUP', tolerance: { action: '3', alert: '2' } };
const TOTAL_WEIGHT = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '400.0', n: 10, weighing: 'GROUP', tolerance: { action: '2' } };

const tb16 = (id: string, every: string, grace: string): Json =>
  phaseOf(id, 'TB-16', {
    layers: [
      { id: 'L1', stage: 'BLEND_LA', hopper: 'H1', plan: [{ test: 'WEIGHT', every: { value: every, unit: 's' }, qrmRef: 'QRM-BL-01' }], weight: LAYER_WEIGHT },
      {
        id: 'T', stage: 'BLEND_LB', hopper: 'H2',
        plan: [{ test: 'WEIGHT', every: { value: every, unit: 's' }, qrmRef: 'QRM-BL-01' }, { test: 'PHYSICAL', every: { value: every, unit: 's' }, qrmRef: 'QRM-BL-01' }],
        sweep: { stations: 2, weight: { individual: { action: { min: '392.0', max: '408.0' } } } },
        weight: TOTAL_WEIGHT, physical: { n: 2, thickness: { individual: { action: { min: '5.2', max: '5.6' } } }, defects: ['CAPPING', 'LAMINATION'] },
      },
    ],
    grace: { value: grace, unit: 's' },
  }, { equipment: [{ ref: 'PRESS', use: 'USE' }] });

/**
 * dc-mini with, first in its dispensing preparation, one parallel node of: p-tb06 (roller compaction on COMPACTOR, a
 * ribbon check every 30 min), p-tb06m (the same every 2 s with a grace of 1 s: a missed check is quick to provoke),
 * p-tb02 (sifting through the same screen RS-15 on SIFTER), p-tb09i and p-tb10 (the tooling issue and the press set-up
 * and first-off on PRESS), p-tb16 (a bilayer run on PRESS: layer L1 checked alone, the full tablets T, every 15 min) and
 * p-tb16m (the same every 2 s, grace 1 s).
 */
export function formingMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push(
      { id: PRESS_CLASS, kind: 'EQUIPMENT_CLASS', code: PRESS_CLASS, version: '1' },
      { id: COMPACTOR_CLASS, kind: 'EQUIPMENT_CLASS', code: COMPACTOR_CLASS, version: '1' },
      { id: 'EQC-SIFTER', kind: 'EQUIPMENT_CLASS', code: 'EQC-SIFTER', version: '1' },
      { id: 'SYS-RC', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-RC', version: '1' },
    );
    const stage = ((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json);
    ((stage['binding'] as Json)['equipment'] as Json[]).push(
      { ref: 'PRESS', equipmentClass: PRESS_CLASS, kind: 'PROCESS' },
      { ref: 'COMPACTOR', equipmentClass: COMPACTOR_CLASS, kind: 'PROCESS' },
      { ref: 'SIFTER', equipmentClass: 'EQC-SIFTER', kind: 'PROCESS' },
    );
    const bal = prep.find((p) => p['id'] === 'p-disp-bal') as Json;
    (bal['equipment'] as Json[]).push({ ref: 'SIFTER', use: 'STATUS_CHECK' });
    const branches = [
      tb06('p-tb06', '1800', '300'),
      tb06('p-tb06m', '2', '1'),
      phaseOf('p-tb02', 'TB-02', { equipmentClass: 'CO_MILL', screens: [SCREEN] }, { equipment: [{ ref: 'SIFTER', use: 'USE' }] }),
      phaseOf('p-tb09i', 'TB-09', { part: 'ISSUE', specification: SPEC }),
      phaseOf('p-tb10', 'TB-10', { pressClass: 'SINGLE_ROTARY', stations: 2, sides: 'SINGLE', maxAgeSeconds: 600 }, { equipment: [{ ref: 'PRESS', use: 'USE' }] }),
      tb16('p-tb16', '900', '300'),
      tb16('p-tb16m', '2', '1'),
    ];
    const par = { kind: 'parallel', id: 'par-form', branches: branches.map((b, i) => ({ id: `br-form-${i + 1}`, name: `Forming ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}
