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
import { identity, withCommand } from '@ebmr/kernel';
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
        return tx.command({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: engineActor(steward.personId, evidence), description: 'P22: tablet press noise', severity: 'ALERT' }, evidence);
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
            request: { batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {}, inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'P22 regression' } }, issuedBy: { id: who.personId, kind: 'PERSON', roles } },
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
