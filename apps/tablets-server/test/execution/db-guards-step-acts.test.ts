/**
 * Phase 2 exit review F67 (completeness critic; INV-20, PR-08, PR-30, DI-34; ADR 0012 item 8): an act on a step keeps
 * the minimum durations and the blocks of open exceptions in the database, not only in the engine.
 *
 * Before recipe-core 0308 the database checked a step's END only as bookkeeping (at the row's time, by the step's own
 * act). A writer holding the application role (ebmr_sandbox here) stored, with an engine result computed as if the rule
 * were not there, a SIGN_PERFORMED 0.6 s after the start of a step with a 1 h minimum, and one of a step its open
 * action-limit breach blocks; the invariant query reported nothing. Now both rows are refused (EBMR-EXE-130,
 * EBMR-EXE-131), and the invariant query reports an end before its minimum that landed behind the triggers' back.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { appendAs, messageOf, prepareSignature } from './db-guards-support.ts';
import { dcMiniVariant, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const CLEAR = 'p-disp-clear@';
const TC = 'TC-CLEAR-MIN';

/** dc-mini with a 1 h minimum (and an 8 h maximum) from the clearance's START to its END. */
const withClearanceMinimum = () =>
  dcMiniVariant((prep, content) => {
    (content['timeConstraints'] as Record<string, unknown>[]).push({
      id: TC, name: 'Booth clearance settling time', kind: 'PROCESS_WINDOW',
      from: { node: 'p-disp-clear', event: 'START' }, to: { node: 'p-disp-clear', event: 'END' },
      min: { value: '1', unit: 'h' }, max: { value: '8', unit: 'h' },
      source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' }, breach: 'EXCEPTION', pauses: 'INCLUDED',
    });
    return prep;
  });

/** A clearance run of `withClearanceMinimum` up to its PERFORMED signature (started, both entries recorded). */
async function clearanceReady(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withClearanceMinimum()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
  return d;
}

/**
 * operator1's signed SIGN_PERFORMED of `step` (meaning `meaning`), recorded through the application role with the engine
 * result of `lax` applied to the state (the rule the engine refuses by taken out); the engine's own verdict and the
 * database's answer.
 */
async function forgedPerformed(d: RunDriver, step: string, meaning: string, lax: (def: engine.BatchDefinition, state: engine.BatchState) => { def: engine.BatchDefinition; state: engine.BatchState; restore?: (s: engine.BatchState) => void }): Promise<{ engine: string; database: string }> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_step', `${d.runId}:${step}@`, meaning);
  let verdict = '';
  const database = await messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(who.personId, roles), step, context: [], signature: { id, meaning, signer: who.personId } };
      const honest = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      verdict = honest.accepted ? 'accepted' : (honest.refusal?.code ?? 'refused');
      const l = lax(tx.def, tx.state);
      const r = engine.step(l.def, l.state, command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the forged step: ${JSON.stringify(r.refusal)}`);
      l.restore?.(r.state);
      return appendAs(tx, command, r, roles);
    }),
  );
  return { engine: verdict, database };
}

describe('F67: minimum durations and blocks hold in the database (INV-20, PR-08)', () => {
  it('[INV-20][PR-30] a step signed performed before its minimum duration is refused by the database, not only by the engine', async () => {
    const d = await clearanceReady();
    expect(outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR })).result)).toMatch(/ENG-MIN-DURATION/);
    // The application role records the same signed act with the engine's result on a definition without the minimum.
    const forged = await forgedPerformed(d, 'p-disp-clear', 'LINE_CLEARANCE_PERFORMED', (def, state) => ({
      def: {
        ...def,
        constraints: def.constraints.map((rc) => {
          if (rc.tc.id !== TC) return rc;
          const tc = { ...rc.tc };
          delete tc.min;
          return { ...rc, tc };
        }),
      },
      state,
    }));
    expect(forged.engine).toBe('ENG-MIN-DURATION');
    expect(forged.database).toMatch(/^The end of p-disp-clear@ comes \d+(\.\d+)? s after the start of p-disp-clear, before the minimum of 1 h of Booth clearance settling time: no step starts or completes before its minimum duration \(INV-20, PR-30\)\. \[EBMR-EXE-130\]$/);
    const after = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(after?.steps[CLEAR]?.status).toBe('IN_PROGRESS');
    expect(Object.values(after?.nodeEvents ?? {}).filter((e) => e.node === 'p-disp-clear' && e.event === 'END')).toEqual([]);
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[PR-08][PR-13][INV-20] a step that an open internal-action breach blocks cannot be signed performed through the store', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyParameter()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const key = 'p-early-time@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: key, item: 'blendTime', value: { kind: 'DECIMAL', value: '19', unit: 'min' }, source: { mode: 'MANUAL' } });
    expect(outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: key })).result)).toMatch(/ENG-BLOCKED/);
    const meaning = (await d.signing('operator1', { type: 'SIGN_PERFORMED', stepKey: key })).meaning || 'PERFORMED';
    let breachId = '';
    // The engine's result computed on a state whose breach has no block; the breach is then stored exactly as raised.
    const forged = await forgedPerformed(d, 'p-early-time', meaning, (def, state) => {
      const breach = Object.values(state.exceptions).find((x) => x.type === 'LIMIT_BREACH' && x.status === 'OPEN');
      if (!breach) throw new Error('SETUP: no open LIMIT_BREACH');
      breachId = breach.id;
      const doctored = structuredClone(state);
      const e = doctored.exceptions[breach.id];
      if (e) delete (e as { block?: unknown }).block;
      return { def, state: doctored, restore: (s) => void (s.exceptions[breach.id] = structuredClone(breach)) };
    });
    expect(forged.engine).toBe('ENG-BLOCKED');
    expect(forged.database).toMatch(new RegExp(`^This SIGN_PERFORMED row is refused: step p-early-time@ cannot complete while these exceptions are unresolved: ${breachId} .*\\(needs a linked deviation\\); a blocked step waits for its deviation or QA decision \\(PR-08, PR-13, INV-20\\)\\. \\[EBMR-EXE-131\\]$`));
    const after = (await execution.loadState(sbx.db.admin, runId))?.state;
    expect(after?.steps[key]?.status).toBe('IN_PROGRESS');
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
  }, 300_000);

  it('[INV-20][PR-30] an end before its minimum that landed in the store behind the triggers\' back is reported by the invariant query', async () => {
    const d = await clearanceReady();
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    // A restore or a hand edit puts the clearance's END into the stored state one second after its START.
    const admin = await sbx.db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `update recipe.execution_state
            set state = jsonb_set(state, '{nodeEvents,p-disp-clear|END|}', jsonb_build_object(
                  'node', 'p-disp-clear', 'event', 'END', 'frames', '[]'::jsonb,
                  'at', jsonb_build_object('$u', ((state -> 'nodeEvents' -> 'p-disp-clear|START|' -> 'at' ->> '$u')::bigint + 1000000)::text)))
          where batch_id = $1`,
        [d.runId],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems).toContain('the end of p-disp-clear@ comes 1 s after the start of p-disp-clear, before the minimum of 1 h of Booth clearance settling time (INV-20, PR-30)');
  }, 300_000);
});
