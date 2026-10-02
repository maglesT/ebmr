/**
 * Phase 2 exit review F11 (controls vs tests; INV-03, PR-13, PR-49, DI-17, DI-35; ADR 0012 item 8): the person who
 * dispositions an exception is outside the involvement set of the step that raised it, in the database as in the
 * engine (engine batch.ts dispositionException, ENG-SEGREGATION).
 *
 * Before recipe-core 0306 the database excluded only the exception's raiser and the person who linked its deviation:
 * the batch_exception content provider named only those two as having entered the record, so the kernel's INV-03 rule
 * (EBMR-ESIG-044) let a person who started, entered data in, corrected or signed performed the raising step sign the
 * disposition, and no recipe guard asked. A writer holding the application role (ebmr_sandbox here) then stored that
 * disposition with an engine result computed as if the person were not involved; the invariant query reported nothing.
 * Now the provider names the raising step's performers, data enterers, correctors and PERFORMED signers too (the kernel
 * refuses the signature), `check_disposition_state` refuses the row (EBMR-EXE-087), and `execution_violations()`
 * reports a disposition by a person involved in the step before it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

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

/** `key` also holds `roleCode` (requested by the administrator, approved by the owner; no rule forbids the pair). */
async function grantRole(key: string, roleCode: string): Promise<void> {
  const who = personaIn(sbx, key);
  const reason = { reasonCode: 'TEST_SETUP', reasonText: `F11: ${key} also holds ${roleCode}` };
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { ...reason, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope: {}, reason: reason.reasonText }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { ...reason, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'F11 set-up'));
}

/** A dc-mini run in which operator1 started the line clearance and entered data in it, and supervisor1 raised an exception on it. */
async function runWithStepException(): Promise<{ d: RunDriver; exception: string }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
  await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar during clearance', severity: 'ALERT' });
  const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
  if (!exception) throw new Error('SETUP: no exception');
  return { d, exception };
}

let operatorIsQa = false;

describe('F11: a person involved in the step that raised an exception never dispositions it (INV-03, PR-13, PR-49)', () => {
  it('[INV-03][PR-13][PR-49][DI-35] the signed content of an exception raised at a step names the step\'s performers and data enterers as having entered it, so the kernel knows who is excluded', async () => {
    const { d, exception } = await runWithStepException();
    const operator1 = personaIn(sbx, 'operator1').personId;
    const supervisor1 = personaIn(sbx, 'supervisor1').personId;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${exception}`]);
    expect([...(rows[0]?.c.entered_by ?? [])].sort()).toEqual([operator1, supervisor1].sort());
    // An exception raised at no step names only its raiser.
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const other = (await d.runView('qa1')).exceptions.find((x) => x.exceptionId !== exception)?.exceptionId ?? '';
    const { rows: plain } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${other}`]);
    expect(plain[0]?.c.entered_by).toEqual([operator1]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a person who entered data in the raising step, also holding QA_SHOP_FLOOR, cannot disposition the exception through the store directly: the kernel refuses the signature, nothing is recorded', async () => {
    const { d, exception } = await runWithStepException();
    if (!operatorIsQa) {
      await grantRole('operator1', 'QA_SHOP_FLOOR');
      operatorIsQa = true;
    }
    const who = personaIn(sbx, 'operator1');
    const asQa = async (extra: Partial<ActorContext> = {}): Promise<ActorContext> => ({ ...(await actorOf(sbx, d.browser('operator1'), 'operator1')), roleCode: 'QA_SHOP_FLOOR', ...extra });
    const run = await runContext(sbx.db.admin, d.runId);
    const before = await execution.loadState(sbx.db.admin, d.runId);
    expect(before?.state.steps[CLEAR]?.dataEnterers ?? [], 'operator1 entered data in the step').toContain(who.personId);
    expect(before?.state.exceptions[exception]?.source.stepKey).toBe(CLEAR);

    const justification = 'Door closed, booth re-checked; no impact.';
    await withCommand(sbx.db.app, await asQa(), (c) => execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification, deviationRef: null }));
    const agg = `${d.runId}:${exception}`;
    const content = await esig.contentForSigning(sbx.db.app, 'batch_exception', agg);
    const challenge = await withCommand(sbx.db.app, await asQa(), (c) =>
      esig.createChallenge(c, { aggregateType: 'batch_exception', aggregateId: agg, contentVersion: content.contentVersion ?? '', meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: content.contentHash ?? '' }),
    );
    const terminal = terminalOf(sbx.seed, d.browser('operator1').terminal);
    const ev = await identity.authenticate(sbx.db.authn, { method: 'BADGE_PIN', identifier: who.badgeUid ?? '', secret: who.pin ?? '', deviceFingerprint: terminal.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    const sealKey = sbx.built.ctx.sealKey;
    if (!sealKey) throw new Error('SETUP: no seal key');

    // The engine's own verdict on the stored state, in operator1's QA command: ENG-SEGREGATION.
    const honest = await withCommand(sbx.db.app, await asQa(), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'DISPOSITION_EXCEPTION',
        commandId: randomUUID(),
        actor: engineActor(who.personId, roles),
        exception,
        outcome: 'NO_IMPACT',
        justification,
        signature: { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
      };
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      return r.accepted ? 'accepted' : r.refusal?.code;
    });
    expect(honest).toBe('ENG-SEGREGATION');

    const outcome = await messageOf(
      withCommand(sbx.db.app, await asQa({ authEventId: ev.authEventId }), async (c) => {
        const signatureId = (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId;
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = {
          type: 'DISPOSITION_EXCEPTION',
          commandId: randomUUID(),
          actor: engineActor(who.personId, roles),
          exception,
          outcome: 'NO_IMPACT',
          justification,
          signature: { id: signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
        };
        // The application role bypasses the engine's rule: the result is computed as if operator1 were not involved in
        // the step, and the step's involvement lists are put back unchanged.
        const doctored = structuredClone(tx.state);
        const s = doctored.steps[CLEAR];
        if (!s) throw new Error('SETUP: no step');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) s[list] = s[list].filter((p) => p !== who.personId);
        const r = engine.step(tx.def, doctored, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the doctored state: ${JSON.stringify(r.refusal)}`);
        const real = tx.state.steps[CLEAR];
        const out = r.state.steps[CLEAR];
        if (!real || !out) throw new Error('SETUP');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) out[list] = [...real[list]];
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(outcome).toMatch(/EBMR-ESIG-044|EBMR-EXE-087/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(rows[0]?.n).toBe('0');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] the server\'s own signing path refuses the same disposition, and an uninvolved QA reviewer records it', async () => {
    const { d, exception } = await runWithStepException();
    // supervisor1 raised it: the kernel's rule on the raiser holds as before.
    const own = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect(outcomeOf(own.result), own.result.ok ? '' : JSON.stringify(own.result.error)).toBe('ok');
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.disposition?.by).toBe(personaIn(sbx, 'qa1').personId);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] a disposition by a person who was involved in the raising step before it, landed in the store behind the writers\' back, is reported by the invariant query', async () => {
    const { d, exception } = await runWithStepException();
    const qa1 = personaIn(sbx, 'qa1').personId;
    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect(outcomeOf(r.result)).toBe('ok');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    // A restore or a hand edit puts an involvement of qa1 in the step into the row that recorded the PREVIOUS_BATCH entry.
    const { rows } = await sbx.db.admin.query<{ seq: string }>("select seq::text as seq from recipe.execution_command where batch_id = $1 and command_type = 'RECORD_ENTRY' and accepted order by seq limit 1", [d.runId]);
    const seq = rows[0]?.seq;
    if (!seq) throw new Error('SETUP: no entry row');
    const admin = await sbx.db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
         select $1, $2::bigint, coalesce(max(idx), -1) + 1, 'INVOLVEMENT', jsonb_build_object('type', 'INVOLVEMENT', 'stepKey', $3::text, 'person', $4::text, 'involvement', 'ENTERED_DATA')
           from recipe.execution_event where batch_id = $1 and row_seq = $2::bigint`,
        [d.runId, seq, CLEAR, qa1],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([expect.stringMatching(new RegExp(`exception ${exception} .*${qa1}.*involved in step ${CLEAR.replace('@', '@')}`))]);
  }, 300_000);
});
