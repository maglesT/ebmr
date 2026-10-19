/**
 * The exception register in the database (Phase 3 slice 2, plan item 1; recipe-core sql/0440; outline 5.2.4; PR-08,
 * PR-13, DI-26 register part, INV-41, INV-03; ADR 0012: the application role, ebmr_sandbox here, is the attacker).
 *
 * Every exception the engine raises gets an insert-only register row in the same transaction as the row that raises it
 * (its tier, type, raising step, raiser, database time and mandatory flag), and every act on it a new act row: the
 * deviation link and the disposition with the engine row that does them, the QA review acts through
 * recipe.review_exception. The register and the state are kept together on every row: an exception keeps the facts it
 * was raised with, is never removed, closes only by its own signed disposition (never by a correction), and a QA-only
 * exception (registered or validated tier) is dispositioned only by a person holding a QA role of the batch policy.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { passwordActor } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, codeOf, engineResult, messageOf, prepareSignature } from './db-guards-support.ts';
import { asPersonaInRole, dcMiniVariant, importAndIssue, outcomeOf, personaIn, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';
import type { TestBrowser } from '../support/harness.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
const KEY = 'p-early-time@';

/**
 * The blend time recorded first in the dispensing stage (registered 10-20 min, internal action 12-18 min, alert 14-16
 * min), declared NON_CRITICAL here so its correction needs no second person (S25) and its check stays a later review.
 */
const withEarlyBlendTime = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    for (const x of content['parameters'] as Json[]) if (x['id'] === 'blendTime') x['criticality'] = 'NON_CRITICAL';
    const early = { ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [], signatures: { ...(p['signatures'] as Json), check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } };
    return [early, ...prep];
  });

const granted = new Set<string>();
/** `key` also holds `roleCode` (requested by the administrator, approved by the owner). */
async function grantRole(key: string, roleCode: string): Promise<void> {
  if (granted.has(`${key}/${roleCode}`)) return;
  const who = personaIn(sbx, key);
  const reason = { reasonCode: 'TEST_SETUP', reasonText: `exception register: ${key} also holds ${roleCode}` };
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { ...reason, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope: {}, reason: reason.reasonText }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { ...reason, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'exception register set-up'));
  granted.add(`${key}/${roleCode}`);
}

/** A run of the early blend time in which operator1 started the step and recorded `minutes`; returns the driver and the limit exception's id. */
async function blendRun(minutes: string): Promise<{ d: RunDriver; breach: string }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyBlendTime()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
  await d.ok('operator1', { type: 'RECORD_DATA', stepKey: KEY, item: 'blendTime', value: { kind: 'DECIMAL', value: minutes, unit: 'min' }, source: { mode: 'MANUAL' } });
  const st = await execution.loadState(sbx.db.admin, runId);
  const breach = Object.values(st?.state.exceptions ?? {}).find((x) => x.type === 'LIMIT_BREACH')?.id;
  if (!breach) throw new Error(`SETUP: no limit exception for ${minutes} min`);
  return { d, breach };
}

const register = (runId: string) => execution.loadExceptionRegister(sbx.db.admin, runId);
const entry = async (runId: string, id: string) => {
  const r = (await register(runId)).find((x) => x.exceptionId === id);
  if (!r) throw new Error(`no register row for ${id}`);
  return r;
};

/** The register and the stored state name the same exceptions with the same status. */
async function inStep(runId: string): Promise<void> {
  const st = await execution.loadState(sbx.db.admin, runId);
  const fromState = Object.values(st?.state.exceptions ?? {}).map((x) => [x.id, x.status, x.deviation?.ref ?? null]).sort();
  const fromRegister = (await register(runId)).map((x) => [x.exceptionId, x.status, x.deviationRef]).sort();
  expect(fromRegister).toEqual(fromState);
}

/** operator1 corrects the blend time to `minutes` through the store, with the engine's own result except as `forge` changes the state. */
async function correctBlendTime(d: RunDriver, minutes: string, forge?: (state: engine.BatchState) => void): Promise<string> {
  const before = await execution.loadState(sbx.db.admin, d.runId);
  const point = Object.values(before?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID')?.id;
  if (!point) throw new Error('SETUP: no blend time');
  const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_point', `${d.runId}:${point}`, 'CORRECTED');
  const who = personaIn(sbx, 'operator1').personId;
  const run = await runContext(sbx.db.admin, d.runId);
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'CORRECT_ENTRY', commandId: randomUUID(), actor: engineActor(who, roles), point,
        value: { kind: 'DECIMAL', value: minutes, unit: 'min' }, reason: 'Transcription error: the timer read another value', signature: { id, meaning: 'CORRECTED', signer: who },
      };
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      forge?.(state);
      return appendAs(tx, command, { state, events: r.events }, roles);
    }),
  );
}

/** A review act through recipe.review_exception in `browser`'s session: 'ok' or the refusal's message. */
async function review(browser: TestBrowser, persona: string, runId: string, exception: string, act: execution.ExceptionReviewAct, note: string | null, ref: string | null = null): Promise<string> {
  return messageOf(withCommand(sbx.db.app, await actorOf(sbx, browser, persona), (c) => execution.reviewException(c, runId, exception, act, note, ref)));
}

describe('the exception register (recipe-core 0440)', () => {
  it('[PR-08][DI-26][INV-41] every exception is registered with the row that raises it: tier, type, raising step, raiser, database time and mandatory flag; the register and the state never disagree', async () => {
    const { d, breach } = await blendRun('19');
    const me = personaIn(sbx, 'operator1');
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', description: 'Blender room door found open', severity: 'ALERT' });
    const rows = await rowsOf(sbx, d.runId);
    const recorded = rows.find((r) => r.command_type === 'RECORD_DATA' && r.accepted);
    const raisedAt = await sbx.db.admin.query<{ t: string }>('select recorded_at::text as t from recipe.execution_command where batch_id = $1 and seq = $2', [d.runId, recorded?.seq]);
    expect(await entry(d.runId, breach)).toMatchObject({
      exceptionType: 'LIMIT_BREACH', category: 'OUT_OF_LIMIT', severity: 'ACTION', tier: 'INTERNAL_ACTION', mandatory: true, qaOnly: false,
      deviationRequired: true, registrationRelevant: false, raisingStepKey: KEY, raisedBy: me.personId, rowSeq: recorded?.seq,
      raisedAt: raisedAt.rows[0]?.t, status: 'OPEN', deviationRef: null, reviewState: 'NOT_REVIEWED', blocking: true,
    });
    const operators = (await register(d.runId)).filter((x) => x.exceptionType === 'OPERATOR_RAISED');
    expect(operators).toMatchObject([{ category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', tier: null, raisingStepKey: null, raisedBy: personaIn(sbx, 'supervisor1').personId, mandatory: true, blocking: false }]);
    await inStep(d.runId);

    // Every review category the engine and the blocks raise is mandatory, and none can be switched off.
    const cats = await sbx.db.admin.query<{ category: string; mandatory: boolean }>('select category, mandatory from recipe.exception_review_category order by 1');
    const engineCats = new Set(engine.ENGINE_EXCEPTION_RULES.map((r) => r.category));
    expect([...engineCats].filter((c) => !cats.rows.some((r) => r.category === c))).toEqual([]);
    expect(cats.rows.filter((r) => !r.mandatory)).toEqual([]);
    expect(await codeOf(sbx.db.admin.query("update recipe.exception_review_category set mandatory = false where category = 'LATE_ENTRY'"))).toMatch(/^EBMR-|insert-only|not allowed/i);
    expect(await messageOf(sbx.db.app.query("update recipe.exception_review_category set mandatory = false where category = 'LATE_ENTRY'"))).toMatch(/permission denied/);
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[PR-08][PR-13][DI-26] action tier: the measuring step stays blocked until a deviation is linked; the link is registered with its row and the exception stays open until its disposition', async () => {
    const { d, breach } = await blendRun('19');
    expect(outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY })).result)).toMatch(/ENG-BLOCKED/);
    expect((await entry(d.runId, breach)).blocking).toBe(true);
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach, deviationRef: 'TEST-DEV-0441' });
    const linked = await entry(d.runId, breach);
    expect(linked).toMatchObject({ status: 'OPEN', deviationRef: 'TEST-DEV-0441', blocking: false });
    const act = await sbx.db.admin.query<{ by: string; seq: string; type: string }>(
      `select a.by_person::text as by, a.row_seq::text as seq, c.command_type as type from recipe.exception_register_act a
         join recipe.execution_command c on c.batch_id = a.batch_id and c.seq = a.row_seq where a.batch_id = $1 and a.exception_id = $2 and a.act = 'DEVIATION_LINKED'`,
      [d.runId, breach],
    );
    expect(act.rows.map((r) => [r.by, r.type])).toEqual([[personaIn(sbx, 'supervisor1').personId, 'ATTACH_DEVIATION']]);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    expect((await entry(d.runId, breach)).status).toBe('OPEN');
    await inStep(d.runId);
  }, 300_000);

  it('[INV-41][DI-26] an exception never closes by a correction: a correction to pass is refused, a corrected failing value leaves the exception open in the state and the register, and a correction row that closes it is refused', async () => {
    const { d, breach } = await blendRun('19');
    // A correction that would make the failing value pass is refused by the engine (fail to pass needs objective evidence).
    expect(await correctBlendTime(d, '15')).toMatch(/ENG-CORRECT-FAIL-TO-PASS/);
    const forged = await correctBlendTime(d, '21', (state) => {
      const x = state.exceptions[breach];
      if (!x) throw new Error('SETUP: the breach is gone');
      x.status = 'DISPOSITIONED';
      x.disposition = { by: personaIn(sbx, 'operator1').personId, outcome: 'NO_IMPACT', justification: 'Corrected value is within limits', signature: randomUUID(), at: x.raisedAt };
    });
    expect(forged).toMatch(/\[EBMR-EXE-(044|161)\]/);
    expect(await correctBlendTime(d, '21')).toBe('ok');
    const st = await execution.loadState(sbx.db.admin, d.runId);
    expect(st?.state.exceptions[breach]?.status).toBe('OPEN');
    expect(await entry(d.runId, breach)).toMatchObject({ status: 'OPEN', tier: 'INTERNAL_ACTION', blocking: true });
    expect(await violations(sbx).then((v) => v.filter((x) => x.batchId === d.runId))).toEqual([]);
    expect((await register(d.runId)).map((x) => x.exceptionType)).toContain('POST_ENTRY_CORRECTION');
    await inStep(d.runId);
  }, 300_000);

  it('[PR-08][PR-13] a registered-tier breach is dispositioned only by QA: a QA reviewer outside the batch policy\'s QA roles is refused by the database even with an engine result that accepts it; the QA disposition is registered with its signature', async () => {
    const { d, breach } = await blendRun('25');
    expect(await entry(d.runId, breach)).toMatchObject({ tier: 'REGISTERED', severity: 'CRITICAL', qaOnly: true, registrationRelevant: true, deviationRequired: true, blocking: true });
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach, deviationRef: 'TEST-DEV-0442' });

    await grantRole('verifier1', 'QA_REVIEWER');
    const reviewer = await asPersonaInRole(sbx, 'verifier1', 'QA_REVIEWER');
    const justification = 'Registration-relevant deviation TEST-DEV-0442 raised';
    await withCommand(sbx.db.app, await actorOf(sbx, reviewer, 'verifier1'), (c) => execution.proposeDisposition(c, d.runId, breach, { outcome: 'DEVIATION_RAISED', justification, deviationRef: 'TEST-DEV-0442' }));
    const p = await prepareSignature(sbx, reviewer, 'verifier1', 'batch_exception', `${d.runId}:${breach}`, 'EXCEPTION_DISPOSITIONED');
    const who = personaIn(sbx, 'verifier1').personId;
    const run = await runContext(sbx.db.admin, d.runId);
    let verdict = '';
    const database = await messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'DISPOSITION_EXCEPTION', commandId: randomUUID(), actor: engineActor(who, roles), exception: breach, outcome: 'DEVIATION_RAISED', justification, signature: { id, meaning: 'EXCEPTION_DISPOSITIONED', signer: who } };
        const honest = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        verdict = honest.accepted ? 'accepted' : (honest.refusal?.code ?? 'refused');
        // The engine's result under a policy that counts the QA reviewer as QA (what a writer holding the application role can compute).
        const lax = { ...tx.def, policy: { ...tx.def.policy, qaRoles: [...tx.def.policy.qaRoles, 'QA_REVIEWER'] } };
        const r = engine.step(lax, tx.state, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the lax disposition: ${JSON.stringify(r.refusal)}`);
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(verdict).not.toBe('accepted');
    expect(database).toMatch(/is dispositioned only by QA, and the row holds no quality-unit role.*\(PR-08, PR-13\)\. \[EBMR-EXE-162\]$/);
    expect(await entry(d.runId, breach)).toMatchObject({ status: 'OPEN', dispositionedBy: null });

    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'DEVIATION_RAISED', justification });
    const st = await execution.loadState(sbx.db.admin, d.runId);
    expect(await entry(d.runId, breach)).toMatchObject({
      status: 'DISPOSITIONED', dispositionOutcome: 'DEVIATION_RAISED', dispositionedBy: personaIn(sbx, 'qa1').personId,
      dispositionSignature: st?.state.exceptions[breach]?.disposition?.signature, blocking: false,
    });
    await inStep(d.runId);
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][DI-26] a disposition by a person who worked in the raising step is refused and the register records none; one by QA outside the step is registered', async () => {
    const { d, breach } = await blendRun('17');
    expect(await entry(d.runId, breach)).toMatchObject({ tier: 'ALERT', severity: 'ALERT', deviationRequired: false, blocking: false });
    await grantRole('operator1', 'QA_SHOP_FLOOR');
    const asQa = new RunDriver(sbx, d.runId, { operator1: await asPersonaInRole(sbx, 'operator1', 'QA_SHOP_FLOOR') });
    asQa.beforeTap = d.beforeTap;
    const involved = await asQa.sign('operator1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'NO_IMPACT', justification: 'Within the action limits' });
    expect(outcomeOf(involved.result)).toMatch(/EBMR-ESIG-044|EBMR-EXE-087|EBMR-EXE-163|ENG-SEGREGATION/);
    expect(await entry(d.runId, breach)).toMatchObject({ status: 'OPEN', dispositionedBy: null });
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'NO_IMPACT', justification: 'Within the action limits' });
    expect(await entry(d.runId, breach)).toMatchObject({ status: 'DISPOSITIONED', dispositionOutcome: 'NO_IMPACT', dispositionedBy: personaIn(sbx, 'qa1').personId });
    await inStep(d.runId);
  }, 300_000);

  it('[DI-26][INV-41][INV-03] QA review: a query is answered by another person, QA accepts only a dispositioned exception and only from outside the work, an escalation names its deviation, a concluded review takes no more acts, and no review closes an exception', async () => {
    const { d, breach } = await blendRun('17');
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', description: 'Blender room door found open', severity: 'ALERT' });
    const open = (await register(d.runId)).find((x) => x.exceptionType === 'OPERATOR_RAISED')?.exceptionId ?? '';
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'NO_IMPACT', justification: 'Within the action limits' });
    await grantRole('verifier1', 'QA_REVIEWER');
    await grantRole('qa1', 'QA_REVIEWER');
    const reviewer = await asPersonaInRole(sbx, 'verifier1', 'QA_REVIEWER');
    const disposer = await asPersonaInRole(sbx, 'qa1', 'QA_REVIEWER');
    const supervisor = d.browser('supervisor1');

    expect(await review(reviewer, 'verifier1', d.runId, open, 'ACCEPTED_BY_QA', null)).toMatch(/is still open; QA accepts an exception in review only after its disposition.*\[EBMR-EXE-164\]$/);
    expect(await codeOf(withCommand(sbx.db.app, await actorOf(sbx, supervisor, 'supervisor1'), (c) => execution.reviewException(c, d.runId, breach, 'QUERIED', 'Why no impact?')))).toMatch(/^EBMR-IAM-/);
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'QUERIED', '   ')).toMatch(/\[EBMR-EXE-164\]$/);
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'QUERIED', 'Why no impact on the blend?')).toBe('ok');
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'ACCEPTED_BY_QA', null)).toMatch(/has an open query.*\[EBMR-EXE-164\]$/);
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'QUERIED', 'And the speed?')).toMatch(/has an open query.*\[EBMR-EXE-164\]$/);
    expect(await review(supervisor, 'supervisor1', d.runId, breach, 'RESPONDED', 'The value is inside the action limits; the alert band is advisory')).toBe('ok');
    expect((await entry(d.runId, breach)).reviewState).toBe('RESPONDED');
    expect(await review(disposer, 'qa1', d.runId, breach, 'ACCEPTED_BY_QA', null)).toMatch(/cannot conclude its review \(INV-03, DI-26\)\. \[EBMR-EXE-165\]$/);
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'ACCEPTED_BY_QA', null)).toBe('ok');
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'ESCALATED', 'On second thought', 'TEST-DEV-0443')).toMatch(/already accepted by qa in review.*\[EBMR-EXE-164\]$/);
    expect(await entry(d.runId, breach)).toMatchObject({ status: 'DISPOSITIONED', reviewState: 'ACCEPTED_BY_QA' });

    expect(await review(reviewer, 'verifier1', d.runId, open, 'ESCALATED', 'Door left open during blending', ' ')).toMatch(/names the deviation it is escalated to.*\[EBMR-EXE-164\]$/);
    expect(await review(reviewer, 'verifier1', d.runId, open, 'ESCALATED', 'Door left open during blending', 'TEST-DEV-0443')).toBe('ok');
    expect(await entry(d.runId, open)).toMatchObject({ status: 'OPEN', reviewState: 'ESCALATED', escalatedTo: 'TEST-DEV-0443' });
    await inStep(d.runId);
  }, 300_000);

  it('[DI-26][INV-41] bypass: the application role cannot write the register, and a register the state left behind the triggers\' back stops the next row', async () => {
    const { d, breach } = await blendRun('17');
    for (const sql of [
      `insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, note, correlation_id) values ('${d.runId}', '${breach}', 'QUERIED', gen_random_uuid(), gen_random_uuid(), 'QA_REVIEWER', 'x', gen_random_uuid())`,
      `update recipe.exception_register set tier = null where batch_id = '${d.runId}'`,
      `delete from recipe.exception_register_act where batch_id = '${d.runId}'`,
    ]) {
      expect(await messageOf(sbx.db.app.query(sql))).toMatch(/permission denied/);
    }
    // The superuser cannot change a register row either (insert-only, audited).
    expect(await messageOf(sbx.db.admin.query(`update recipe.exception_register set tier = null where batch_id = '${d.runId}'`))).not.toBe('ok');

    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'NO_IMPACT', justification: 'Within the action limits' });
    // The disposition act removed behind the triggers' back: the state still says DISPOSITIONED, so the next row is refused.
    const client = await sbx.db.admin.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query("delete from recipe.exception_register_act where batch_id = $1 and exception_id = $2 and act = 'DISPOSITIONED'", [d.runId, breach]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const next = await d.command('supervisor1', { type: 'RAISE_EXCEPTION', description: 'Blender room door found open', severity: 'ALERT' });
    expect(JSON.stringify(next.ok ? 'ok' : next.error)).toMatch(/EBMR-EXE-161/);
    expect((await register(d.runId)).map((x) => x.exceptionType)).not.toContain('OPERATOR_RAISED');
  }, 300_000);
  it('[PR-08][PR-13] review finding 3: the QA roles of a QA-only disposition are the fixed quality-unit roles, not whatever the batch policy names: a policy naming the supervisor as QA does not let a supervisor disposition a registered-tier breach (EBMR-EXE-162)', async () => {
    const { d, breach } = await blendRun('25');
    await d.ok('qa1', { type: 'ATTACH_DEVIATION', exception: breach, deviationRef: 'TEST-DEV-0444' });
    // The application chose the batch policy at issue: here it counts the production supervisor as QA (policy and its
    // hash rewritten as the issuer could have pinned them), and the supervisor's kernel role holds a QA permission.
    const client = await sbx.db.admin.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update recipe.batch_execution set policy = jsonb_set(policy, '{qaRoles}', '["QA", "PRODUCTION_SUPERVISOR"]'::jsonb),
                policy_hash = recipe.canonical_hash(jsonb_set(policy, '{qaRoles}', '["QA", "PRODUCTION_SUPERVISOR"]'::jsonb)) where id = $1`,
        [d.runId],
      );
      await client.query("insert into iam.role_permission (role_code, permission_code) values ('SHIFT_SUPERVISOR', 'QA.FLOOR_APPROVE') on conflict do nothing");
      await client.query('commit');
    } finally {
      client.release();
    }
    const justification = 'Registration-relevant deviation TEST-DEV-0444 raised';
    const sup = d.browser('supervisor1');
    await withCommand(sbx.db.app, await actorOf(sbx, sup, 'supervisor1'), (c) => execution.proposeDisposition(c, d.runId, breach, { outcome: 'DEVIATION_RAISED', justification, deviationRef: 'TEST-DEV-0444' }));
    const p = await prepareSignature(sbx, sup, 'supervisor1', 'batch_exception', `${d.runId}:${breach}`, 'EXCEPTION_DISPOSITIONED');
    const who = personaIn(sbx, 'supervisor1').personId;
    const run = await runContext(sbx.db.admin, d.runId);
    const database = await messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        // The engine under the batch's pinned policy accepts it: the supervisor is one of that policy's QA roles.
        const pinned = { ...run.def, policy: { ...run.def.policy, qaRoles: ['QA', 'PRODUCTION_SUPERVISOR'] } };
        const tx = await execution.ExecutionTx.open(c, pinned, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'DISPOSITION_EXCEPTION', commandId: randomUUID(), actor: engineActor(who, roles), exception: breach, outcome: 'DEVIATION_RAISED', justification, signature: { id, meaning: 'EXCEPTION_DISPOSITIONED', signer: who } };
        return appendAs(tx, command, engineResult(tx, command), roles);
      }),
    );
    expect(database).toMatch(/is dispositioned only by QA.*\[EBMR-EXE-162\]$/);
    expect(await entry(d.runId, breach)).toMatchObject({ status: 'OPEN', dispositionedBy: null });
  }, 300_000);
});

describe('recipe.review_exception as Phase 6A re-creates it (recipe-core 1217; D-P7-1 item 4)', () => {
  it('[DI-26][INV-03][INV-41] review acts: an answer needs an open query and another person than the asker, in a role holding either answering permission; the raiser does not conclude; a disposition of another batch does not count; a blank note is stored as none', async () => {
    const { d, breach } = await blendRun('17');
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', description: 'Blender room door found open', severity: 'ALERT' });
    const open = (await register(d.runId)).find((x) => x.exceptionType === 'OPERATOR_RAISED')?.exceptionId ?? '';
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'NO_IMPACT', justification: 'Within the action limits' });
    await grantRole('verifier1', 'QA_REVIEWER');
    await grantRole('supervisor1', 'QA_REVIEWER');
    const reviewer = await asPersonaInRole(sbx, 'verifier1', 'QA_REVIEWER');
    // One session per person: the supervisor's QA session supersedes the supervisor's own, and the other way round.
    const asSupervisor = () => asPersonaInRole(sbx, 'supervisor1', 'SHIFT_SUPERVISOR');
    const asQa = () => asPersonaInRole(sbx, 'supervisor1', 'QA_REVIEWER');

    expect(await review(await asSupervisor(), 'supervisor1', d.runId, breach, 'RESPONDED', 'Nothing was asked yet')).toMatch(/has no open query to respond to \(DI-26\)\. \[EBMR-EXE-164\]$/);
    expect(await review(await asQa(), 'supervisor1', d.runId, breach, 'QUERIED', 'Why no impact on the blend?')).toBe('ok');
    expect(await review(await asSupervisor(), 'supervisor1', d.runId, breach, 'RESPONDED', 'Because the band is advisory')).toMatch(/asked the query on exception \S+ and cannot answer it too \(INV-03, DI-26\)\. \[EBMR-EXE-165\]$/);
    // The head of production holds RECORD.PRODUCTION_APPROVE, the second of RESPONDED's permissions, and not the first.
    expect(await review(await asPersonaInRole(sbx, 'head1', 'HEAD_OF_PRODUCTION'), 'head1', d.runId, breach, 'RESPONDED', 'The value is inside the action limits; the alert band is advisory')).toBe('ok');
    // The supervisor raised the door exception: as QA they do not conclude its review.
    expect(await review(await asQa(), 'supervisor1', d.runId, open, 'ESCALATED', 'Door left open during blending', 'TEST-DEV-0444')).toMatch(/cannot conclude its review \(INV-03, DI-26\)\. \[EBMR-EXE-165\]$/);
    expect(await review(reviewer, 'verifier1', d.runId, breach, 'ACCEPTED_BY_QA', '   ')).toBe('ok');
    expect((await sbx.db.admin.query("select note from recipe.exception_register_act where batch_id = $1 and exception_id = $2 and act = 'ACCEPTED_BY_QA'", [d.runId, breach])).rows).toEqual([{ note: null }]);
    // A second run raises the same exception id, not dispositioned there: the first run's disposition does not count.
    const e = await blendRun('17');
    expect(e.breach).toBe(breach);
    expect(await review(reviewer, 'verifier1', e.d.runId, e.breach, 'ACCEPTED_BY_QA', null)).toMatch(/is still open; QA accepts an exception in review only after its disposition.*\[EBMR-EXE-164\]$/);
  }, 300_000);
});
