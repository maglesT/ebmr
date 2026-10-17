/**
 * Review P22 (critical; INV-26, DI-17, DI-14, decision D4): the database accepts an engine role on a test-run
 * row only as the MAPPED role of the DECLARED kernel role (recipe.engine_role_map), backed by an authority
 * evaluation made in this command, at its time, in that declared role and at the actor's location
 * (recipe.check_engine_roles, recipe-core 0270). The application role (ebmr_sandbox here; ADR 0012: the rules hold
 * even with the application's database credentials) may call iam.evaluate_authority itself, so each forged
 * evidence below is built from a real, allowed evaluation; each has an honest control in the same set-up.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, toDbContext, withCommand } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import type pg from 'pg';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { dcMini, importAndIssue, personaIn, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const OTHER_SITE = 'TEST-SITE-ELSEWHERE';

/** 'ACCEPTED' when the command was stored as accepted, 'STORED-REFUSED' when stored as an engine refusal, else the error. */
async function outcomeOf(p: () => Promise<{ accepted: boolean }>): Promise<string> {
  try {
    const r = await p();
    return r.accepted ? 'ACCEPTED' : 'STORED-REFUSED';
  } catch (e) {
    return `REFUSED: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The error code a promise is rejected with (EBMR-XXX-NNN), or 'ok'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

/** Grants `roleCode` (in `scope`) to the persona's account: requested by the administrator, approved by the process owner. */
async function grantRole(key: string, roleCode: string, scope: { site?: string }): Promise<void> {
  const who = personaIn(sbx, key);
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: `P22: ${key} also holds ${roleCode}`, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope, reason: `P22 regression: ${key} also holds ${roleCode}` }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: `P22: approve ${roleCode} for ${key}`, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'P22 regression'));
}

/** An evaluation the application role makes itself, inside the command: iam.evaluate_authority is granted to it. */
async function evaluate(c: pg.PoolClient, who: { personId: string; accountId: string }, permission: string, scope: Record<string, string>, role: string | null, at = 'clock_timestamp()'): Promise<string> {
  const { rows } = await c.query<{ e: { allowed: boolean; evaluation_id: string; reasons: string[] } }>(
    `select iam.evaluate_authority($1::uuid, $2::uuid, $3, $4::jsonb, ${at}, $5) as e`,
    [who.personId, who.accountId, permission, JSON.stringify(scope), role],
  );
  const e = rows[0]?.e;
  if (!e?.allowed) throw new Error(`SETUP: the evaluation of ${permission} was not allowed: ${JSON.stringify(e)}`);
  return e.evaluation_id;
}

/** iam.evaluate_authority's whole answer, allowed or not (now, inside the command). */
async function evaluation(c: pg.PoolClient, who: { personId: string; accountId: string }, permission: string, scope: Record<string, string>, role: string | null): Promise<{ allowed: boolean; evaluation_id: string; role_code: string | null; reasons: string[] }> {
  const { rows } = await c.query<{ e: { allowed: boolean; evaluation_id: string; role_code: string | null; reasons: string[] } }>(
    'select iam.evaluate_authority($1::uuid, $2::uuid, $3, $4::jsonb, clock_timestamp(), $5) as e',
    [who.personId, who.accountId, permission, JSON.stringify(scope), role],
  );
  const e = rows[0]?.e;
  if (!e) throw new Error(`SETUP: no evaluation of ${permission}`);
  return e;
}

/** Each outcome against its pattern: the mismatches, with the outcome itself. */
function unmatched(outcomes: Readonly<Record<string, string>>, expected: Readonly<Record<string, RegExp>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, want] of Object.entries(expected)) {
    const got = outcomes[k] ?? '(no outcome)';
    if (!want.test(got)) out[k] = `${got} (expected ${String(want)})`;
  }
  return out;
}

async function newRun(): Promise<{ runId: string; issuer: TestBrowser; op: TestBrowser; run: Awaited<ReturnType<typeof runContext>> }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const op = await sbx.asPersona('operator1');
  return { runId, issuer, op, run: await runContext(sbx.db.admin, runId) };
}

describe('P22: engine roles only from the declared kernel role, at the actor\'s location, through the role map', () => {
  it('[INV-26][DI-17][D4] the database refuses engine roles backed by an evaluation of another role, another site or a shared permission', async () => {
    const { runId, op, run } = await newRun();

    // The steward also holds STAGE_RESPONSIBLE (never HEAD_OF_PRODUCTION); operator1 also holds SHIFT_SUPERVISOR,
    // but only at another site.
    await grantRole('steward', 'STAGE_RESPONSIBLE', {});
    await grantRole('operator1', 'SHIFT_SUPERVISOR', { site: OTHER_SITE });
    const steward = personaIn(sbx, 'steward');
    const me = personaIn(sbx, 'operator1');
    const held = await sbx.db.admin.query<{ role_code: string }>(
      `select g.role_code from iam.role_grant g where g.account_id = $1 and g.status = 'APPROVED' and g.revoked_at is null order by 1`,
      [steward.accountId],
    );
    expect(held.rows.map((r) => r.role_code)).not.toContain('HEAD_OF_PRODUCTION');

    // (a) Declared STAGE_RESPONSIBLE in the office; the one evaluation tab.engine_roles() made (RECORD.PRODUCTION_APPROVE
    //     in role STAGE_RESPONSIBLE) is also presented as engine role HEAD_OF_PRODUCTION (the permission is shared).
    const office = await openPersonaSession(sbx.db, sbx.seed, 'steward');
    const raise = (forge: boolean) =>
      withCommand(sbx.db.app, { ...office, roleCode: 'STAGE_RESPONSIBLE', correlationId: randomUUID() }, async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const real = await engineRoles(c);
        if (real.map((e) => `${e.role}/${e.permission}`).join() !== 'STAGE_RESPONSIBLE/RECORD.PRODUCTION_APPROVE') throw new Error(`SETUP: unexpected evidence ${JSON.stringify(real)}`);
        const evidence = forge ? [...real, ...real.map((e) => ({ ...e, role: 'HEAD_OF_PRODUCTION' }))] : real;
        return tx.command({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: engineActor(steward.personId, evidence), description: 'Tablet press noise heard during the regression test', severity: 'ALERT' }, evidence);
      });
    const controlA = await outcomeOf(() => raise(false));
    const forgedA = await outcomeOf(() => raise(true));

    // (b) Declared OPERATOR on the dispensing kiosk (fresh badge tap); the application role evaluates STEP.SUPERVISE
    //     itself, with no role filter and the other site's scope, and presents it as engine role PRODUCTION_SUPERVISOR.
    const start = async (forge: boolean) =>
      withCommand(sbx.db.app, await actorOfBrowser(sbx, op, 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const real = await engineRoles(c);
        const evidence: execution.RoleEvidence[] = forge ? [...real, { role: 'PRODUCTION_SUPERVISOR', permission: 'STEP.SUPERVISE', evaluationId: await evaluate(c, me, 'STEP.SUPERVISE', { site: OTHER_SITE }, null) }] : real;
        return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, evidence), step: 'p-disp-clear', context: [] }, evidence);
      });
    const forgedB = await outcomeOf(() => start(true));
    const controlB = await outcomeOf(() => start(false));

    // The honest commands of the same set-up are accepted (so a refusal of a forged one is due to its evidence).
    expect(controlA).toBe('ACCEPTED');
    expect(controlB).toMatch(/^(ACCEPTED|STORED-REFUSED)$/);
    expect(forgedA).not.toMatch(/SETUP:/);
    expect(forgedB).not.toMatch(/SETUP:/);

    const { rows } = await sbx.db.admin.query<{ seq: string; command_type: string; accepted: boolean; roles: execution.RoleEvidence[] }>(
      'select seq::text as seq, command_type, accepted, roles from recipe.execution_command where batch_id = $1 order by seq',
      [runId],
    );
    const forgedRows = rows
      .filter((r) => (r.roles ?? []).some((e) => e.role === 'HEAD_OF_PRODUCTION' || e.role === 'PRODUCTION_SUPERVISOR'))
      .map((r) => ({ seq: r.seq, type: r.command_type, accepted: r.accepted, roles: r.roles.map((e) => `${e.role}/${e.permission}`) }));

    // (a) passes the evaluation checks (made in the declared role at the location) and fails on the role map;
    // (b) was evaluated in no role at all.
    expect(forgedA, 'declared STAGE_RESPONSIBLE, claims HEAD_OF_PRODUCTION through the STAGE_RESPONSIBLE evaluation').toMatch(/^REFUSED: .*does not carry engine role HEAD_OF_PRODUCTION.*\[EBMR-EXE-035\]/);
    expect(forgedB, 'declared OPERATOR, claims PRODUCTION_SUPERVISOR through an evaluation with no role filter at another site').toMatch(/^REFUSED: .*not in the declared role OPERATOR.*\[EBMR-EXE-036\]/);
    expect(forgedRows, 'stored rows whose engine-role evidence was not evaluated in the declared role at the actor\'s location').toEqual([]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-26][DI-17] an evaluation in the declared role is refused when it was made for another scope than the actor\'s location or for an earlier instant', async () => {
    const { runId, op, run } = await newRun();
    const me = personaIn(sbx, 'operator1');
    const attempt = (forge: 'none' | 'scope' | 'instant') =>
      outcomeOf(async () => {
        vi.advanceTimersByTime(7_000);
        const actor = await actorOfBrowser(sbx, op, 'operator1');
        const { rows } = await sbx.db.admin.query<{ site_code: string | null; room_code: string | null }>('select site_code, room_code from iam.session where id = $1', [actor.sessionId]);
        const session = rows[0];
        if (!session?.site_code || !session.room_code) throw new Error(`SETUP: the kiosk session has no site and room: ${JSON.stringify(session)}`);
        const location = { site: session.site_code, area: session.room_code };
        return withCommand(sbx.db.app, actor, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          const real = await engineRoles(c);
          if (real.map((e) => `${e.role}/${e.permission}`).join() !== 'PRODUCTION_OPERATOR/STEP.EXECUTE') throw new Error(`SETUP: unexpected evidence ${JSON.stringify(real)}`);
          // Same person, account, permission, declared role and command: only the scope or the instant differs.
          const evidence: execution.RoleEvidence[] =
            forge === 'none'
              ? real
              : [{ role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId: forge === 'scope' ? await evaluate(c, me, 'STEP.EXECUTE', {}, 'OPERATOR') : await evaluate(c, me, 'STEP.EXECUTE', location, 'OPERATOR', "now() - interval '2 seconds'") }];
          return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, evidence), step: 'p-disp-clear', context: [] }, evidence);
        });
      });
    const scope = await attempt('scope');
    const instant = await attempt('instant');
    const control = await attempt('none');
    expect(control).toBe('ACCEPTED');
    expect(scope).toMatch(/^REFUSED: .*not at the actor's location.*\[EBMR-EXE-036\]/);
    expect(instant).toMatch(/^REFUSED: .*not for the time of this command.*\[EBMR-EXE-036\]/);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-26][DI-17][IN-04] past the server, an engine-role evaluation at the actor\'s location with the batch\'s own product is accepted, and one with another product is refused (6jc-R16; recipe-core 1100)', async () => {
    const { runId, op, run } = await newRun();
    const me = personaIn(sbx, 'operator1');
    const product = (await sbx.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p;
    if (!product) throw new Error('SETUP: the run names no product');
    const attempt = (forge: 'own' | 'other') =>
      outcomeOf(async () => {
        vi.advanceTimersByTime(7_000);
        const actor = await actorOfBrowser(sbx, op, 'operator1');
        const { rows } = await sbx.db.admin.query<{ site_code: string | null; room_code: string | null }>('select site_code, room_code from iam.session where id = $1', [actor.sessionId]);
        const session = rows[0];
        if (!session?.site_code || !session.room_code) throw new Error(`SETUP: the kiosk session has no site and room: ${JSON.stringify(session)}`);
        const location = { site: session.site_code, area: session.room_code };
        return withCommand(sbx.db.app, actor, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          // An evaluation the application role made itself in the declared role at the location, with the batch's own
          // product or with another product (the server's own evidence on a batch, tablets 1320, is the first).
          const evidence: execution.RoleEvidence[] = [
            { role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId: await evaluate(c, me, 'STEP.EXECUTE', { ...location, product: forge === 'own' ? product : `${product}-OTHER` }, 'OPERATOR') },
          ];
          return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, evidence), step: 'p-disp-clear', context: [] }, evidence);
        });
      });
    const other = await attempt('other');
    expect(other).toMatch(/^REFUSED: .*not at the actor's location .*on this batch.*\[EBMR-EXE-036\]/);
    expect(await attempt('own')).toBe('ACCEPTED');
    const { rows: scoped } = await sbx.db.admin.query<{ scope: Record<string, string> }>(
      "select e.scope from recipe.execution_command k cross join lateral jsonb_array_elements(k.roles) r join iam.authority_evaluation e on e.id = (r ->> 'evaluationId')::uuid where k.batch_id = $1 and k.kind = 'COMMAND' and k.accepted",
      [runId],
    );
    expect(scoped.map((r) => r.scope['product'])).toEqual([product]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-26][DI-17][D4] a real stored evaluation is refused when it did not allow the permission, was made for another person, evaluated another permission or was made in an earlier command of the same transaction; nothing is recorded', async () => {
    // Review F19: every other INV-26 test presents made-up evaluation ids, refused because they do not exist. Here each
    // forged evidence names a real evaluation the application role stored itself, inside the transaction, in the
    // declared role OPERATOR at the kiosk's location; it differs from an honest one in one respect only.
    const { runId, op, run } = await newRun();
    const me = personaIn(sbx, 'operator1');
    const other = personaIn(sbx, 'operator2');
    const { rows: perms } = await sbx.db.admin.query<{ p: string }>(
      "select permission_code as p from iam.role_permission where role_code = 'OPERATOR' and removed_at is null and permission_code <> 'STEP.EXECUTE' order by 1 limit 1",
    );
    const otherPermission = perms[0]?.p;
    if (!otherPermission) throw new Error('SETUP: OPERATOR holds no permission besides STEP.EXECUTE');
    const rows0 = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_command where batch_id = $1', [runId]);
    type Forge = 'none' | 'denied' | 'otherPerson' | 'otherPermission' | 'otherCommand';
    const attempt = (forge: Forge) =>
      outcomeOf(async () => {
        vi.advanceTimersByTime(7_000);
        const actor = await actorOfBrowser(sbx, op, 'operator1');
        const { rows } = await sbx.db.admin.query<{ site_code: string | null; room_code: string | null }>('select site_code, room_code from iam.session where id = $1', [actor.sessionId]);
        const session = rows[0];
        if (!session?.site_code || !session.room_code) throw new Error(`SETUP: the kiosk session has no site and room: ${JSON.stringify(session)}`);
        const location = { site: session.site_code, area: session.room_code };
        // The second command's tap is taken before the transaction opens (a tap inside it would wait on its locks).
        vi.advanceTimersByTime(7_000);
        const second = forge === 'otherCommand' ? await actorOfBrowser(sbx, op, 'operator1') : undefined;
        return withCommand(sbx.db.app, actor, async (c) => {
          const real = await engineRoles(c);
          if (real.map((e) => `${e.role}/${e.permission}`).join() !== 'PRODUCTION_OPERATOR/STEP.EXECUTE') throw new Error(`SETUP: unexpected evidence ${JSON.stringify(real)}`);
          let evaluationId = real[0]?.evaluationId ?? '';
          if (forge === 'denied') {
            // operator1 with operator2's account: the account's OPERATOR grant matches (so the evaluation names the role
            // OPERATOR), but the account is not operator1's, so the kernel denies it.
            const e = await evaluation(c, { personId: me.personId, accountId: other.accountId }, 'STEP.EXECUTE', location, 'OPERATOR');
            if (e.allowed || e.role_code !== 'OPERATOR') throw new Error(`SETUP: expected a denial in role OPERATOR: ${JSON.stringify(e)}`);
            evaluationId = e.evaluation_id;
          } else if (forge === 'otherPerson') {
            evaluationId = await evaluate(c, other, 'STEP.EXECUTE', location, 'OPERATOR');
          } else if (forge === 'otherPermission') {
            evaluationId = await evaluate(c, me, otherPermission, location, 'OPERATOR');
          } else if (forge === 'otherCommand') {
            // operator1's own evaluation from tab.engine_roles() above; then another command begins in this transaction.
            await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(second ?? actor))]);
          }
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          const evidence: execution.RoleEvidence[] = [{ role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId }];
          return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, evidence), step: 'p-disp-clear', context: [] }, evidence);
        });
      });
    const outcomes: Record<string, string> = {};
    for (const f of ['denied', 'otherPerson', 'otherPermission', 'otherCommand'] as const) outcomes[f] = await attempt(f);
    const refused = (why: string) => new RegExp(`^REFUSED: Engine role PRODUCTION_OPERATOR is not backed by an allowed authority evaluation of STEP\\.EXECUTE .*: evaluation [0-9a-f-]{36} ${why} \\(INV-26, D4\\)\\. \\[EBMR-EXE-036\\]`);
    expect(
      unmatched(outcomes, {
        denied: refused('did not allow it'),
        otherPerson: refused('was made for another person or account'),
        otherPermission: refused(`evaluated ${otherPermission.replace('.', '\\.')}`),
        otherCommand: refused('was made in another command'),
      }),
    ).toEqual({});
    expect((await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_command where batch_id = $1', [runId])).rows[0]?.n).toBe(rows0.rows[0]?.n);
    // The honest command of the same set-up is accepted (so each refusal is due to its evidence).
    expect(await attempt('none')).toBe('ACCEPTED');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-26][DI-17][D4] the database\'s evaluation check names each mismatch: no evaluation id, an unknown one, another person or another account alone, another command', async () => {
    // recipe.role_evaluation_problem (private to the owner; called here by the superuser) on a real allowed evaluation of
    // operator1, against the validated actor of the command it was made in with one field changed. An allowed
    // evaluation is always of an account of its person, so "another account of the same person" can only be shown here.
    const { op } = await newRun();
    const me = personaIn(sbx, 'operator1');
    vi.advanceTimersByTime(7_000);
    const made = await withCommand(sbx.db.app, await actorOfBrowser(sbx, op, 'operator1'), async (c) => {
      const real = await engineRoles(c);
      const actor = (await c.query<{ a: Record<string, unknown> }>('select kernel.current_actor() as a')).rows[0]?.a;
      return { evaluationId: real[0]?.evaluationId ?? '', actor };
    });
    if (!made.actor || !made.evaluationId) throw new Error(`SETUP: no evaluation or actor: ${JSON.stringify(made)}`);
    expect(made.actor).toMatchObject({ person_id: me.personId, account_id: me.accountId, role_code: 'OPERATOR' });
    const problem = async (actor: Record<string, unknown>, evaluationId: string | null) =>
      (await sbx.db.admin.query<{ p: string | null }>('select recipe.role_evaluation_problem($1::jsonb, $2, $3::uuid) as p', [JSON.stringify(actor), 'STEP.EXECUTE', evaluationId])).rows[0]?.p ?? null;
    const id = made.evaluationId;
    const unknown = randomUUID();
    expect({
      noId: await problem(made.actor, null),
      unknown: await problem(made.actor, unknown),
      otherPerson: await problem({ ...made.actor, person_id: randomUUID() }, id),
      otherAccount: await problem({ ...made.actor, account_id: randomUUID() }, id),
      otherCommand: await problem({ ...made.actor, correlation_id: randomUUID() }, id),
    }).toEqual({
      noId: 'no stored evaluation is named',
      unknown: `evaluation ${unknown} does not exist`,
      otherPerson: `evaluation ${id} was made for another person or account`,
      otherAccount: `evaluation ${id} was made for another person or account`,
      otherCommand: `evaluation ${id} was made in another command`,
    });
  }, 300_000);

  it('[INV-26][DI-17][D4] both forms of the evaluation check (location only, and on a batch) refuse another account of the same person, an evaluation of an earlier instant and one made in no role (6jc-R16; mutation triage)', async () => {
    // recipe.role_evaluation_problem(actor, permission, evaluation) still serves the batch issue; the 4-argument form of
    // recipe-core 1100 serves the step commands. Both are private to the owner and called here by the superuser.
    const { runId, op } = await newRun();
    const me = personaIn(sbx, 'operator1');
    vi.advanceTimersByTime(7_000);
    const made = await withCommand(sbx.db.app, await actorOfBrowser(sbx, op, 'operator1'), async (c) => {
      const real = await engineRoles(c);
      const actor = (await c.query<{ a: Record<string, unknown> }>('select kernel.current_actor() as a')).rows[0]?.a;
      return { evaluationId: real[0]?.evaluationId ?? '', actor };
    });
    if (!made.actor || !made.evaluationId) throw new Error(`SETUP: no evaluation or actor: ${JSON.stringify(made)}`);
    const both = async (q: (text: string, args: unknown[]) => Promise<{ rows: { p: string | null }[] }>, actor: Record<string, unknown>, evaluationId: string) => ({
      location: (await q('select recipe.role_evaluation_problem($1::jsonb, $2, $3::uuid) as p', [JSON.stringify(actor), 'STEP.EXECUTE', evaluationId])).rows[0]?.p ?? null,
      batch: (await q('select recipe.role_evaluation_problem($1::jsonb, $2, $3::uuid, $4::uuid) as p', [JSON.stringify(actor), 'STEP.EXECUTE', evaluationId, runId])).rows[0]?.p ?? null,
    });
    const asSuperuser = (text: string, args: unknown[]) => sbx.db.admin.query<{ p: string | null }>(text, args);
    const id = made.evaluationId;
    // Another account of the same person (the person matches, only the account differs).
    const otherAccount = `evaluation ${id} was made for another person or account`;
    expect(await both(asSuperuser, { ...made.actor, account_id: randomUUID() }, id)).toEqual({ location: otherAccount, batch: otherAccount });
    // The command that made it has ended: asked in a later transaction, its instant is before this one's start.
    const earlier = await both(asSuperuser, made.actor, id);
    expect(earlier.location).toMatch(new RegExp(`^evaluation ${id} was made for .*, not for the time of this command$`));
    expect(earlier.batch).toMatch(new RegExp(`^evaluation ${id} was made for .*, not for the time of this command$`));
    // An allowed evaluation made now, in this transaction, for the same person and account but in no role: refused for
    // the role, whatever role it matched (its role code is the declared role).
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      const { rows } = await c.query<{ e: { allowed: boolean; evaluation_id: string } }>(
        'select iam.evaluate_authority($1::uuid, $2::uuid, $3, (select scope from iam.authority_evaluation where id = $4), clock_timestamp(), null) as e',
        [me.personId, me.accountId, 'STEP.EXECUTE', id],
      );
      const e = rows[0]?.e;
      if (!e?.allowed) throw new Error(`SETUP: the evaluation in no role was not allowed: ${JSON.stringify(e)}`);
      const ev = (await c.query<{ role_filter: string | null; role_code: string | null; correlation_id: string | null }>(
        'select role_filter, role_code, correlation_id::text from iam.authority_evaluation where id = $1', [e.evaluation_id])).rows[0];
      if (ev?.role_filter !== null || ev.role_code !== made.actor['role_code']) throw new Error(`SETUP: expected no role filter and the declared role: ${JSON.stringify(ev)}`);
      const noRole = `evaluation ${e.evaluation_id} was made in role any role, not in the declared role ${String(made.actor['role_code'])}`;
      expect(await both((text, args) => c.query<{ p: string | null }>(text, args), { ...made.actor, correlation_id: ev.correlation_id }, e.evaluation_id))
        .toEqual({ location: noRole, batch: noRole });
    } finally {
      await c.query('rollback');
      c.release();
    }
  }, 300_000);

  it('[INV-26][D4] role evidence that names one engine role twice, with the same evaluation or with a second one, is refused (EBMR-EXE-035)', async () => {
    const { runId, op, run } = await newRun();
    const me = personaIn(sbx, 'operator1');
    const attempt = (forge: 'none' | 'sameEvaluation' | 'secondEvaluation') =>
      outcomeOf(async () => {
        vi.advanceTimersByTime(7_000);
        const actor = await actorOfBrowser(sbx, op, 'operator1');
        const { rows } = await sbx.db.admin.query<{ site_code: string | null; room_code: string | null }>('select site_code, room_code from iam.session where id = $1', [actor.sessionId]);
        const session = rows[0];
        if (!session?.site_code || !session.room_code) throw new Error(`SETUP: the kiosk session has no site and room: ${JSON.stringify(session)}`);
        return withCommand(sbx.db.app, actor, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          const real = await engineRoles(c);
          if (real.map((e) => `${e.role}/${e.permission}`).join() !== 'PRODUCTION_OPERATOR/STEP.EXECUTE') throw new Error(`SETUP: unexpected evidence ${JSON.stringify(real)}`);
          // Each piece of evidence alone passes every other check: an allowed evaluation of STEP.EXECUTE made in this
          // command, now, in the declared role OPERATOR at the kiosk's location, mapped to PRODUCTION_OPERATOR.
          const evidence: execution.RoleEvidence[] =
            forge === 'none'
              ? real
              : forge === 'sameEvaluation'
                ? [...real, ...real]
                : [...real, { role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId: await evaluate(c, me, 'STEP.EXECUTE', { site: session.site_code ?? '', area: session.room_code ?? '' }, 'OPERATOR') }];
          return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, evidence), step: 'p-disp-clear', context: [] }, evidence);
        });
      });
    // Each forgery is judged before the next attempt: an accepted one would start the step, and every later
    // attempt would then be refused by the engine instead of by the rule under test.
    expect(await attempt('sameEvaluation'), 'the same evaluation twice').toMatch(/^REFUSED: .*names engine role PRODUCTION_OPERATOR or evaluation \S+ twice.*\[EBMR-EXE-035\]/);
    expect(await attempt('secondEvaluation'), 'a second evaluation for the same role').toMatch(/^REFUSED: .*names engine role PRODUCTION_OPERATOR or evaluation \S+ twice.*\[EBMR-EXE-035\]/);
    expect(await attempt('none')).toBe('ACCEPTED');
    const { rows } = await sbx.db.admin.query<{ n: string }>(
      "select count(*)::text as n from recipe.execution_command where batch_id = $1 and jsonb_array_length(roles) > (select count(distinct e ->> 'role') from jsonb_array_elements(roles) e)",
      [runId],
    );
    expect(rows[0]?.n, 'stored rows whose evidence names a role twice').toBe('0');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-26][DI-14][D4] an issue request that gives the issuer an engine role without evidence is refused; an honest issue stores its evidence', async () => {
    const { run, issuer } = await newRun();
    const who = personaIn(sbx, 'issuer');
    const issueWith = (roles: string[]) =>
      (async () => {
        const actor = await actorOfBrowser(sbx, issuer, 'issuer');
        const batchId = randomUUID();
        await withCommand(sbx.db.app, actor, async (c) => {
          const evidence = await engineRoles(c);
          if (evidence.length !== 0) throw new Error(`SETUP: the issuer's declared role carries engine roles ${JSON.stringify(evidence)}`);
          await execution.issueBatch(c, {
            def: run.def,
            batchId,
            packageHash: run.batch.packageHash,
            request: { batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {}, inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'Keyed at issue for this regression test' } }, issuedBy: { id: who.personId, kind: 'PERSON', roles } },
          });
        });
        return batchId;
      })();
    expect(await codeOf(issueWith(['QA_REVIEWER']))).toBe('EBMR-EXE-037');
    expect(await codeOf(issueWith(['PRODUCTION_SUPERVISOR', 'QA']))).toBe('EBMR-EXE-037');
    const honest = await issueWith([]);
    const { rows } = await sbx.db.admin.query<{ roles: unknown }>("select roles from recipe.execution_command where batch_id = $1 and kind = 'ISSUE'", [honest]);
    expect(rows).toEqual([{ roles: [] }]);
    const forged = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.batch_execution where issue_request -> 'issuedBy' -> 'roles' <> '[]'::jsonb");
    expect(forged.rows[0]?.n).toBe('0');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[D4][INV-26][DI-17] the database\'s role map is decision D4, holds every mapping the edition offers, and only a release changes it', async () => {
    const { rows } = await sbx.db.admin.query<{ kernel_role: string; engine_role: string; via_permission: string }>(
      'select kernel_role, engine_role, via_permission from recipe.engine_role_map order by kernel_role, engine_role',
    );
    expect(rows.map((r) => `${r.kernel_role}>${r.engine_role}/${r.via_permission}`)).toEqual([
      'DISPENSER>DISPENSER/DISPENSE.EXECUTE',
      'HEAD_OF_PRODUCTION>HEAD_OF_PRODUCTION/RECORD.PRODUCTION_APPROVE',
      'OPERATOR>PRODUCTION_OPERATOR/STEP.EXECUTE',
      'QA_REVIEWER>QA_REVIEWER/RECORD.QA_REVIEW',
      'QA_SHOP_FLOOR>QA/QA.FLOOR_APPROVE',
      'SHIFT_SUPERVISOR>PRODUCTION_SUPERVISOR/STEP.SUPERVISE',
      'STAGE_RESPONSIBLE>STAGE_RESPONSIBLE/RECORD.PRODUCTION_APPROVE',
      'VERIFIER>PRODUCTION_VERIFIER/STEP.VERIFY',
    ]);
    // The edition's map (what tab.engine_roles() evaluates) names no mapping the database would refuse.
    const missing = await sbx.db.admin.query<{ kernel_role: string }>(
      `select t.kernel_role from tab.engine_role_map t
        where not exists (select 1 from recipe.engine_role_map m where m.kernel_role = t.kernel_role and m.engine_role = t.engine_role and m.via_permission = t.via_permission)`,
    );
    expect(missing.rows).toEqual([]);
    // The application role reads the map and the signature meanings, and never changes them.
    for (const [t, c] of [
      ['recipe.engine_role_map', 'kernel_role'],
      ['recipe.execution_signature_meaning', 'command_type'],
    ] as const) {
      expect(Number((await sbx.db.app.query<{ n: string }>(`select count(*)::text as n from ${t}`)).rows[0]?.n)).toBeGreaterThan(0);
      for (const sql of [`insert into ${t} default values`, `update ${t} set ${c} = ${c}`, `delete from ${t}`]) {
        expect(await codeOf(sbx.db.app.query(sql)), sql).toMatch(/permission denied/);
      }
    }
  }, 120_000);
});
