/**
 * Phase 2 exit review F67 (completeness critic; INV-20, PR-08, PR-30, DI-34; ADR 0012 item 8): an act on a step keeps
 * the minimum durations and the blocks of open exceptions in the database, not only in the engine.
 *
 * Before recipe-core 0308 the database checked a step's END only as bookkeeping (at the row's time, by the step's own
 * act). A writer holding the application role (ebmr_sandbox here) stored, with an engine result computed as if the rule
 * were not there, a SIGN_PERFORMED 0.6 s after the start of a step with a 1 h minimum, and one of a step its open
 * action-limit breach blocks; the invariant query reported nothing. Now both rows are refused (EBMR-EXE-130,
 * EBMR-EXE-131), and the invariant query reports an end before its minimum that landed behind the triggers' back.
 *
 * Round 2 (recipe-core 0312): 0308 measures from the node events the row's state holds, and nothing required the act to
 * record its own. A START_STEP whose state left out the START (V1), and a SIGN_PERFORMED whose state left out the END
 * (V2), were stored and the minimum was never measured. Now each act records the start or end it makes, and the token's
 * arrival the starts of the constructs it enters (EBMR-EXE-133).
 *
 * Round 3 (recipe-core 0316): the END of a construct was required only when a later step arrived, and not for one in
 * an alternative's branch, a loop iteration or a sub-lot. A SIGN_PERFORMED that finished operation O-ALT, in the branch
 * an issue variant chose, was stored without O-ALT's END and the minimum from its START to its END was never measured.
 * Now the row that finishes what a construct holds records its END, so the minimum is measured.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, flow } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf, prepareSignature } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

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

type Json = Record<string, unknown>;

/**
 * dc-mini with an alternative at the start of the dispensing stage, chosen by the issue variant `booth` (the round-3
 * verification's probe): branch A is operation O-ALT holding an SOP read (p-alt-sop), branch B is empty; and a 1 h
 * minimum (8 h maximum) from the START of O-ALT to its END.
 */
function withBoothAlternative(): flow.MbrContent {
  const content = JSON.parse(JSON.stringify(dcMini())) as Json;
  const stageSeq = ((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stageSeq['children'] as Json[])[0] as Json)['body'] as Json;
  const sop = (prep['children'] as Json[]).find((x) => x['id'] === 'p-disp-sop');
  if (!sop) throw new Error('SETUP: dc-mini has no SOP read');
  const altSop = { ...structuredClone(sop), id: 'p-alt-sop', name: 'Read the booth A SOP' };
  stageSeq['children'] = [
    {
      kind: 'alternative', id: 'alt-booth', decision: { mode: 'ISSUE_VARIANT', variant: 'booth' },
      branches: [
        { id: 'A', name: 'Booth A', variantValues: ['A'], body: { kind: 'operation', id: 'O-ALT', name: 'Booth A preparation', body: { kind: 'sequence', id: 'O-ALT-seq', children: [altSop] } } },
        { id: 'B', name: 'Booth B', variantValues: ['B'] },
      ],
    },
    ...(stageSeq['children'] as Json[]),
  ];
  ((content['header'] as Json)['variants'] as Json[]).push({ id: 'booth', values: ['A', 'B'] });
  (content['timeConstraints'] as Json[]).push({
    id: 'TC-ALT-MIN', name: 'Booth A settling time', kind: 'PROCESS_WINDOW',
    from: { node: 'O-ALT', event: 'START' }, to: { node: 'O-ALT', event: 'END' },
    min: { value: '1', unit: 'h' }, max: { value: '8', unit: 'h' },
    source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' }, breach: 'EXCEPTION', pauses: 'INCLUDED',
  });
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`the booth variant does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
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

  it('[INV-20][PR-30][DI-27] a PERFORMED signature whose state leaves out the END it makes is refused, so the minimum is measured (round 2, V2)', async () => {
    const d = await clearanceReady();
    // The engine result of a definition without the minimum, with the clearance's END taken out of the stored state.
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
      restore: (s) => void delete s.nodeEvents['p-disp-clear|END|'],
    }));
    expect(forged.engine).toBe('ENG-MIN-DURATION');
    expect(forged.database).toMatch(/^This accepted SIGN_PERFORMED row ends phase p-disp-clear@ but records no END event of it \(p-disp-clear\|END\|\): .*\(DI-27, INV-20, DI-34\)\. \[EBMR-EXE-133\]$/);
    const after = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(after?.steps[CLEAR]?.status).toBe('IN_PROGRESS');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[INV-20][PR-30][DI-27] a START whose state leaves out the START it makes is refused, so the honest PERFORMED signature still waits for the minimum (round 2, V1)', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withClearanceMinimum()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const run = await runContext(sbx.db.admin, runId);
    const who = personaIn(sbx, 'operator1');
    const forged = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [] };
        const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the START: ${JSON.stringify(r.refusal)}`);
        delete r.state.nodeEvents['p-disp-clear|START|'];
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(forged).toMatch(/^This accepted START_STEP row starts phase p-disp-clear@ but records no START event of it \(p-disp-clear\|START\|\): .*\(DI-27, INV-20, DI-34\)\. \[EBMR-EXE-133\]$/);
    expect((await execution.loadState(sbx.db.admin, runId))?.state.steps[CLEAR]?.status).toBe('ENABLED');
    // The honest run: started, its entries recorded, and its PERFORMED signature waits for the minimum.
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    expect(outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR })).result)).toMatch(/ENG-MIN-DURATION/);
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
  }, 300_000);
  it('[INV-20][PR-30][DI-27] round 3: a PERFORMED signature that finishes an operation in the branch an alternative took, stored without the operation\'s END, is refused, so the minimum ending there is measured; the honest signature records the END and its TIME_MIN_BREACH', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withBoothAlternative()), undefined, { booth: 'A' });
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const SOP = 'p-alt-sop@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: SOP });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: SOP, entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    const meaning = (await d.signing('operator1', { type: 'SIGN_PERFORMED', stepKey: SOP })).meaning;
    expect(meaning, 'SETUP: the SOP read is signed performed').not.toBe('');
    // The engine result of a definition without the minimum, with O-ALT's END taken out of the stored state.
    const forged = await forgedPerformed(d, 'p-alt-sop', meaning, (def, state) => ({
      def: {
        ...def,
        constraints: def.constraints.map((rc) => {
          if (rc.tc.id !== 'TC-ALT-MIN') return rc;
          const tc = { ...rc.tc };
          delete tc.min;
          return { ...rc, tc };
        }),
      },
      state,
      restore: (s) => {
        if (!s.nodeEvents['O-ALT|END|'] || !s.nodeEvents['alt-booth|END|']) throw new Error('SETUP: the engine did not end O-ALT and the alternative');
        delete s.nodeEvents['O-ALT|END|'];
      },
    }));
    expect(forged.engine, 'the engine itself accepts it: the operation\'s end is automatic and only raises its breach').toBe('accepted');
    expect(forged.database).toMatch(/^This accepted SIGN_PERFORMED row finishes what operation O-ALT holds, so the token leaves it, but records no END event of it \(O-ALT\|END\|\): .*\(DI-27, INV-20, DI-34\)\. \[EBMR-EXE-133\]$/);
    let stored = (await execution.loadState(sbx.db.admin, runId))?.state;
    expect(stored?.steps[SOP]?.status).toBe('IN_PROGRESS');
    expect(stored?.steps[CLEAR]).toBeUndefined();
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
    // The honest signature: O-ALT ends with its TIME_MIN_BREACH, and the clearance is reached.
    expect(outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: SOP })).result)).toBe('ok');
    stored = (await execution.loadState(sbx.db.admin, runId))?.state;
    expect(stored?.nodeEvents['O-ALT|END|']).toBeDefined();
    expect(Object.values(stored?.exceptions ?? {}).filter((x) => x.type === 'TIME_MIN_BREACH').map((x) => x.source.constraint)).toEqual(['TC-ALT-MIN']);
    expect(stored?.steps[CLEAR]?.status).toBe('ENABLED');
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
  }, 300_000);
});
