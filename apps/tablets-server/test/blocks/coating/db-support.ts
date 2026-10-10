/**
 * Database support for the coating and finishing blocks (tablets 0910 to 0912): a dc-mini variant whose dispensing
 * preparation runs the coating, printing and inspection blocks in parallel branches.
 */
import type { flow } from '@ebmr/recipe-core';
import { dcMiniVariant } from '../../execution/support.ts';

type Json = Record<string, unknown>;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Finishing step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

/** The use-by of the short-lived coating suspension (an expired one is quick to provoke). */
export const SHORT_USE_BY_SECONDS = '3';
/** The coating parameter log interval of the coating step (a gap is quick to provoke). */
export const LOG_INTERVAL_SECONDS = '1';

export const COATER_ACTUALS = [
  { tag: 'inlet.temp_C', unit: 'degC', min: '50.0', max: '55.0' },
  { tag: 'exhaust.temp_C', unit: 'degC', min: '30.0', max: '35.0' },
  { tag: 'bed.temp_C', unit: 'degC', min: '38.0', max: '44.0' },
  { tag: 'spray.rate_g_min', unit: 'g/min', min: '80.0', max: '160.0' },
  { tag: 'pan.speed_rpm', unit: 'rpm', min: '1.0', max: '5.0' },
];

export const DEFECTS = [
  { code: 'CHIPPED', class: 'MAJOR' },
  { code: 'BLACK-SPOT', class: 'MINOR' },
  { code: 'FOREIGN', class: 'CRITICAL', foreign: true },
];

const gate = (id: string): Json => ({ kind: 'holdPoint', id, name: `Printed tablets approved by QC (${id})`, role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] });

/**
 * dc-mini with the finishing blocks first in its dispensing preparation, each in a branch of one parallel node:
 * cores then loop L-COAT (2 iterations) of p-coat (film coat, max gain 3.5 %, manual fallback, log interval 1 s);
 * p-tb03f (film coat, use-by 3 s), p-tb03c (film coat, use-by 1 h), p-tb03b (binder, use-by 1 h); p-tb19 then gate
 * H-PRINT; p-tb19b then gate H-PRINT-B; p-tb20 then its witnessed destruction step p-destroy; a TB-11 run p-tb11 (never started); a granulation step p-tb04 (time end point, manual fallback).
 */
export function coatingDbMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push({ id: 'SYS-COATER', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-COATER', version: '1' });
    (content['parameters'] as Json[]).push(
      { id: 'coreMean', name: 'Core mean weight', valueType: 'DECIMAL', unit: 'mg', precision: { kind: 'DECIMALS', digits: 6 }, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL' },
      {
        id: 'gain', name: 'Weight gain', valueType: 'DECIMAL', unit: '%', precision: { kind: 'DECIMALS', digits: 4 }, role: 'PROCESS_ENDPOINT', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL',
        limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '2.5', inclusive: true }, high: { value: '3.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' } }] },
      },
    );
    const cores = phaseOf('cores', 'TB-18', {
      part: 'CORES', coatingType: 'FC', coreItem: 'coreMean', sampleSize: '20',
      room: { temperatureMin: '20', temperatureMax: '25', humidityMax: '60' }, loadRange: { min: '40', max: '80', unit: 'kg' },
    }, { records: ['coreMean'] });
    const coat = phaseOf('p-coat', 'TB-18', {
      part: 'COATING', coatingType: 'FC', coreItem: 'coreMean', gainItem: 'gain', sampleSize: '20', targetGain: '3.0', maxGain: '3.5',
      logInterval: { value: LOG_INTERVAL_SECONDS, unit: 's' }, actuals: COATER_ACTUALS, manualFallback: true, maxAgeSeconds: 600,
    }, { records: ['gain'], reads: ['coreMean'], system: { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-COAT', recipeVersion: '1' } });
    const loop = { kind: 'loop', id: 'L-COAT', name: 'Coat until the weight gain is reached', maxIterations: 2, exit: { condition: 'gain >= 3.0 [%]', endpoint: 'gain' }, body: coat };
    const print = (id: string) => phaseOf(id, 'TB-19', { method: 'INK', content: 'C3', sampleSize: '50' });
    const branches = [
      { kind: 'sequence', id: 'seq-coat', children: [cores, loop] },
      phaseOf('p-tb03f', 'TB-03', { solutionType: 'FILM_COAT', solvent: 'PURIFIED_WATER', useBy: { value: SHORT_USE_BY_SECONDS, unit: 's' } }),
      phaseOf('p-tb03c', 'TB-03', { solutionType: 'FILM_COAT', solvent: 'PURIFIED_WATER', useBy: { value: '1', unit: 'h' } }),
      phaseOf('p-tb03b', 'TB-03', { solutionType: 'BINDER', solvent: 'PURIFIED_WATER', useBy: { value: '1', unit: 'h' } }),
      { kind: 'sequence', id: 'seq-print', children: [print('p-tb19'), gate('H-PRINT')] },
      { kind: 'sequence', id: 'seq-print-b', children: [print('p-tb19b'), gate('H-PRINT-B')] },
      {
        kind: 'sequence', id: 'seq-insp', children: [
          phaseOf('p-tb20', 'TB-20', { mode: 'MANUAL_BELT', defects: DEFECTS, aql: { level: 'II', major: '0.65', minor: '2.5' }, destructionStep: 'p-destroy' }),
          phaseOf('p-destroy', 'G-23', {}, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }),
        ],
      },
      // A granulation step on a process device (review 3d finding 1: the G-06 exceptions are required at every such step).
      phaseOf('p-tb04', 'TB-04', {
        granulator: 'HIGH_SHEAR', endPoint: { criterion: 'TIME', minTime: { value: '1', unit: 's' }, maxTime: { value: '60', unit: 'min' } },
        actuals: [{ tag: 'granulator.power_kW', unit: 'kW', min: '1.00', max: '6.00' }], manualFallback: true,
      }, { system: { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-GRAN', recipeVersion: '1' } }),
      // A TB-11 run that is never started: its presence makes tablets 0932's PASS rule apply to the batch.
      phaseOf('p-tb11', 'TB-11', {
        process: 'OTHER', streams: [{ id: 'L' }], plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-IPC-07' }], grace: { value: '5', unit: 'min' },
        sweep: { stations: 3, weight: { individual: { action: { min: '237.5', max: '262.5' } } } },
        weight: { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 20, weighing: 'GROUP', tolerance: { action: '2', alert: '1' } },
      }),
    ];
    const par = { kind: 'parallel', id: 'par-coat', branches: branches.map((b, i) => ({ id: `br-coat-${i + 1}`, name: `Finishing ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}
