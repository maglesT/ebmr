/**
 * Phase 3 slice 2, plan item 3: the hand-over of a step in progress (recipe-core 0461, 0462, 0463; outline 5.2.3, L-07;
 * engine 1.6.0). The application role (ebmr_sandbox here; ADR 0012) records each act through the store, honestly (the
 * engine's own result) and forged (an accepted row the engine would refuse, or a state the engine would never store),
 * with e-signatures made through the kernel: exactly what a compromised application could do.
 *
 *   HAND_OVER_STEP  of a step in progress, signed by a production supervisor and approved by QA, two persons, neither
 *                   the outgoing nor the incoming performer nor involved in the step, with a reason; the step needs its
 *                   check by a second person; the hand-over stands in the exception register (STEP_HANDED_OVER);
 *   TAKE_OVER_STEP  only by the incoming performer the hand-over names;
 *   and the outgoing performer's entries stay attributed and valid, they no longer act in the step, and the verifier
 *   is none of the persons involved, outgoing and incoming alike (INV-03, INV-31, PR-14).
 * Closes the Phase 2 backlog item "a relief operator cannot complete a step whose data enterer went off shift".
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, codeOf, proposeAct, messageOf, prepareSignature, signatureAlone, unmatched } from './db-guards-support.ts';
import { importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, engine.JsonValue>;
const EARLY = 'p-early-time@';
const PERSONAS = ['operator1', 'operator2', 'operatorVerifier1', 'verifier1', 'supervisor1', 'qa1'];
const ENGINE_ROLE: Record<string, string> = { supervisor1: 'PRODUCTION_SUPERVISOR', qa1: 'QA' };
const REASON = 'The operator went off shift with the step half done';

async function newRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyParameter()));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of PERSONAS) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

const stateOf = async (d: RunDriver): Promise<engine.BatchState> => {
  const st = await execution.loadState(sbx.db.admin, d.runId);
  if (!st) throw new Error('SETUP: no state');
  return st.state;
};
const accepted = async (d: RunDriver, type: string) => (await rowsOf(sbx, d.runId)).filter((r) => r.command_type === type && r.accepted);
const id = (persona: string): string => personaIn(sbx, persona).personId;

/** The approved act (recipe-core 0470) of supervisor1's hand-over with `over`, recorded by supervisor1: its aggregate id. */
const handOverAct = (d: RunDriver, over: HandOverChange = {}, requester = 'supervisor1'): Promise<string> =>
  proposeAct(sbx, d.browser(requester), requester, d.runId, handOver(PLACEHOLDER, over)({ id: id(requester), kind: 'PERSON', roles: [] }));

/** `persona`'s HANDOVER_APPROVED of the hand-over with `over` as it stands now (the approved act), signed in a command of its own. */
async function approval(d: RunDriver, persona: string, over: HandOverChange = {}): Promise<engine.Approval> {
  const sig = await signatureAlone(sbx, d.browser(persona), persona, 'batch_act', await handOverAct(d, over), 'HANDOVER_APPROVED');
  return { approver: { id: id(persona), kind: 'PERSON', roles: [ENGINE_ROLE[persona] ?? 'QA'] }, signature: { id: sig, meaning: 'HANDOVER_APPROVED', signer: id(persona) } };
}

interface Act {
  /** The persona's own signature made in the recording command. */
  own?: boolean;
  twin?: (actor: engine.Actor, signature?: engine.SignatureRef) => engine.Command;
  recorded?: (encoded: Json) => engine.JsonValue;
  forge?: (state: engine.BatchState) => void;
  /** The kernel role the persona acts in (default: their first). */
  roleCode?: string;
}

/** As db-guards-change-paths.test.ts: the engine's verdict ('ok', 'refused <code>') or, forged, the database's. */
async function act(d: RunDriver, persona: string, build: (actor: engine.Actor, signature?: engine.SignatureRef) => engine.Command, a: Act = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  // The supervisor signs the hand-over they record (the approved act of the command as recorded, 0470).
  const pending = a.own
    ? await prepareSignature(sbx, d.browser(persona), persona, 'batch_act', await proposeAct(sbx, d.browser(persona), persona, d.runId, build({ id: id(persona), kind: 'PERSON', roles: [] })), 'HANDOVER_APPROVED')
    : undefined;
  return messageOf(
    withCommand(sbx.db.app, pending ? await pending.actor() : await actorOf(sbx, d.browser(persona), persona, a.roleCode ? { roleCode: a.roleCode } : {}), async (c) => {
      const sig = pending ? { id: await pending.sign(c), meaning: 'HANDOVER_APPROVED', signer: id(persona) } : undefined;
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const actor = engineActor(id(persona), roles);
      const command = build(actor, sig);
      if (!a.twin && !a.recorded && !a.forge) {
        const r = await tx.command(command, roles);
        if (!r.accepted) throw new Error(`refused ${r.refusal?.code ?? '?'}`);
        return r;
      }
      const twin = a.twin ? a.twin(actor, sig) : command;
      const r = engine.step(run.def, tx.state, twin, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the twin ${twin.type}: ${JSON.stringify(r.refusal)}`);
      a.forge?.(r.state);
      const encoded = engine.encodeCommand(command) as Json;
      return appendAs(tx, command, r, roles, a.recorded ? a.recorded(encoded) : encoded);
    }),
  );
}

type HandOverChange = Partial<{ outgoing: string; incoming: engine.Actor; reason: string }>;
/** `persona` as an incoming performer, naming the step's perform role (dc-mini's PRODUCTION_OPERATOR). */
const performer = (persona: string, roles: string[] = ['PRODUCTION_OPERATOR']): engine.Actor => ({ id: id(persona), kind: 'PERSON', roles });
const PLACEHOLDER: engine.Approval = { approver: { id: 'nobody', kind: 'PERSON', roles: [] }, signature: { id: randomUUID(), meaning: 'HANDOVER_APPROVED', signer: 'nobody' } };
const handOver = (qa: engine.Approval, over: HandOverChange = {}) => (actor: engine.Actor, signature?: engine.SignatureRef): engine.Command => ({
  type: 'HAND_OVER_STEP',
  commandId: randomUUID(),
  actor,
  step: 'p-early-time',
  context: [],
  outgoing: over.outgoing ?? id('operatorVerifier1'),
  incoming: over.incoming ?? performer('operator1'),
  reason: over.reason ?? REASON,
  signature: signature ?? { id: randomUUID(), meaning: 'HANDOVER_APPROVED', signer: actor.id },
  approval: qa,
});
const takeOver = (actor: engine.Actor): engine.Command => ({ type: 'TAKE_OVER_STEP', commandId: randomUUID(), actor, step: 'p-early-time', context: [] });
const recordAgain = (actor: engine.Actor): engine.Command => ({ type: 'RECORD_DATA', commandId: randomUUID(), actor, step: 'p-early-time', context: [], item: 'blendTime', value: { kind: 'DECIMAL', value: '16', unit: 'min' }, source: { mode: 'MANUAL' } });

/** operatorVerifier1 starts the step and keys the blend time: the outgoing performer. */
async function startedByOutgoing(): Promise<RunDriver> {
  const d = await newRun();
  await d.ok('operatorVerifier1', { type: 'START_STEP', stepKey: EARLY });
  await d.ok('operatorVerifier1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
  return d;
}

describe('HAND_OVER_STEP: signed by a supervisor and approved by QA, neither of them a performer, with a reason', () => {
  it('[PR-14][DI-24][DI-26][DI-35] the honest hand-over is recorded and registered; without QA\'s approval, from a person not on the step, approved by the incoming performer, without its exception or with another reason than given, it is refused', async () => {
    const d = await startedByOutgoing();
    const qa = await approval(d, 'qa1');
    const without = (x: Json): Json => {
      const rest = { ...x };
      delete rest['approval'];
      return rest;
    };
    const honest = handOver(qa);
    const outcomes = {
      noApproval: await act(d, 'supervisor1', honest, { own: true, recorded: without }),
      outgoingNotOnStep: await act(d, 'supervisor1', handOver(await approval(d, 'qa1', { outgoing: id('verifier1') }), { outgoing: id('verifier1') }), { own: true, twin: honest, forge: (s) => void (s.steps[EARLY]!.handOvers![0]!.outgoing = id('verifier1')) }),
      approvedByIncoming: await act(d, 'supervisor1', handOver(await approval(d, 'qa1', { incoming: performer('qa1') }), { incoming: performer('qa1') }), { own: true, twin: honest, forge: (s) => void (s.steps[EARLY]!.handOvers![0]!.incoming = id('qa1')) }),
      noException: await act(d, 'supervisor1', honest, {
        own: true,
        forge: (s) => {
          for (const e of Object.values(s.exceptions)) if (e.type === 'STEP_HANDED_OVER') e.type = 'OPERATOR_RAISED';
        },
      }),
      anotherReason: await act(d, 'supervisor1', honest, { own: true, forge: (s) => void (s.steps[EARLY]!.handOvers![0]!.reason = 'nothing in particular') }),
    };
    expect(
      unmatched(outcomes, {
        noApproval: /A hand-over is approved by another person than the one who asks for it.*\[EBMR-EXE-052\]/,
        outgoingNotOnStep: /it hands step p-early-time@ over from .*, who is not a performer of it still on it.*\[EBMR-EXE-185\]/,
        approvedByIncoming: /it is signed or approved by a performer of step p-early-time@ or a person its hand-over names.*\[EBMR-EXE-185\]/,
        noException: /EBMR-EXE-(185|1[0-9][0-9]|0[0-9][0-9])/,
        anotherReason: /it leaves step p-early-time@ otherwise than the hand-over the command records.*\[EBMR-EXE-185\]/,
      }),
    ).toEqual({});
    expect(await accepted(d, 'HAND_OVER_STEP')).toEqual([]);
    // The engine refuses a hand-over to the outgoing performer and one with a blank reason.
    expect(await act(d, 'supervisor1', handOver(qa, { incoming: performer('operatorVerifier1') }), { own: true })).toBe('refused ENG-HANDOVER-PERSON');
    expect(await act(d, 'supervisor1', handOver(qa, { reason: ' ​ ' }), { own: true })).toBe('refused ENG-REASON');

    // The honest hand-over: the step waits for the incoming performer, needs a second person's check, the entry stays the
    // outgoing performer's and valid, and the hand-over stands in the exception register.
    const point = Object.values((await stateOf(d)).points).find((p) => p.item === 'blendTime');
    expect(await act(d, 'supervisor1', handOver(qa), { own: true })).toBe('ok');
    const st = await stateOf(d);
    expect(st.steps[EARLY]).toMatchObject({ status: 'ATTEMPT_HANDED_OVER', verificationRequired: true, handOvers: [{ outgoing: id('operatorVerifier1'), incoming: id('operator1'), reason: REASON, supervisor: id('supervisor1'), qaApprover: id('qa1') }] });
    expect(st.points[point?.id ?? '']).toMatchObject({ enteredBy: id('operatorVerifier1'), status: 'VALID' });
    const row = (await accepted(d, 'HAND_OVER_STEP'))[0];
    expect(row?.signature_ids).toHaveLength(2);
    const { rows: reg } = await sbx.db.admin.query<{ exception_type: string; category: string; raising_step_key: string; mandatory: boolean }>(
      'select exception_type, category, raising_step_key, mandatory from recipe.exception_register where batch_id = $1 and exception_type = $2',
      [d.runId, 'STEP_HANDED_OVER'],
    );
    expect(reg).toEqual([{ exception_type: 'STEP_HANDED_OVER', category: 'DEVIATION_OR_OVERRIDE', raising_step_key: EARLY, mandatory: true }]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('TAKE_OVER_STEP and after: the incoming performer completes the step; the verifier is neither performer', () => {
  it('[INV-31][PR-14][DI-24][DI-37] only the named incoming performer takes the step over; the outgoing performer no longer acts in it; the step completes with the incoming performer\'s PERFORMED signature and a third person\'s check', async () => {
    const d = await startedByOutgoing();
    const qa = await approval(d, 'qa1');
    expect(await act(d, 'supervisor1', handOver(qa), { own: true })).toBe('ok');

    // Another performer than the named one: refused by the engine, and a row recorded as accepted by the database.
    expect(await act(d, 'operator2', takeOver)).toBe('refused ENG-HANDOVER-PERSON');
    expect(await act(d, 'operator2', takeOver, { twin: (actor) => takeOver({ ...actor, id: id('operator1') }) })).toMatch(
      /it takes step p-early-time@ over by .*, whom its last hand-over does not name as the incoming performer.*\[EBMR-EXE-185\]/,
    );
    expect(await act(d, 'operator1', takeOver)).toBe('ok');
    const taken = (await stateOf(d)).steps[EARLY];
    expect(taken?.status).toBe('IN_PROGRESS');
    expect(taken?.performers).toContain(id('operator1'));

    // The outgoing performer no longer records in the step (engine and database).
    expect(await act(d, 'operatorVerifier1', recordAgain)).toBe('refused ENG-HANDED-OVER');
    expect(
      await act(d, 'operatorVerifier1', recordAgain, {
        twin: (actor) => recordAgain({ ...actor, id: id('operator1') }),
        forge: (s) => {
          for (const p of Object.values(s.points)) if (p.enteredBy === id('operator1')) p.enteredBy = id('operatorVerifier1');
          for (const e of Object.values(s.exceptions)) if (e.raisedBy === id('operator1')) e.raisedBy = id('operatorVerifier1');
        },
      }),
    ).toMatch(/is .*'s act in step p-early-time@, which they handed over.*\[EBMR-EXE-185\]/);

    // The incoming performer signs for the step; it needs the check of a person who is neither performer.
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
    expect((await stateOf(d)).steps[EARLY]?.status).toBe('AWAITING_VERIFICATION');
    const verifyBy = (actor: engine.Actor, signature?: engine.SignatureRef): engine.Command => ({ type: 'VERIFY', commandId: randomUUID(), actor, step: 'p-early-time', context: [], signature: signature ?? { id: randomUUID(), meaning: 'VERIFIED', signer: actor.id } });
    expect(await act(d, 'operatorVerifier1', verifyBy, { roleCode: 'VERIFIER' })).toMatch(/^(refused ENG-SEGREGATION|.*\[EBMR-EXE-033\])/);
    await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' });
    expect((await stateOf(d)).steps[EARLY]?.status).toBe('COMPLETED');
    expect(await violations(sbx)).toEqual([]);

    // INV-31, PR-14: whatever lists a stored state holds, the database's rule names the outgoing and the incoming
    // performer, and the taker, as involved from the accepted rows: a VERIFY by either is refused.
    const rows = await rowsOf(sbx, d.runId);
    const verifyRow = rows.find((r) => r.command_type === 'VERIFY' && r.accepted);
    const { rows: before } = await sbx.db.admin.query<{ state: engine.JsonValue }>('select state from recipe.execution_state where batch_id = $1', [d.runId]);
    const stripped = JSON.parse(JSON.stringify(before[0]?.state)) as { steps: Record<string, Record<string, unknown>> };
    for (const m of ['performers', 'dataEnterers', 'correctors', 'performedSigners']) stripped.steps[EARLY]![m] = [];
    const problem = async (persona: string, command: Json = { type: 'VERIFY', step: 'p-early-time', context: [] }): Promise<string | null> => {
      const { rows: r } = await sbx.db.admin.query<{ p: string | null }>(
        `select recipe.hand_over_problem($1, $2::jsonb, $2::jsonb, 'COMMAND', true, $5::jsonb, $3, $4) as p`,
        [d.runId, JSON.stringify(stripped), id(persona), Number(verifyRow?.seq ?? 0) + 1000, JSON.stringify(command)],
      );
      return r[0]?.p ?? null;
    };
    expect(await problem('operatorVerifier1')).toMatch(/verifies step p-early-time@ by .* the verifier is always another person/);
    expect(await problem('operator1')).toMatch(/verifies step p-early-time@ by .* the verifier is always another person/);
    expect(await problem('verifier1')).toBeNull();
    // Review finding 6: the supervisor who signed the hand-over and QA who approved it do not verify the step either.
    expect(await problem('supervisor1')).toMatch(/verifies step p-early-time@ by .*signed or approved its hand-over; the verifier is always another person/);
    expect(await problem('qa1')).toMatch(/verifies step p-early-time@ by .*signed or approved its hand-over; the verifier is always another person/);
    // Review finding 4: the outgoing performer does not correct the step's data.
    const point = Object.values((await stateOf(d)).points).find((p) => p.item === 'blendTime')?.id ?? '';
    expect(await problem('operatorVerifier1', { type: 'CORRECT_ENTRY', point })).toMatch(/is .*'s correction in step p-early-time@, which they handed over/);
    expect(await problem('operator1', { type: 'CORRECT_ENTRY', point })).toBeNull();
  }, 300_000);

  it('[PR-14][DI-34][PR-13][PR-49] review findings 1, 2, 4: a hand-over to a person without the step\'s perform role is refused; a step waiting for its incoming performer is handed over again, only from that person; nobody named in a hand-over signs the disposition of its exception; the outgoing performer raises no exception at the step', async () => {
    const d = await startedByOutgoing();
    // 1: the engine trusts the roles the command names; the database reads them from the person's grants.
    const qaV = await approval(d, 'qa1', { incoming: performer('verifier1') });
    expect(await act(d, 'supervisor1', handOver(qaV, { incoming: performer('verifier1') }), { own: true })).toMatch(
      /it hands step p-early-time@ over to .*, who is not an active person with an active account holding the step's perform role PRODUCTION_OPERATOR now \(holds PRODUCTION_VERIFIER\).*\[EBMR-EXE-185\]/,
    );
    expect(await accepted(d, 'HAND_OVER_STEP')).toEqual([]);
    expect(await act(d, 'supervisor1', handOver(await approval(d, 'qa1')), { own: true })).toBe('ok');

    // 2: QA, who approved the hand-over, cannot sign the disposition of its exception (the kernel reads the involvement).
    const ex = Object.values((await stateOf(d)).exceptions).find((e) => e.type === 'STEP_HANDED_OVER')?.id ?? '';
    expect(await codeOf(signatureAlone(sbx, d.browser('qa1'), 'qa1', 'batch_exception', `${d.runId}:${ex}`, 'EXCEPTION_DISPOSITIONED'))).toBe('EBMR-ESIG-044');
    const { rows: inv } = await sbx.db.admin.query<{ i: string[] }>('select recipe.exception_step_involvement($1, s.state, $2, null) as i from recipe.execution_state s where s.batch_id = $1', [d.runId, ex]);
    expect(inv[0]?.i).toEqual(expect.arrayContaining([id('supervisor1'), id('qa1'), id('operatorVerifier1'), id('operator1')]) as unknown);

    // 1: operator1 does not come: the step is handed over again, from operator1, to operator2 (not from the first outgoing).
    const wrong = { outgoing: id('operatorVerifier1'), incoming: performer('operator2') };
    const qaWrong = await approval(d, 'qa1', wrong);
    expect(await act(d, 'supervisor1', handOver(qaWrong, wrong), { own: true })).toBe('refused ENG-HANDOVER-PERSON');
    expect(
      await act(d, 'supervisor1', handOver(qaWrong, wrong), {
        own: true,
        twin: handOver(await approval(d, 'qa1', { outgoing: id('operator1'), incoming: performer('operator2') }), { outgoing: id('operator1'), incoming: performer('operator2') }),
        forge: (s) => void (s.steps[EARLY]!.handOvers![1]!.outgoing = id('operatorVerifier1')),
      }),
    ).toMatch(/it hands step p-early-time@, which waits for .*, over from .*; a step waiting for its incoming performer is handed over again from that person.*\[EBMR-EXE-185\]/);
    const again = { outgoing: id('operator1'), incoming: performer('operator2'), reason: 'The incoming operator called in sick' };
    expect(await act(d, 'supervisor1', handOver(await approval(d, 'qa1', again), again), { own: true })).toBe('ok');
    expect((await stateOf(d)).steps[EARLY]).toMatchObject({ status: 'ATTEMPT_HANDED_OVER', handOvers: [{ incoming: id('operator1') }, { outgoing: id('operator1'), incoming: id('operator2') }] });
    expect(await act(d, 'operator1', takeOver)).toBe('refused ENG-HANDOVER-PERSON');
    expect(await act(d, 'operator2', takeOver)).toBe('ok');

    // 4: the outgoing performer raises no exception at the step (engine and database).
    const raise = (actor: engine.Actor): engine.Command => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor, step: 'p-early-time', context: [], description: 'A note on leaving', severity: 'ALERT' });
    expect(await act(d, 'operatorVerifier1', raise)).toBe('refused ENG-HANDED-OVER');
    expect(
      await act(d, 'operatorVerifier1', raise, {
        twin: (actor) => raise({ ...actor, id: id('operator2') }),
        forge: (s) => {
          for (const e of Object.values(s.exceptions)) if (e.raisedBy === id('operator2')) {
            e.raisedBy = id('operatorVerifier1');
            e.title = e.title.replace(id('operator2'), id('operatorVerifier1'));
          }
        },
      }),
    ).toMatch(/is .*'s act in step p-early-time@, which they handed over.*\[EBMR-EXE-185\]/);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[DI-24][DI-34] a direct write of the stored state that hands a step over is refused by the privileges', async () => {
    const d = await startedByOutgoing();
    const update = await codeOf(sbx.db.app.query(`update recipe.execution_state set state = jsonb_set(state, '{steps,${EARLY},status}', '"ATTEMPT_HANDED_OVER"') where batch_id = $1`, [d.runId]));
    expect(update).toMatch(/permission denied/);
    expect((await stateOf(d)).steps[EARLY]?.status).toBe('IN_PROGRESS');
  }, 120_000);
});
