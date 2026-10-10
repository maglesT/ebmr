/**
 * Database support for the compression blocks (tablets 0870 to 0874): a dc-mini variant whose dispensing preparation
 * runs the compression blocks in parallel branches, with the press bound in the stage.
 */
import type { flow } from '@ebmr/recipe-core';
import { dcMiniVariant } from '../../execution/support.ts';

type Json = Record<string, unknown>;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Compression step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

/** The class of the press the stage binds (its reference code is the plant class code). */
export const PRESS_CLASS = 'EQC-PRESS-3C';
export const SPEC = { type: 'B', shape: 'Round 8 mm biconvex', upperEmbossing: 'C3', lowerEmbossing: 'PLAIN', score: 'NONE' };
export const PIECES = [
  { kind: 'FERROUS', size: { value: '0.8', unit: 'mm' } },
  { kind: 'STAINLESS', size: { value: '1.2', unit: 'mm' } },
];

/**
 * dc-mini with the compression blocks first in its dispensing preparation, each in a branch of one parallel node:
 * p-tb09i (tooling issue, specification SPEC), p-tb10 (press set-up on PRESS, a main-force range 10 to 15 kN),
 * p-tb17 (metal detector MD-01 with PIECES, interval 120 min, de-duster DD-01), p-tb09r (tooling return), and p-watch
 * (a G-06 step with a stale age of 1 s, for the interface-loss job).
 */
export function compressionMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push({ id: PRESS_CLASS, kind: 'EQUIPMENT_CLASS', code: PRESS_CLASS, version: '1' });
    const stage = ((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json);
    ((stage['binding'] as Json)['equipment'] as Json[]).push({ ref: 'PRESS', equipmentClass: PRESS_CLASS, kind: 'PROCESS' });
    const branches = [
      phaseOf('p-tb09i', 'TB-09', { part: 'ISSUE', specification: SPEC }),
      phaseOf('p-tb10', 'TB-10', {
        pressClass: 'SINGLE_ROTARY', stations: 27, sides: 'SINGLE', maxAgeSeconds: 600,
        settingRanges: [{ tag: 'force.main_kN', unit: 'kN', min: '10.0', max: '15.0' }],
      }, { equipment: [{ ref: 'PRESS', use: 'USE' }] }),
      phaseOf('p-tb17', 'TB-17', { metalDetector: { device: 'MD-01', intervalMinutes: 120, pieces: PIECES }, deDuster: 'DD-01' }),
      phaseOf('p-tb09r', 'TB-09', { part: 'RETURN' }),
      phaseOf('p-watch', 'G-06', { maxAgeSeconds: 1 }),
    ];
    const par = { kind: 'parallel', id: 'par-comp', branches: branches.map((b, i) => ({ id: `br-comp-${i + 1}`, name: `Compression ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}
