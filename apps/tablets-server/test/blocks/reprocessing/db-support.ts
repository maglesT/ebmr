/**
 * Database support for the reprocessing and recovery blocks (Phase 3 slice 5b; recipe-core 0620 to 0622, tablets 1020,
 * 1021): a dc-mini variant whose dispensing preparation runs, in parallel branches, an inspection step that keeps
 * reusable residue (TB-20 with its witnessed destruction step), TB-08 addition steps of both cases and a G-24@2
 * recovery step; and writers that record a start or an entry past the server as the application role, honestly or
 * through a tampered block handler, so the database alone decides.
 */
import { randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { actorOfBrowser } from '../../esig/support.ts';
import { engineActor, engineRoles } from '../../../src/features/execution/roles.ts';
import { runContext } from '../../../src/features/execution/runs.ts';
import { appendAs, codeOf } from '../../execution/db-guards-support.ts';
import { dcMiniVariant, personaIn, type ExecServer, type RunDriver } from '../../execution/support.ts';
import type { Tamper } from '../granulation/db-support.ts';

type Json = Record<string, unknown>;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, version: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Step ${id}`, block: { type, version }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

export const DEFECTS = [
  { code: 'CHIPPED', class: 'MAJOR' },
  { code: 'BLACK-SPOT', class: 'MINOR' },
  { code: 'FOREIGN', class: 'CRITICAL', foreign: true },
];

/** The age limit of the step that is quickly too old (p-tb08-old). */
export const SHORT_AGE_SECONDS = '2';

/**
 * dc-mini (standard batch 60.000 kg) with, in parallel branches of its dispensing preparation: p-tb20 (manual belt,
 * reusable residue kept) then its witnessed destruction step p-destroy; p-tb08 (reprocessing addition, at most 3 % =
 * 1.8 kg, 90 days from generation, 2 source batches, computing reworkAdded); p-tb08-r (recovery, 3 %, 90 days from
 * manufacture, 1 source batch); p-tb08-old (reprocessing addition, at most 2 s old); p-g24 (G-24@2 recovery).
 */
export function reprocessingDbMbr(product?: { code: string; strength: string }): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    if (product) Object.assign(((content['header'] as Json)['product'] as Json), product);
    (content['parameters'] as Json[]).push({
      id: 'reworkAdded', name: 'Rework added', valueType: 'DECIMAL', unit: 'kg', role: 'PROCESS_PARAMETER', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'AUTOMATION',
    });
    const addition = (c: string, maxAge: Json, maxSourceBatches: number) => ({ case: c, maxPercent: '3', maxAge, maxSourceBatches });
    const branches = [
      {
        kind: 'sequence', id: 'seq-insp', children: [
          phaseOf('p-tb20', 'TB-20', '1', { mode: 'MANUAL_BELT', defects: DEFECTS, aql: { level: 'II', major: '0.65', minor: '2.5' }, reusableResidue: true, destructionStep: 'p-destroy' }),
          phaseOf('p-destroy', 'G-23', '1', {}, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }),
        ],
      },
      phaseOf('p-tb08', 'TB-08', '1', { ageFrom: 'GENERATION', sourceStages: ['INSPECTION', 'COMPRESSION'], addedItem: 'reworkAdded' }, {
        records: ['reworkAdded'], reprocessing: addition('REPROCESSING_ADDITION', { value: '90', unit: 'd' }, 2),
      }),
      phaseOf('p-tb08-r', 'TB-08', '1', { ageFrom: 'MANUFACTURE' }, { reprocessing: addition('RECOVERY', { value: '90', unit: 'd' }, 1) }),
      phaseOf('p-tb08-old', 'TB-08', '1', { ageFrom: 'GENERATION' }, { reprocessing: addition('REPROCESSING_ADDITION', { value: SHORT_AGE_SECONDS, unit: 's' }, 2) }),
      phaseOf('p-g24', 'G-24', '2', {}, { reprocessing: addition('RECOVERY', { value: '90', unit: 'd' }, 2) }),
    ];
    const par = { kind: 'parallel', id: 'par-rpr', branches: branches.map((b, i) => ({ id: `br-rpr-${i + 1}`, name: `Reprocessing ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}

export interface Writer {
  (persona: string, command: (actor: engine.Actor) => engine.Command, opts?: { tamper?: Tamper }): Promise<string>;
}

/** Records a command past the server as `persona` on run `d` (the engine result of the possibly tampered definition). */
export function writer(sbx: ExecServer, d: RunDriver, advance: () => void): { code: Writer; message: Writer } {
  const write = async (persona: string, command: (actor: engine.Actor) => engine.Command, opts: { tamper?: Tamper } = {}) => {
    advance();
    const actor: ActorContext = await actorOfBrowser(sbx, d.browser(persona), persona);
    const run = await runContext(sbx.db.admin, d.runId);
    const def = opts.tamper ? opts.tamper(run.def) : run.def;
    const me = personaIn(sbx, persona);
    return withCommand(sbx.db.app, actor, async (c) => {
      const tx = await execution.ExecutionTx.open(c, def, d.runId);
      const roles = await engineRoles(c);
      const cmd = command(engineActor(me.personId, roles));
      const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`ENGINE ${r.refusal?.code ?? "?"}`);
      return appendAs(tx, cmd, r, roles);
    });
  };
  return {
    code: (p, c, o) => codeOf(write(p, c, o)),
    message: (p, c, o) => write(p, c, o).then(() => 'ok'),
  };
}

export const entryCommand =
  (step: string, entry: Json & { kind: string }) =>
  (actor: engine.Actor): engine.Command => ({ type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step, context: [], entry });

export const startCommand =
  (step: string, blockData?: Json) =>
  (actor: engine.Actor): engine.Command => ({ type: 'START_STEP', commandId: randomUUID(), actor, step, context: [], ...(blockData ? { blockData } : {}) });
