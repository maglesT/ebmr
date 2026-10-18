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
import { prepareSignature, signatureAlone, unmatched } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

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

/** The message a promise is rejected with, or 'ok'. */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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

/** A first step that records the blend time (CRITICAL, keyed by hand): withEarlyParameter. */
const EARLY = 'p-early-time@';
const INVOLVEMENT = ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const;

let secondRole: Promise<void> | undefined;
/** verifier1 also holds OPERATOR in this file's database (requested by the administrator, approved by the owner; once). */
function verifierAlsoOperator(): Promise<void> {
  secondRole ??= (async () => {
    const who = personIn('verifier1');
    const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'INV-03 test: a person holding two roles', correlationId: randomUUID() });
    const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode: 'OPERATOR', reason: 'INV-03 test: a person holding two roles' }));
    const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'INV-03 test: approve the second role', correlationId: randomUUID() });
    await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'INV-03 test'));
  })();
  return secondRole;
}

/** A dispensing-kiosk session of verifier1 acting in `role`. */
async function verifier1As(role: 'OPERATOR' | 'VERIFIER'): Promise<TestBrowser> {
  await verifierAlsoOperator();
  const s = await openPersonaSession(sbx.db, sbx.seed, 'verifier1', 'TEST-KIOSK-DISP-1');
  const token = newSessionToken();
  await sbx.db.app.query('select tab.bind_session($1, $2, $3)', [s.sessionId, tokenHash(token), role]);
  const b = sbx.browser('TEST-KIOSK-DISP-1');
  b.cookies.set(sbx.config.cookies.session, token);
  await b.call(routes.session.get);
  return b;
}

/**
 * verifier1, acting as VERIFIER, appends through the application role an accepted VERIFY of `step` with a forged next
 * state (the engine would refuse it, INV-03): 'ok' or the database's refusal.
 */
async function forgeVerify(runId: string, step: string): Promise<string> {
  const who = personIn('verifier1');
  const run = await runContext(sbx.db.admin, runId);
  const asVer = await verifier1As('VERIFIER');
  return messageOf(
    withCommand(sbx.db.app, await actorOfBrowser(sbx, asVer, 'verifier1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step, context: [], signature: { id: randomUUID(), meaning: 'VERIFIED', signer: who.personId } };
      const state = { ...tx.state, version: tx.state.version + 1 };
      await execution.appendExecution(c, { batchId: runId, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs, accepted: true, state, events: [], roles, contents: [] });
    }),
  );
}

/** The stored step instance `key` of a run. */
async function instanceOf(runId: string, key: string): Promise<engine.StepInstance | undefined> {
  return (await execution.loadState(sbx.db.admin, runId))?.state.steps[key];
}

/** The involvement lists of a step instance that name `person`. */
function involvementOf(inst: engine.StepInstance | undefined, person: string): string[] {
  return INVOLVEMENT.filter((l) => inst?.[l].includes(person));
}

/** recipe.check_verifier's refusal (EBMR-EXE-033) of `person` verifying step instance `key`. */
const involvedVerifier = (person: string, key: string): RegExp =>
  new RegExp(`${person} performed, entered data in or corrected step ${key}, so the verification is refused: the verifier is always another person \\(INV-03\\)\\. \\[EBMR-EXE-033\\]`);

describe('installation (DI-05, INV-18)', () => {
  it('[INV-18][DI-05] a GMP database, which issues GMP batches (recipe-core 0501), still refuses importing test packages and issuing test batches; a test batch or package that lands there anyway is reported', async () => {
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
    const held = async () => (await gmp.db.admin.query<{ b: string; p: string }>('select (select count(*) from recipe.batch_execution)::text as b, (select count(*) from recipe.test_package)::text as p')).rows[0];
    expect(await held()).toEqual({ b: '0', p: '0' });
    expect(await execution.executionViolations(gmp.db.admin)).toEqual([]);
    // A package holding SANDBOX_ONLY blocks, and a test batch, copied into GMP behind the writers' back (a restore, a
    // hand edit): each is reported, under its own message (review F22: the two messages share their ending, so the
    // test batch's report was never shown).
    const batchId = randomUUID();
    const H = 'a'.repeat(64);
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
      await admin.query(
        `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                             policy_hash, issue_request, market_set, batch_size, site_code, room_code, site_zone, issued_at_us,
                                             issued_by_person, issued_by_account, correlation_id)
         values ($1, 'B26-0001', $2, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', 'x', $3, '{}', $3, '{}', '{IN}', 'BS-100K', 'S1', null, 'Z', 0,
                 gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [batchId, pkg.packageHash, H],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    expect(await held()).toEqual({ b: '1', p: '1' });
    const reported = await execution.executionViolations(gmp.db.admin);
    expect(reported).toContainEqual({ batchId, problem: 'a test batch exists in a GMP database (DI-05, INV-18)' });
    expect(reported).toContainEqual({ batchId: null, problem: `test package ${pkg.packageHash} exists in a GMP database (DI-05, INV-18)` });
    for (const block of ['G-09@1', 'G-10@1']) {
      expect(reported).toContainEqual({ batchId: null, problem: `SANDBOX_ONLY block ${block} in package ${pkg.packageHash} held by a GMP database (DI-05, INV-18)` });
    }
    expect(reported.filter((v) => v.problem.includes('exists in a GMP database'))).toHaveLength(2);
  }, 180_000);

  it('[INV-18][DI-05] the sandbox never issues a GMP batch: the GMP issue path is refused there (a real batch number is never issued in the sandbox), and a row of GMP origin is never written there, whoever writes it', async () => {
    const issuer = await sbx.asPersona('issuer');
    const as = async () => ({ ...(await actorOfBrowser(sbx, issuer, 'issuer')), correlationId: randomUUID() });
    const batchId = randomUUID();
    const plan = { familyId: randomUUID(), markets: ['IN'], site: 'TEST-SITE', line: 'L1', batchSize: 'BS-100K', erpOrder: 'TEST-PO-0001' };
    expect(await codeOf(withCommand(sbx.db.app, await as(), (c) => execution.prepareGmpIssue(c, batchId, plan)))).toBe('EBMR-SBX-010');
    expect(await codeOf(withCommand(sbx.db.app, await as(), (c) => execution.beginGmpIssue(c, batchId)))).toBe('EBMR-SBX-010');
    expect(await codeOf(withCommand(sbx.db.app, await as(), (c) => c.query('select recipe.issue_gmp_execution($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)', [batchId, randomUUID(), 'B26-0001', {}, {}, 'x', 'x', 'x', 0, {}, 'x', [], 'x', [], {}])))).toBe('EBMR-SBX-010');
    // The owner's own insert of a GMP-origin row (no replica mode: every trigger runs), copied from a test batch.
    const { runId } = await newRun();
    const err = await codeOf(
      sbx.db.admin.query(
        `insert into recipe.batch_execution select (jsonb_populate_record(null::recipe.batch_execution,
            to_jsonb(b) || jsonb_build_object('id', gen_random_uuid(), 'batch_number', 'TEST-B26-' || (1000000 + floor(random() * 1000000))::bigint::text,
                                              'installation', 'GMP', 'purpose', 'GMP_BATCH', 'package_hash', null,
                                              'control_recipe_id', gen_random_uuid(), 'issue_signature_id', gen_random_uuid()))).*
           from recipe.batch_execution b where b.id = $1`,
        [runId],
      ),
    );
    expect(err).toBe('EBMR-EXE-190');
    expect((await violations(sbx)).filter((v) => v.problem.includes('GMP batch'))).toEqual([]);
  }, 180_000);

  it('[INV-18][DI-05][DI-37] the import writer itself refuses a package not exported from GMP, changed after export, of another format, under another file name or imported already, and stores nothing', async () => {
    // Called directly, as a properly attributed command of the issuer (BATCH.ISSUE), so no TypeScript pre-check of
    // the server runs: every refusal here is recipe.import_test_package's own (review F16).
    const issuer = await sbx.asPersona('issuer');
    const importAs = async (pkg: unknown, fileName: string) =>
      messageOf(withCommand(sbx.db.app, await actorOfBrowser(sbx, issuer, 'issuer'), (c) => execution.importTestPackage(c, pkg as execution.TestPackageV1, fileName)));
    const packages = async () => (await sbx.db.admin.query<{ h: string }>('select package_hash as h from recipe.test_package order by package_hash')).rows.map((r) => r.h);
    const build = (over: Partial<execution.TestPackageInput> = {}) =>
      execution.buildTestPackage({
        source: { installationKind: 'GMP', watermark: null },
        family: { familyId: randomUUID(), familyCode: 'PCM500-DC', product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' } },
        version: { versionId: randomUUID(), number: '1', revision: 1, state: 'APPROVED' },
        content: dcMini(),
        justifications: [],
        exporter: { personId: randomUUID(), legalName: 'Asha Rao', loginName: 'asha.rao' },
        exportedAtUs: '1790581503000000',
        ...over,
      });
    /** A package with members replaced and its package hash recomputed (a consistent forgery of the file). */
    const rehashed = (base: execution.TestPackageV1, members: Record<string, unknown>) => {
      const rest: Record<string, unknown> = { ...base, ...members };
      delete rest['packageHash'];
      return { ...rest, packageHash: execution.packageHashOf(rest) };
    };
    const good = build();
    const name = (pkg: { packageHash: string }) => `${pkg.packageHash}.json`;
    const fromSandbox = build({ source: { installationKind: 'SANDBOX', watermark: 'TEST, NOT GMP' } });
    const watermarked = build({ source: { installationKind: 'GMP', watermark: 'TEST, NOT GMP' } });
    const changed = { ...good, version: { ...good.version, number: '9' } };
    const contentChanged = rehashed(good, { contentHash: '0'.repeat(64) });
    const otherFormat = rehashed(good, { format: 'ebmr.mbr-package' });
    const otherVersion = rehashed(good, { formatVersion: 2 });
    const before = await packages();
    const notGmp = /does not come from a GMP installation; only MBR versions exported from GMP are test-run \(DI-05, INV-18\)\. \[EBMR-EXE-018\]/;
    const changedAfterExport = /The package hash does not match its content or its file name: the file was changed after export \(DI-05, DI-37\)\. \[EBMR-EXE-017\]/;
    const format = /is not an ebmr\.mbr-test-package version 1 \(DI-05\)\. \[EBMR-EXE-016\]/;
    expect(await importAs(fromSandbox, name(fromSandbox))).toMatch(notGmp);
    expect(await importAs(watermarked, name(watermarked))).toMatch(notGmp);
    expect(await importAs(changed, name(good))).toMatch(changedAfterExport);
    expect(await importAs(contentChanged, name(contentChanged))).toMatch(/The MBR content does not match its content hash \(DI-04\)\. \[EBMR-EXE-017\]/);
    expect(await importAs(otherFormat, name(otherFormat))).toMatch(format);
    expect(await importAs(otherVersion, name(otherVersion))).toMatch(format);
    // A package exactly as exported, but under another package's file name.
    expect(await importAs(good, name(fromSandbox))).toMatch(changedAfterExport);
    expect(await packages()).toEqual(before);
    expect(await importAs(good, name(good))).toBe('ok');
    const { rows } = await sbx.db.admin.query<{ file_name: string; content_hash: string; source: unknown }>('select file_name, content_hash, source from recipe.test_package where package_hash = $1', [good.packageHash]);
    expect(rows).toEqual([{ file_name: name(good), content_hash: good.contentHash, source: { installationKind: 'GMP', watermark: null } }]);
    expect(await importAs(good, name(good))).toMatch(/This test package has been imported already \(DI-05\)\. \[EBMR-EXE-019\]/);
    expect(await packages()).toEqual([...before, good.packageHash].sort());
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

describe('the validated release (DI-03, slice 7c)', () => {
  it('[DI-03] a sandbox, which training uses, is not gated: with no approved validation summary its test batch is issued; the GMP copy holds the approval its batches need', async () => {
    const problem = async (db: typeof sbx.db) => (await db.app.query<{ p: string | null }>('select platform.validation_summary_problem() as p')).rows[0]?.p ?? null;
    expect((await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from platform.validation_summary')).rows[0]?.n).toBe('0');
    expect(await problem(sbx.db)).toBeNull();
    const { runId } = await newRun();
    expect((await sbx.db.admin.query<{ i: string }>('select installation as i from recipe.batch_execution where id = $1', [runId])).rows[0]?.i).toBe('SANDBOX');
    // The GMP template approved the summary of its release (test/support/global-setup.ts), so its copies issue GMP batches.
    expect(await problem(gmp.db)).toBeNull();
    expect((await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from platform.validation_summary where schema_release = platform.schema_release()')).rows[0]?.n).toBe('1');
  });
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

  // Review F19: this test presents made-up evaluation ids only, so it shows the evidence must exist; a real evaluation
  // that was denied, made for another person or account, of another permission or in another command is refused in
  // db-guards-roles.test.ts.
  it('[INV-26] engine roles come from stored authority evaluations, never from the caller: an unknown evaluation, a permission the role is not held through and a role without evidence are refused; the accepted command stores its own evaluation', async () => {
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
    const unknown = randomUUID();
    expect(await messageOf(start(['QA'], [{ role: 'QA', permission: 'QA.FLOOR_APPROVE', evaluationId: unknown }]))).toMatch(new RegExp(`Engine role QA is not backed by an allowed authority evaluation .*: evaluation ${unknown} does not exist \\(INV-26, D4\\)\\. \\[EBMR-EXE-036\\]`));
    expect(await messageOf(start(['PRODUCTION_OPERATOR'], [{ role: 'PRODUCTION_OPERATOR', permission: 'QA.FLOOR_APPROVE', evaluationId: randomUUID() }]))).toMatch(/Engine role PRODUCTION_OPERATOR cannot be held through permission QA\.FLOOR_APPROVE \(INV-26\)\. \[EBMR-EXE-035\]/);
    expect(await messageOf(start(['PRODUCTION_SUPERVISOR'], []))).toMatch(/The command claims engine role PRODUCTION_SUPERVISOR without a stored authority evaluation behind it.*\[EBMR-EXE-037\]/);
    expect((await rowsOf(sbx, runId)).map((r) => r.kind)).toEqual(['ISSUE']);
    const ok = await start([], 'real');
    expect(ok.accepted).toBe(true);
    const { rows } = await sbx.db.admin.query<{ roles: execution.RoleEvidence[]; correlation_id: string }>('select roles, correlation_id from recipe.execution_command where batch_id = $1 order by seq desc limit 1', [runId]);
    const evidence = rows[0]?.roles ?? [];
    expect(evidence.map((e) => [e.role, e.permission])).toEqual([['PRODUCTION_OPERATOR', 'STEP.EXECUTE']]);
    const stored = await sbx.db.admin.query<{ allowed: boolean; person_id: string; correlation_id: string }>('select allowed, person_id, correlation_id from iam.authority_evaluation where id = $1', [evidence[0]?.evaluationId]);
    expect(stored.rows[0]).toMatchObject({ allowed: true, person_id: me.personId, correlation_id: rows[0]?.correlation_id });
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);

  // INV-03 at the database (recipe.check_verifier): the verifier is never a person who started, performed, entered data
  // in or corrected the step instance. Review F17: the earlier test's forger both started the step and entered data, so
  // it was refused through the "started" list alone and could not show the "entered data" rule; each list is now shown
  // on its own.

  it('[INV-03][DI-35] a fabricated accepted VERIFY by a person who only entered data in the step (another person started it) is refused by the database, and nothing is recorded', async () => {
    const { runId, d } = await newRun();
    const who = personIn('verifier1');
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const asOp = new RunDriver(sbx, runId, { verifier1: await verifier1As('OPERATOR') });
    asOp.beforeTap = d.beforeTap;
    await asOp.ok('verifier1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-5' } });
    // verifier1 is a data enterer of the step and nothing else: only the "entered data" rule can refuse them.
    expect(involvementOf(await instanceOf(runId, CLEAR), who.personId)).toEqual(['dataEnterers']);
    const rows0 = await rowsOf(sbx, runId);
    expect(await forgeVerify(runId, 'p-disp-clear')).toMatch(involvedVerifier(who.personId, CLEAR));
    expect(await rowsOf(sbx, runId)).toEqual(rows0);
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);

  it('[INV-03][DI-35][DI-24] a fabricated accepted VERIFY by a person who only corrected an entry of the step is refused by the database, and nothing is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyParameter()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const who = personIn('verifier1');
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
    // verifier1, acting as OPERATOR, corrects the blend time (their own CORRECTED signature, qa1's approval: the value is
    // critical), exactly as the engine accepts it: the correction is the only act of verifier1 in the step.
    const run = await runContext(sbx.db.admin, runId);
    const point = Object.values((await execution.loadState(sbx.db.admin, runId))?.state.points ?? {}).find((p) => p.item === 'blendTime' && p.status === 'VALID')?.id ?? '';
    const qa1 = personIn('qa1');
    const approvalId = await signatureAlone(sbx, d.browser('qa1'), 'qa1', 'batch_point', `${runId}:${point}`, 'CORRECTION_APPROVED');
    const asOp = await verifier1As('OPERATOR');
    const p = await prepareSignature(sbx, asOp, 'verifier1', 'batch_point', `${runId}:${point}`, 'CORRECTED');
    await withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, runId);
      const roles = await engineRoles(c);
      const r = await tx.command(
        {
          type: 'CORRECT_ENTRY',
          commandId: randomUUID(),
          actor: engineActor(who.personId, roles),
          point,
          value: { kind: 'DECIMAL', value: '16', unit: 'min' },
          reason: 'Transcription error: the timer read 16 min',
          signature: { id, meaning: 'CORRECTED', signer: who.personId },
          approval: { approver: { id: qa1.personId, kind: 'PERSON', roles: ['QA'] }, signature: { id: approvalId, meaning: 'CORRECTION_APPROVED', signer: qa1.personId } },
        },
        roles,
      );
      if (!r.accepted) throw new Error(`SETUP: the engine refused the correction: ${JSON.stringify(r.refusal)}`);
    });
    expect(involvementOf(await instanceOf(runId, EARLY), who.personId)).toEqual(['correctors']);
    const rows0 = await rowsOf(sbx, runId);
    expect(await forgeVerify(runId, 'p-early-time')).toMatch(involvedVerifier(who.personId, EARLY));
    expect(await rowsOf(sbx, runId)).toEqual(rows0);
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);

  it('[INV-03][DI-35] the database refuses a VERIFY by a person in any one list of the step instance (started, entered data, corrected, signed performed), and only that instance\'s lists count', async () => {
    // The guard itself (recipe.check_verifier, private to the owner; called here by the superuser) on the stored state of
    // a real run, with the instance's lists set one at a time. A PERFORMED signer is also a performer whenever the engine
    // records the signature, so the "signed performed" list can be shown on its own only here.
    const { runId, d } = await newRun();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const { rows } = await sbx.db.admin.query<{ state: { steps: Record<string, Record<string, unknown>> } }>('select state from recipe.execution_state where batch_id = $1', [runId]);
    const stored = rows[0]?.state;
    const clear = stored?.steps[CLEAR];
    if (!stored || !clear) throw new Error('SETUP: the started clearance is not in the stored state');
    const LISTS = INVOLVEMENT;
    expect(LISTS.filter((l) => !Array.isArray(clear[l]))).toEqual([]);
    const someone = randomUUID();
    const withLists = (lists: Partial<Record<(typeof LISTS)[number], string[]>>, key = CLEAR, step = 'p-disp-clear') => ({
      ...stored,
      steps: { ...stored.steps, [key]: { ...clear, key, step, ...Object.fromEntries(LISTS.map((l) => [l, lists[l] ?? []])) } },
    });
    const check = (prior: unknown, cmd: Record<string, unknown>) =>
      messageOf(sbx.db.admin.query('select recipe.check_verifier($1::jsonb, $2::jsonb)', [JSON.stringify(prior), JSON.stringify({ actor: { id: someone, kind: 'PERSON' }, step: 'p-disp-clear', context: [], ...cmd })]));
    const verify = { type: 'VERIFY' };
    const outcomes: Record<string, string> = {};
    for (const l of LISTS) outcomes[l] = await check(withLists({ [l]: [someone] }), verify);
    // Controls: in no list (others in all of them); in every list of another step instance; not a VERIFY; no such instance.
    const others = [personIn('operator1').personId];
    outcomes['none'] = await check(withLists(Object.fromEntries(LISTS.map((l) => [l, others]))), verify);
    const elsewhere = withLists(Object.fromEntries(LISTS.map((l) => [l, [someone]])), 'p-disp-bal@', 'p-disp-bal');
    outcomes['anotherInstance'] = await check({ ...elsewhere, steps: { ...elsewhere.steps, [CLEAR]: { ...clear, ...Object.fromEntries(LISTS.map((l) => [l, []])) } } }, verify);
    outcomes['notVerify'] = await check(withLists(Object.fromEntries(LISTS.map((l) => [l, [someone]]))), { type: 'SIGN_PERFORMED' });
    outcomes['noInstance'] = await check(withLists({}), { ...verify, context: [{ construct: 'L-X', iteration: 1 }] });
    const refused = involvedVerifier(someone, CLEAR);
    expect(
      unmatched(outcomes, {
        performers: refused,
        dataEnterers: refused,
        correctors: refused,
        performedSigners: refused,
        none: 'ok',
        anotherInstance: 'ok',
        notVerify: 'ok',
        noInstance: /The step to verify does not exist in the stored state \(DI-34\)\. \[EBMR-EXE-032\]/,
      }),
    ).toEqual({});
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

// Last in this file: it moves the batch-number sequence forward as a restore would, and any later test would see that.
describe('TEST- batch numbers after a restore (INV-27)', () => {
  const KEY = 'recipe.batch_execution.batch_number';
  const NUMBER = /^TEST-B(\d{2})-(\d+)$/;

  /** The batch number of an issued test batch, as stored. */
  async function numberOf(runId: string): Promise<string> {
    const { rows } = await sbx.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [runId]);
    return rows[0]?.n ?? '';
  }

  /** The serial written into a batch number (digits after TEST-B<yy>-). */
  const serialOf = (batchNumber: string): string => NUMBER.exec(batchNumber)?.[2] ?? '';

  it('[INV-27] once the restore procedure has moved the batch-number sequence past its high-water mark, each test batch gets a distinct TEST- number with the serial in full, never one cut back to four digits', async () => {
    const { admin } = sbx.db;
    // Before the restore: a serial below 10000 is zero-padded to four digits.
    const before = await numberOf((await newRun()).runId);
    expect(before).toMatch(/^TEST-B\d{2}-\d{4}$/);

    // The high-water mark of the sequence as exported to the external ledger with each anchor.
    const { rows: marks } = await admin.query<{ v: string }>('select last_value::text as v from continuity.sequence_high_water() where sequence_key = $1', [KEY]);
    const highWater = marks[0]?.v ?? '';
    expect(serialOf(before)).toBe(highWater.padStart(4, '0'));
    const { rows: issued } = await admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution');
    const issuedBefore = issued.map((r) => r.n);

    // The move the restore procedure plans for the sequence (continuity.plan_sequence_moves, as after_restore and
    // secure_identifiers call it, with the ledger's mark), applied the way they apply it: setval, value marked as used.
    const { rows: moves } = await admin.query<{ seq: string; value_after: string }>(
      `select (x ->> 'sequence')::oid::regclass::text as seq, x ->> 'value_after' as value_after
         from jsonb_array_elements(continuity.plan_sequence_moves(jsonb_build_array(jsonb_build_object('sequence_key', $1::text, 'value', $2::text)), 1000000, false)) x
        where x ->> 'sequence_key' = $1`,
      [KEY, highWater],
    );
    expect(moves).toEqual([{ seq: 'recipe.test_batch_number_seq', value_after: (BigInt(highWater) + 10_000n).toString() }]);
    const valueAfter = BigInt(moves[0]?.value_after ?? '0');
    await admin.query('select pg_catalog.setval($1::regclass, $2::bigint, true)', [moves[0]?.seq, valueAfter.toString()]);

    // After the move: two test batches, each numbered with its whole serial (five digits here), distinct from each
    // other and from every number issued before the restore.
    const first = await numberOf((await newRun()).runId);
    const second = await numberOf((await newRun()).runId);
    expect(first).toMatch(/^TEST-B\d{2}-\d{5}$/);
    expect(second).toMatch(/^TEST-B\d{2}-\d{5}$/);
    expect(serialOf(first)).toBe((valueAfter + 1n).toString());
    expect(serialOf(second)).toBe((valueAfter + 2n).toString());
    expect(first).not.toBe(second);
    expect(issuedBefore).toContain(before);
    expect(issuedBefore).not.toContain(first);
    expect(issuedBefore).not.toContain(second);
    expect(await violations(sbx)).toEqual([]);
  }, 180_000);
});

function personIn(key: string) {
  return personaIn(sbx, key);
}

