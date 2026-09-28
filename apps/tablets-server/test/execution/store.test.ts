/**
 * The execution store's own controls, below the HTTP layer (module C3; plan section 7): what the database
 * refuses however it is called (DI-05, INV-03, INV-16, INV-18, INV-26, INV-40), the application role's lack of
 * write privileges, and the engine-role map (decision D4).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { tokenHash, newSessionToken } from '../../src/platform/auth/session.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { dcMini, importAndIssue, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
let gmp: TestServer;
beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startExecServer(), startServer('GMP')]);
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await Promise.all([sbx?.close(), gmp?.close()]);
});

const CLEAR = 'p-disp-clear@';

/** The error code a promise is rejected with (EBMR-XXX-NNN or ENG-...). */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

async function newRun(): Promise<{ runId: string; op: TestBrowser; d: RunDriver }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const op = await sbx.asPersona('operator1');
  const d = new RunDriver(sbx, runId, { issuer, operator1: op });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return { runId, op, d };
}

/** One command as the browser's own session (a fresh badge tap on the kiosk). */
async function asOperator<T>(op: TestBrowser, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withCommand(sbx.db.app, await actorOfBrowser(sbx, op, 'operator1'), work);
}

describe('installation (DI-05, INV-18)', () => {
  it('[INV-18][DI-05] a GMP database refuses importing packages and issuing test batches; anything that lands there anyway is reported', async () => {
    const author = { ...(await openPersonaSession(gmp.db, gmp.seed, 'author')), correlationId: randomUUID() };
    const pkg = execution.buildTestPackage({
      source: { installationKind: 'GMP', watermark: null },
      family: { familyId: randomUUID(), familyCode: 'PCM500-DC', product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' } },
      version: { versionId: randomUUID(), number: '1', revision: 1, state: 'APPROVED' },
      content: dcMini(),
      justifications: [],
      exporter: { personId: randomUUID(), legalName: 'Asha Rao', loginName: 'asha.rao' },
      exportedAtUs: '1790581503000000',
    });
    expect(await codeOf(withCommand(gmp.db.app, author, (c) => execution.importTestPackage(c, pkg, `${pkg.packageHash}.json`)))).toBe('EBMR-SBX-011');
    expect(await codeOf(withCommand(gmp.db.app, { ...author, correlationId: randomUUID() }, (c) => execution.beginIssue(c, randomUUID())))).toBe('EBMR-SBX-011');
    // A package holding SANDBOX_ONLY blocks copied into GMP behind the writers' back (a restore, a hand edit): reported.
    const admin = await gmp.db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                          revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
         values ($1, $1 || '.json', $2::jsonb, $3::jsonb, $4, gen_random_uuid(), 'PCM500-DC', '{}', gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
                 gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [pkg.packageHash, JSON.stringify(pkg), JSON.stringify(pkg.content), pkg.contentHash],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const problems = (await execution.executionViolations(gmp.db.admin)).map((v) => v.problem);
    expect(problems.some((p) => p.includes('exists in a GMP database'))).toBe(true);
    expect(problems.some((p) => p.includes('SANDBOX_ONLY block G-09@1'))).toBe(true);
    expect(problems.some((p) => p.includes('SANDBOX_ONLY block G-10@1'))).toBe(true);
  }, 180_000);

  it('[INV-18][DI-05] the sandbox refuses a batch number that is not TEST- and one not allocated in the issuing transaction', async () => {
    const { runId } = await newRun();
    const insert = sbx.db.admin.query(
      `insert into recipe.batch_execution select (jsonb_populate_record(null::recipe.batch_execution, to_jsonb(b) || jsonb_build_object('id', gen_random_uuid(), 'batch_number', 'B26-0001'))).*
         from recipe.batch_execution b where b.id = $1`,
      [runId],
    );
    expect(await codeOf(insert)).toBe('EBMR-SBX-022');
    const issuer = await sbx.asPersona('issuer');
    const actor = await actorOfBrowser(sbx, issuer, 'issuer');
    const run = await runContext(sbx.db.admin, runId);
    const batchId = randomUUID();
    const attempt = withCommand(sbx.db.app, actor, async (c) => {
      const begun = await execution.beginIssue(c, batchId);
      const r = engine.issue(run.def, { batchId, batchNumber: 'B26-0001', batchSize: 'BS-100K', marketSet: ['IN'], inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'test' } }, issuedBy: engineActor(actor.personId, []) }, { nowUs: begun.nowUs });
      await execution.issueExecution(c, { batchId, packageHash: run.batch.packageHash, batchNumber: 'B26-0001', request: execution.encode({}), policy: execution.pinnedPolicy(run.def.policy), registryFingerprint: run.def.registry.fingerprint(), engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state: r.state, events: r.events, contents: [] });
    });
    expect(await codeOf(attempt)).toBe('EBMR-EXE-012');
  }, 180_000);
});

describe('the append path', () => {
  it('[INV-40] a command on a kiosk needs the tap; a row that does not carry the tap this command consumed is refused even when written directly', async () => {
    const { runId, op } = await newRun();
    const noTap = { ...(await actorOfBrowser(sbx, op, 'operator1')) };
    delete (noTap as { authEventId?: string }).authEventId;
    expect(await codeOf(withCommand(sbx.db.app, noTap, (c) => execution.lockExecution(c, runId)))).toBe('EBMR-IAM-120');
    // Written directly by a superuser inside a properly attributed command: the constraint trigger still refuses.
    for (const authEvent of [null, randomUUID()]) {
      const raw = withCommand(sbx.db.admin, await actorOfBrowser(sbx, op, 'operator1'), (c) =>
        c.query(
          `insert into recipe.execution_command select (jsonb_populate_record(null::recipe.execution_command, to_jsonb(k) ||
             jsonb_build_object('seq', 99, 'kind', 'COMMAND', 'command_id', 'RAW:' || gen_random_uuid(), 'device_class', 'SHARED', 'auth_event_id', $2::uuid))).*
             from recipe.execution_command k where k.batch_id = $1 and k.seq = 1`,
          [runId, authEvent],
        ),
      );
      expect(await codeOf(raw)).toBe('EBMR-EXE-040');
    }
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);

  it('[INV-16] the engine must run at the trusted time the lock took: another clock, or no lock, is refused', async () => {
    const { runId, op } = await newRun();
    const run = await runContext(sbx.db.admin, runId);
    const attempt = (skew: bigint, lock: boolean) =>
      asOperator(op, async (c) => {
        const tx = lock ? await execution.ExecutionTx.open(c, run.def, runId) : undefined;
        const st = tx?.state ?? (await execution.loadState(c, runId))?.state;
        const seq = tx?.lastSeq ?? 1n;
        if (!st) throw new Error('no state');
        const roles = await engineRoles(c);
        const nowUs = (tx?.nowUs ?? 1_790_000_000_000_000n) + skew;
        const r = engine.step(run.def, st, { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(personIn('operator1').personId, roles), step: 'p-disp-clear' }, { nowUs });
        await execution.appendExecution(c, { batchId: runId, expectedSeq: seq, kind: 'COMMAND', command: execution.encode({}), commandId: randomUUID(), nowUs, accepted: r.accepted, refusal: r.refusal, state: r.state, events: r.events, roles, contents: [] });
      });
    expect(await codeOf(attempt(-1n, true))).toBe('EBMR-EXE-021');
    expect(await codeOf(attempt(0n, false))).toBe('EBMR-EXE-021');
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);

  it('[INV-26] engine roles come from authority evaluations stored in the same command, never from the caller', async () => {
    const { runId, op } = await newRun();
    const run = await runContext(sbx.db.admin, runId);
    const me = personIn('operator1');
    const start = (roles: string[], evidence: execution.RoleEvidence[] | 'real') =>
      asOperator(op, async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const ev = evidence === 'real' ? await engineRoles(c) : evidence;
        const actor = evidence === 'real' ? engineActor(me.personId, ev) : { id: me.personId, kind: 'PERSON' as const, roles };
        return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [] }, ev);
      });
    expect(await codeOf(start(['QA'], [{ role: 'QA', permission: 'QA.FLOOR_APPROVE', evaluationId: randomUUID() }]))).toBe('EBMR-EXE-036');
    expect(await codeOf(start(['PRODUCTION_OPERATOR'], [{ role: 'PRODUCTION_OPERATOR', permission: 'QA.FLOOR_APPROVE', evaluationId: randomUUID() }]))).toBe('EBMR-EXE-035');
    expect(await codeOf(start(['PRODUCTION_SUPERVISOR'], []))).toBe('EBMR-EXE-037');
    const ok = await start([], 'real');
    expect(ok.accepted).toBe(true);
    const { rows } = await sbx.db.admin.query<{ roles: execution.RoleEvidence[]; correlation_id: string }>('select roles, correlation_id from recipe.execution_command where batch_id = $1 order by seq desc limit 1', [runId]);
    const evidence = rows[0]?.roles ?? [];
    expect(evidence.map((e) => [e.role, e.permission])).toEqual([['PRODUCTION_OPERATOR', 'STEP.EXECUTE']]);
    const stored = await sbx.db.admin.query<{ allowed: boolean; person_id: string; correlation_id: string }>('select allowed, person_id, correlation_id from iam.authority_evaluation where id = $1', [evidence[0]?.evaluationId]);
    expect(stored.rows[0]).toMatchObject({ allowed: true, person_id: me.personId, correlation_id: rows[0]?.correlation_id });
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);

  it('[INV-03] a fabricated accepted VERIFY by a person who entered data in the step is refused by the database', async () => {
    const { runId, d } = await newRun();
    // A person who holds both roles: they enter data as OPERATOR, then try to verify as VERIFIER.
    const who = personIn('verifier1');
    const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'INV-03 test: a person holding two roles', correlationId: randomUUID() });
    const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode: 'OPERATOR', reason: 'INV-03 test: a person holding two roles' }));
    const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'INV-03 test: approve the second role', correlationId: randomUUID() });
    await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'INV-03 test'));
    const asRole = async (role: string): Promise<TestBrowser> => {
      const s = await openPersonaSession(sbx.db, sbx.seed, 'verifier1', 'TEST-KIOSK-DISP-1');
      const token = newSessionToken();
      await sbx.db.app.query('select tab.bind_session($1, $2, $3)', [s.sessionId, tokenHash(token), role]);
      const b = sbx.browser('TEST-KIOSK-DISP-1');
      b.cookies.set(sbx.config.cookies.session, token);
      await b.call(routes.session.get);
      return b;
    };
    const asOp = new RunDriver(sbx, runId, { verifier1: await asRole('OPERATOR') });
    asOp.beforeTap = d.beforeTap;
    await asOp.ok('verifier1', { type: 'START_STEP', stepKey: CLEAR });
    await asOp.ok('verifier1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-5' } });
    const asVer = await asRole('VERIFIER');
    const run = await runContext(sbx.db.admin, runId);
    const forged = withCommand(sbx.db.app, await actorOfBrowser(sbx, asVer, 'verifier1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, runId);
      const roles = await engineRoles(c);
      const actor = engineActor(who.personId, roles);
      const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [], signature: { id: randomUUID(), meaning: 'VERIFIED', signer: who.personId } };
      // The engine would refuse; a forged "accepted" state is sent instead.
      const state = { ...tx.state, version: tx.state.version + 1 };
      await execution.appendExecution(c, { batchId: runId, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs, accepted: true, state, events: [], roles, contents: [] });
    });
    expect(await codeOf(forged)).toBe('EBMR-EXE-033');
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);
});

describe('privileges and the role map', () => {
  it('[DI-05][ADR-0012] the application roles (ebmr_sandbox here, ebmr_app in GMP) cannot insert, update or delete execution records', async () => {
    const { runId } = await newRun();
    const tables = ['recipe.batch_execution', 'recipe.execution_command', 'recipe.execution_event', 'recipe.execution_state', 'recipe.execution_step_content', 'recipe.execution_stage_content', 'recipe.execution_exception_content', 'recipe.execution_point_content', 'recipe.execution_disposition_proposal', 'recipe.test_package', 'recipe.engine_role_permission', 'recipe.execution_command_permission', 'tab.sandbox_lot', 'tab.engine_role_map'];
    const role = (await sbx.db.app.query<{ r: string }>('select current_user as r')).rows[0]?.r;
    expect(role).toBe('ebmr_sandbox');
    const cols = await sbx.db.admin.query<{ t: string; c: string }>(
      `select distinct on (t) table_schema || '.' || table_name as t, column_name as c from information_schema.columns
        where table_schema || '.' || table_name = any ($1) and is_identity = 'NO' order by t, ordinal_position`,
      [tables],
    );
    const firstColumn = new Map(cols.rows.map((r) => [r.t, r.c]));
    for (const [db, name] of [
      [sbx.db.app, 'sandbox'],
      [gmp.db.app, 'gmp'],
    ] as const) {
      for (const t of tables) {
        const c = firstColumn.get(t) ?? 'id';
        for (const sql of [`insert into ${t} default values`, `update ${t} set ${c} = ${c}`, `delete from ${t}`]) {
          expect(await codeOf(db.query(sql)), `${name}: ${sql}`).toMatch(/permission denied/);
        }
      }
    }
    expect(runId).toBeTruthy();
  }, 180_000);

  it('[INV-26][DI-17] every role the template names maps from a kernel role that holds the mapped permission', async () => {
    const def = (await runContext(sbx.db.admin, (await newRun()).runId)).def;
    const roles = new Set<string>([...def.policy.qaRoles, ...def.policy.supervisorRoles]);
    for (const s of def.steps.values()) {
      for (const r of s.performRoles) roles.add(r);
      if (s.checkRole) roles.add(s.checkRole);
    }
    for (const st of def.stages.values()) roles.add(st.responsibleRole);
    const { rows } = await sbx.db.admin.query<{ engine_role: string; kernel_role: string }>(
      `select m.engine_role, m.kernel_role from tab.engine_role_map m
        join iam.role_permission rp on rp.role_code = m.kernel_role and rp.permission_code = m.via_permission and rp.removed_at is null
        join recipe.engine_role_permission e on e.engine_role = m.engine_role and e.permission = m.via_permission`,
    );
    const mapped = new Set(rows.map((r) => r.engine_role));
    expect([...roles].filter((r) => !mapped.has(r))).toEqual([]);
    expect([...roles].sort()).toEqual(['HEAD_OF_PRODUCTION', 'PRODUCTION_OPERATOR', 'PRODUCTION_SUPERVISOR', 'PRODUCTION_VERIFIER', 'QA']);
  }, 180_000);
});

function personIn(key: string) {
  return personaIn(sbx, key);
}

