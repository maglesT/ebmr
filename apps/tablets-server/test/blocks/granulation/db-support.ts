/**
 * Database support for the granulation blocks (tablets 0850, 0851): a dc-mini variant whose dispensing preparation
 * runs the five granulation blocks in parallel branches, and writers that record an entry past the server (ExecutionTx
 * and the store, as the application role), honestly or with a tampered block handler, so the database alone decides.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { vi } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import type { engine} from '@ebmr/recipe-core';
import { execution, type flow } from '@ebmr/recipe-core';
import { actorOfBrowser } from '../../esig/support.ts';
import { engineActor, engineRoles } from '../../../src/features/execution/roles.ts';
import { runContext } from '../../../src/features/execution/runs.ts';
import { appendAs, codeOf, engineResult, messageOf } from '../../execution/db-guards-support.ts';
import { dcMiniVariant, personaIn, type ExecServer, type RunDriver } from '../../execution/support.ts';

type Json = Record<string, unknown>;
export type Entry = Json & { kind: string };

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Granulation step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

const param = (id: string, name: string, unit: string, extra: Json = {}): Json => ({
  id, name, valueType: 'DECIMAL', unit, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', ...extra,
});

/** The use-by of the binder solution in the database tests (short: an expired solution is quick to provoke). */
export const USE_BY_SECONDS = '3';

/**
 * dc-mini with the granulation blocks first in its dispensing preparation, each in a branch of one parallel node:
 * p-tb02 (sifter SIFTER, screen SCR-40), p-tb03 (binder, use-by 3 s), p-tb04 (time end point, binder 1 to 5 kg),
 * p-tb04g (power end point on the granulator's G-06 value), p-tb05 (fluid bed, in loop L-DRY of 2 iterations),
 * p-tb07 (blend 1 s to 60 min, lubrication, two BU locations, blend time computed into blendSecs).
 */
export function granulationMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push(
      { id: 'SYS-RMG', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-RMG', version: '1' },
      { id: 'EQC-SIFTER', kind: 'EQUIPMENT_CLASS', code: 'EQC-SIFTER', version: '1' },
    );
    const stage = ((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json);
    ((stage['binding'] as Json)['equipment'] as Json[]).push({ ref: 'SIFTER', equipmentClass: 'EQC-SIFTER', kind: 'PROCESS' });
    (content['parameters'] as Json[]).push(
      param('lodDry', 'LOD of the granules', '%', {
        semanticTag: 'lod', precision: { kind: 'DECIMALS', digits: 1 }, role: 'PROCESS_ENDPOINT',
        limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '2.0', inclusive: true }, high: { value: '3.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' } }] },
      }),
      param('blendSecs', 'Main blend time', 's', {
        limits: { unit: 's', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '1', inclusive: true }, high: { value: '3600', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' } }] },
      }),
    );
    const bal = prep.find((p) => p['id'] === 'p-disp-bal') as Json;
    (bal['equipment'] as Json[]).push({ ref: 'SIFTER', use: 'STATUS_CHECK' });
    const branches = [
      phaseOf('p-tb02', 'TB-02', { equipmentClass: 'VIBRO_SIFTER', screens: [{ id: 'SCR-40', aperture: { value: '425', unit: 'um' } }] }, { equipment: [{ ref: 'SIFTER', use: 'USE' }] }),
      phaseOf('p-tb03', 'TB-03', { solutionType: 'BINDER', solvent: 'PURIFIED_WATER', useBy: { value: USE_BY_SECONDS, unit: 's' } }),
      phaseOf('p-tb04', 'TB-04', {
        granulator: 'HIGH_SHEAR', endPoint: { criterion: 'TIME', minTime: { value: '1', unit: 's' }, maxTime: { value: '60', unit: 'min' } }, binder: { min: '1.000', max: '5.000', unit: 'kg' },
      }),
      phaseOf('p-tb04g', 'TB-04', {
        granulator: 'HIGH_SHEAR', actuals: [{ tag: 'granulator.power_kW', unit: 'kW', min: '1.00', max: '6.00' }], maxAgeSeconds: 600,
        endPoint: { criterion: 'POWER', tag: 'granulator.power_kW', min: '3.80', max: '4.60' },
      }, { system: { kind: 'PLC', ref: 'SYS-RMG', recipe: 'RCP-GRAN', recipeVersion: '3' } }),
      {
        kind: 'loop', id: 'L-DRY', name: 'Dry until the LOD is in range', maxIterations: 2, exit: { condition: 'lodDry >= 2.0 [%] && lodDry <= 3.5 [%]', endpoint: 'lodDry' },
        body: phaseOf('p-tb05', 'TB-05', { dryer: 'FBD', lodItem: 'lodDry' }, { records: ['lodDry'] }),
      },
      phaseOf('p-tb07', 'TB-07', {
        blendTime: { min: { value: '1', unit: 's' }, max: { value: '60', unit: 'min' }, item: 'blendSecs' }, lubrication: { min: { value: '1', unit: 's' }, max: { value: '30', unit: 'min' } },
        bu: { locations: ['L1', 'L2'], replicates: 1, unitDose: { value: '250', unit: 'mg' } },
      }, { records: ['blendSecs'] }),
    ];
    const par = { kind: 'parallel', id: 'par-gran', branches: branches.map((b, i) => ({ id: `br-gran-${i + 1}`, name: `Granulation ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}

/** A copy of the run's definition with one block handler overridden (the tampered engine of a bypass attempt). */
export type Tamper = (def: engine.BatchDefinition) => engine.BatchDefinition;

/** Step `step` with its block's handler members replaced by `handler` (the cached definition itself is left as it is). */
export function tamperHandler(step: string, handler: Partial<NonNullable<NonNullable<engine.StepDef['block']>['handler']>>): Tamper {
  return (def) => {
    const s = def.steps.get(step);
    if (!s?.block) throw new Error(`SETUP: no block step ${step}`);
    const steps = new Map(def.steps);
    steps.set(step, { ...s, block: { ...s.block, handler: { ...s.block.handler, ...handler } } });
    return { ...def, steps };
  };
}

/** Step `step` accepting any entry and storing `data` (a forged engine). */
export function laxEntry(step: string, data: Json, opts: { verificationRequired?: boolean } = {}): Tamper {
  return tamperHandler(step, { acceptEntry: () => ({ ok: true, data, ...(opts.verificationRequired ? { verificationRequired: true } : {}) }) });
}

export interface Recorder {
  (step: string, entry: Entry, opts?: { frames?: flow.Frame[]; tamper?: Tamper; before?: (c: PoolClient) => Promise<void>; persona?: string }): Promise<string>;
}

/** Records `entry` at `step` past the server as `persona` (operator1), honestly or through a tampered definition. */
export function recorder(sbx: ExecServer, d: RunDriver, advance: () => void): { record: Recorder; message: Recorder } {
  const write = async (step: string, entry: Entry, opts: Parameters<Recorder>[2] = {}) => {
    const persona = opts.persona ?? 'operator1';
    advance();
    const actor: ActorContext = await actorOfBrowser(sbx, d.browser(persona), persona);
    const run = await runContext(sbx.db.admin, d.runId);
    const def = opts.tamper ? opts.tamper(run.def) : run.def;
    const me = personaIn(sbx, persona);
    return withCommand(sbx.db.app, actor, async (c) => {
      if (opts.before) await opts.before(c);
      const tx = await execution.ExecutionTx.open(c, def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(me.personId, roles), step, context: opts.frames ?? [], entry };
      return appendAs(tx, command, engineResult(tx, command), roles);
    });
  };
  return {
    record: (step, entry, opts) => codeOf(write(step, entry, opts)),
    message: (step, entry, opts) => messageOf(write(step, entry, opts)),
  };
}

/** The run's state as stored (admin read). */
export async function stateOf(sbx: ExecServer, runId: string): Promise<Json & { entries: Record<string, Json>; steps: Record<string, Json>; exceptions: Record<string, Json>; points: Record<string, Json> }> {
  const { rows } = await sbx.db.admin.query<{ state: never }>('select state from recipe.execution_state where batch_id = $1', [runId]);
  return rows[0]?.state as never;
}

/** The id of the last entry of `kind` at step instance `stepKey`. */
export async function lastEntry(sbx: ExecServer, runId: string, stepKey: string, kind: string): Promise<string> {
  const s = await stateOf(sbx, runId);
  const e = Object.values(s.entries).filter((x) => x['stepKey'] === stepKey && x['kind'] === kind).sort((a, b) => Number(a['recordedSeq']) - Number(b['recordedSeq'])).at(-1);
  if (!e) throw new Error(`SETUP: no ${kind} entry at ${stepKey}`);
  return String(e['id']);
}

export const fakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ['performance'] });
};
