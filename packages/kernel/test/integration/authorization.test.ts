/**
 * Authority checks across the kernel modules (B7; kernel 0700/0710).
 *
 * Every function of the market, records and continuity modules that the application may call and
 * that can write checks the actor's permission in the object's scope before writing (DI-17), and
 * every one that writes GMP data refuses administrators first (DI-18). Platform permissions reach
 * the identity module through the AUTHORITY adapter, which stores every evaluation (INV-26). The
 * permission-to-role map keeps INV-11: no role holds an administration and a GMP permission.
 * The batch-number register (site services) is covered in packages/site-services/test/authorization.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordHardeningAttestation } from '../../src/continuity/hardening.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import type { Scope } from '../../src/identity/authority.ts';
import { withGuardedCommand } from '../../src/identity/authority.ts';
import { definePolicy, pinPoliciesForBatch } from '../../src/market/policy.ts';
import { evaluateStubScope, setSiteValue } from '../../src/market/repository.ts';
import { raiseIncident, reclassifyIncident, startIncidentInvestigation } from '../../src/records/incidents.ts';
import { openDiInvestigation } from '../../src/records/investigations.ts';
import { defineRecordType } from '../../src/records/register.ts';
import { approvePurge, createRetentionSchedule, placeLegalHold, releaseLegalHold } from '../../src/records/retention-store.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { authorizationScan, type ScanRules } from '../support/authorization-scan.ts';
import { SEED_SITE, seedActor, seedAdministration, seedServiceActor, withFreshAuth, withReason, type SeededActor } from '../identity/seed.ts';
import { approveSourceCorrection, createTestTable, miniDocument, publishDocumentAs, publishSeedTables } from '../market/helpers.ts';
import { registerValidatedTimeSource } from '../platform/helpers.ts';
import { approveDisposal, disposalAggregate, recordType, registerType, signFor } from '../records/helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  await seedAdministration(db);
});
afterAll(async () => {
  await db.drop();
});

/** A person holding one role (installation-wide unless a scope is given) with a session on a personal device. */
const actor = (roleCode: string, scope?: Scope): Promise<SeededActor> =>
  seedActor(db, { roleCode, acknowledgeEsig: false, ...(scope ? { scope } : {}) });
const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const sql = (ctx: ActorContext, text: string, params: unknown[] = []) => withCommand(db.app, again(ctx), (c) => c.query(text, params));

/** The permission-to-role map of 0700_authorization_catalogue.sql (plus the existing permissions the gates reuse). */
const MAP: Record<string, { domain: string; effect: string; roles: string[] }> = {
  'MARKET.RULE_TABLE_PUBLISH': { domain: 'GMP', effect: 'WRITE', roles: ['MASTER_DATA_STEWARD'] },
  'MARKET.RULE_TABLE_CORRECT': { domain: 'GMP', effect: 'WRITE', roles: ['REGULATORY_SIGNER'] },
  'MARKET.SITE_VALUE_SET': { domain: 'GMP', effect: 'WRITE', roles: ['MASTER_DATA_STEWARD'] },
  'MARKET.POLICY_CHANGE': { domain: 'GMP', effect: 'WRITE', roles: ['QA_MBR_APPROVER'] },
  'MARKET.POLICY_TIGHTEN_BATCH': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER'] },
  'MARKET.RULE_EVALUATE': { domain: 'GMP', effect: 'WRITE', roles: ['BATCH_ISSUER', 'MBR_AUTHOR', 'OPERATOR', 'QA_REVIEWER', 'SERVICE_ACCOUNT'] },
  'MASTERDATA.CHANGE': { domain: 'GMP', effect: 'WRITE', roles: ['MASTER_DATA_STEWARD'] },
  'BATCH.ISSUE': { domain: 'GMP', effect: 'SIGN', roles: ['BATCH_ISSUER'] },
  'RECORD.TYPE_DEFINE': { domain: 'GMP', effect: 'WRITE', roles: ['CSV_DI_LEAD', 'QA_MBR_APPROVER'] },
  'RECORD.TYPE_APPROVE': { domain: 'GMP', effect: 'SIGN', roles: ['QA_MBR_APPROVER'] },
  'RECORD.RETENTION_MANAGE': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER', 'SERVICE_ACCOUNT'] },
  'RECORD.LEGAL_HOLD': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER'] },
  'RECORD.DISPOSAL_APPROVE': { domain: 'GMP', effect: 'SIGN', roles: ['QA_REVIEWER'] },
  'RECORD.PURGE': { domain: 'GMP', effect: 'WRITE', roles: ['SERVICE_ACCOUNT'] },
  'RECORD.TRUE_COPY_REGISTER': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER', 'SERVICE_ACCOUNT'] },
  'INCIDENT.RAISE': {
    domain: 'GMP',
    effect: 'WRITE',
    roles: [
      'BATCH_ISSUER', 'CSV_DI_LEAD', 'DISPENSER', 'HEAD_OF_PRODUCTION', 'HEAD_OF_QC', 'MAINTENANCE_TECHNICIAN', 'OPERATOR', 'QA_REVIEWER',
      'QA_SHOP_FLOOR', 'QC_ANALYST', 'SERVICE_ACCOUNT', 'SHIFT_SUPERVISOR', 'STAGE_RESPONSIBLE', 'VERIFIER', 'WAREHOUSE_LABELLING',
    ],
  },
  'INCIDENT.INVESTIGATE': { domain: 'GMP', effect: 'WRITE', roles: ['CSV_DI_LEAD', 'QA_REVIEWER'] },
  'INCIDENT.CLOSE': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER'] },
  'INCIDENT.CERT_IN_REPORT': { domain: 'GMP', effect: 'WRITE', roles: ['CSV_DI_LEAD', 'QA_REVIEWER'] },
  'VALIDATION.MANAGE': { domain: 'GOVERNANCE', effect: 'WRITE', roles: ['CSV_DI_LEAD'] },
  'DI_INVESTIGATION.APPROVE_CLOSURE': { domain: 'GMP', effect: 'SIGN', roles: ['QA_REVIEWER'] },
  'CONTINUITY.RESTORE_OPERATE': { domain: 'ADMINISTRATION', effect: 'ADMINISTER', roles: ['SYSTEM_ADMINISTRATOR'] },
  'CONTINUITY.RESTORE_APPROVE': { domain: 'GMP', effect: 'SIGN', roles: ['QA_REVIEWER'] },
  'CONTINUITY.BACKUP_RECORD': { domain: 'GOVERNANCE', effect: 'WRITE', roles: ['SERVICE_ACCOUNT'] },
  'CONTINUITY.HARDENING_ATTEST': { domain: 'ADMINISTRATION', effect: 'ADMINISTER', roles: ['SYSTEM_ADMINISTRATOR'] },
  'CONTINUITY.ALARM_ACKNOWLEDGE': { domain: 'GOVERNANCE', effect: 'ACKNOWLEDGE', roles: ['PROCESS_OWNER', 'SYSTEM_ADMINISTRATOR'] },
  'CONTINUITY.COUNTER_RESERVE': { domain: 'GMP', effect: 'WRITE', roles: ['BATCH_ISSUER', 'SERVICE_ACCOUNT'] },
  'BATCH_NUMBER.RULE_DEFINE': { domain: 'GMP', effect: 'WRITE', roles: ['MASTER_DATA_STEWARD'] },
  'BATCH_NUMBER.ALLOCATE': { domain: 'GMP', effect: 'WRITE', roles: ['BATCH_ISSUER'] },
  'BATCH_NUMBER.REGISTER_EXTERNAL': { domain: 'GMP', effect: 'WRITE', roles: ['BATCH_ISSUER', 'SERVICE_ACCOUNT'] },
  'BATCH_NUMBER.VOID': { domain: 'GMP', effect: 'WRITE', roles: ['BATCH_ISSUER'] },
  'BATCH_NUMBER.RECOVER': { domain: 'GMP', effect: 'WRITE', roles: ['BATCH_ISSUER'] },
  'PLATFORM.SETTINGS_CHANGE': { domain: 'GOVERNANCE', effect: 'WRITE', roles: ['PROCESS_OWNER'] },
  'PLATFORM.TIME_SOURCE_MANAGE': { domain: 'ADMINISTRATION', effect: 'ADMINISTER', roles: ['SYSTEM_ADMINISTRATOR'] },
  'PLATFORM.ALARM_CLEAR': { domain: 'GOVERNANCE', effect: 'WRITE', roles: ['CSV_DI_LEAD'] },
  'PLATFORM.TIME_CHECK_RECORD': { domain: 'GOVERNANCE', effect: 'WRITE', roles: ['SERVICE_ACCOUNT'] },
  'PLATFORM.TIME_SOURCE_VALIDATE': { domain: 'GOVERNANCE', effect: 'WRITE', roles: ['CSV_DI_LEAD'] },
  'SAMPLE_RECORD.SUBMIT': { domain: 'GMP', effect: 'WRITE', roles: ['MBR_AUTHOR'] },
  'SAMPLE_RECORD.CHECK': { domain: 'GMP', effect: 'SIGN', roles: ['MBR_CHECKER', 'QA_REVIEWER'] },
  'SAMPLE_RECORD.APPROVE': { domain: 'GMP', effect: 'SIGN', roles: ['QA_REVIEWER'] },
  'SAMPLE_RECORD.RETIRE': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER'] },
};

/** App-callable functions that may write but are deliberately not gated (with the reason). */
const UNGATED: Record<string, string> = {
  // Platform plumbing: no GMP content, and the command each serves is gated itself.
  'platform.audit_position()': 'reads the audit-trail position (a sequence value); volatile only because sequences are; writes nothing',
  'platform.check_late_entry(platform.late_entry_assessment,text,uuid,text,text)':
    'validation called by the time-model triggers of block tables (refuses or returns); writes nothing',
  'platform.check_time_trust_source(text)': 'validation called by the time-model triggers of block tables (refuses or returns); writes nothing',
  'platform.entry_site_zone()': 'returns the site time zone an entry is stored with, refusing a context that declares another; writes nothing',
  'platform.claim_idempotency_key(text,text)':
    "command plumbing: records the caller's own idempotency key for its own command, bound to its account and correlation; the command is gated",
  'platform.complete_idempotency_key(text,text)': 'command plumbing: completes the key this transaction claimed; the command is gated',
  'platform.enqueue(text,text,jsonb)': "application messages on the caller's own topics (kernel topics are refused), in the transaction of a gated command",
  'platform.outbox_claim(text,integer)': 'relay bookkeeping: claims messages for delivery; no record content',
  'platform.outbox_mark_delivered(bigint,text)': 'relay bookkeeping of a message this transaction claimed; no record content',
  'platform.outbox_mark_failed(bigint,text,text)': 'relay bookkeeping of a message this transaction claimed; no record content',
  'platform.consume_once(text,uuid)': "consumer bookkeeping (a message is processed once), in the transaction of the consumer's own gated effect",
  'records.lock_blocker_epoch(text,text)':
    'derived concurrency token read and locked inside a disposition transaction (0400, 0430); the disposition itself is gated. Before locking it only adds ' +
    'the DI-50 link and hold that an open investigation already requires (what the scope refresh adds), refusing administrators; it never removes anything',
};

interface Fn {
  fn: string;
  src: string;
}
/**
 * Functions of the gated modules (market, records, continuity, site services and the platform) the
 * application role may execute and that are VOLATILE (only those can write).
 */
async function appWritableFunctions(): Promise<Fn[]> {
  const { rows } = await db.admin.query<Fn>(`
    select p.oid::regprocedure::text as fn, p.prosrc as src
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('market', 'records', 'continuity', 'site', 'platform') and p.provolatile = 'v' and p.prokind = 'f'
      and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')
    order by 1`);
  return rows;
}
/** An authority check: the identity module's, or the platform's AUTHORITY hook (which calls it). */
const checksAuthority = (src: string): boolean => src.includes('iam.require_permission(') || src.includes('platform.authorize(');
/** App-callable functions that only delegate to an owner-only function, which checks authority (proven below, F78). */
const DELEGATES: Record<string, string> = {
  'platform.create_aggregate_state(text,text,uuid)': 'platform.create_aggregate_state_at',
  // Kernel 1180 (Phase 6 slice 6a-0): the uuid-returning form of accept_inbound_detail, which checks interface.write.
  'platform.accept_inbound(jsonb)': 'platform.accept_inbound_detail',
};
async function delegateChecksAuthority(fn: string): Promise<boolean> {
  const target = DELEGATES[fn];
  if (!target) return false;
  const { rows } = await db.admin.query<{ src: string }>(
    "select p.prosrc as src from pg_catalog.pg_proc p where p.oid::regprocedure::text like $1 || '(%'",
    [target],
  );
  const own = (await db.admin.query<{ src: string }>('select prosrc as src from pg_catalog.pg_proc where oid = $1::regprocedure', [fn])).rows[0]?.src ?? '';
  return own.includes(`${target}(`) && rows.length === 1 && checksAuthority(rows[0]?.src ?? '');
}
const permissionLiterals = (src: string): string[] => [...src.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? '');

describe('the permission catalogue (DI-17, DI-18, INV-11)', () => {
  it('[DI-17] every protected action has its permission, with its domain and effect, held by exactly the mapped roles', async () => {
    const { rows } = await db.admin.query<{ code: string; domain: string; effect: string; roles: string[] }>(
      `select p.code, p.domain, p.effect,
              coalesce(array_agg(rp.role_code order by rp.role_code collate "C") filter (where rp.role_code is not null), '{}') as roles
       from iam.permission p left join iam.role_permission rp on rp.permission_code = p.code and rp.removed_at is null
       where p.code = any($1) group by p.code, p.domain, p.effect order by p.code`,
      [Object.keys(MAP)],
    );
    expect(Object.fromEntries(rows.map((r) => [r.code, { domain: r.domain, effect: r.effect, roles: r.roles }]))).toEqual(
      Object.fromEntries(Object.entries(MAP).map(([k, v]) => [k, { ...v, roles: [...v.roles].sort() }])),
    );
  });

  it('[DI-18][INV-11] no role holds both an administration permission and a GMP permission', async () => {
    const { rows } = await db.admin.query<{ role_code: string }>(`
      select rp.role_code from iam.role_permission rp join iam.permission p on p.code = rp.permission_code
      where rp.removed_at is null group by rp.role_code
      having bool_or(p.domain = 'ADMINISTRATION') and bool_or(p.domain = 'GMP')`);
    expect(rows).toEqual([]);
    // Administrators hold only IT functions of the new catalogue; the directory scan stays clean.
    const admin = await db.admin.query<{ code: string }>(
      `select permission_code as code from iam.role_permission where role_code = 'SYSTEM_ADMINISTRATOR' and removed_at is null and permission_code = any($1) order by permission_code collate "C"`,
      [Object.keys(MAP)],
    );
    expect(admin.rows.map((r) => r.code)).toEqual(['CONTINUITY.ALARM_ACKNOWLEDGE', 'CONTINUITY.HARDENING_ATTEST', 'CONTINUITY.RESTORE_OPERATE', 'PLATFORM.TIME_SOURCE_MANAGE']);
    expect((await db.app.query('select * from iam.directory_scan()')).rows).toEqual([]);
  });

  it('[DI-14][DI-17] service accounts get write permissions only; display and break-glass roles get no new permission', async () => {
    const { rows } = await db.admin.query<{ role_code: string; code: string; effect: string; domain: string }>(
      `select rp.role_code, p.code, p.effect, p.domain from iam.role_permission rp join iam.permission p on p.code = rp.permission_code
       where rp.removed_at is null and rp.role_code in ('SERVICE_ACCOUNT', 'STATUS_DISPLAY', 'BREAK_GLASS_ADMIN') and p.code = any($1)`,
      [Object.keys(MAP)],
    );
    expect(rows.filter((r) => r.role_code !== 'SERVICE_ACCOUNT')).toEqual([]);
    expect(rows.every((r) => r.effect === 'WRITE' && r.domain !== 'ADMINISTRATION')).toBe(true);
  });

  it('[DI-17] catalogue changes shipped by the release are in the audit trail, attributed to the release', async () => {
    const { rows } = await db.admin.query<{ role: string; reason: string }>(
      "select payload -> 'actor' ->> 'role_code' as role, payload ->> 'reason_code' as reason from kernel.audit_event where chain_key = 'iam_permission:INCIDENT.RAISE'",
    );
    expect(rows).toEqual([{ role: 'SOFTWARE_RELEASE', reason: 'SOFTWARE_RELEASE' }]);
    const { rows: chain } = await db.admin.query('select * from kernel.verify_chain($1)', ['iam_role:QA_REVIEWER']);
    expect(chain).toEqual([]);
  });
});

describe('every mutating function checks authority (DI-17) and GMP writes refuse administrators (DI-18)', () => {
  it('[DI-17] every function of market, records, continuity, site services and the platform that the application may call and that can write checks a known permission', async () => {
    const fns = await appWritableFunctions();
    expect(fns.length).toBeGreaterThanOrEqual(40);
    const ungated: string[] = [];
    for (const f of fns) if (!checksAuthority(f.src) && !(f.fn in UNGATED) && !(await delegateChecksAuthority(f.fn))) ungated.push(f.fn);
    expect(ungated).toEqual([]);
    const { rows } = await db.admin.query<{ code: string }>('select code from iam.permission');
    const known = new Set(rows.map((r) => r.code));
    const unknown = fns.flatMap((f) => permissionLiterals(f.src).filter((p) => !known.has(p)).map((p) => `${f.fn}: ${p}`));
    expect(unknown).toEqual([]);
    // Tables the application writes directly (the market stub tables) check authority in a statement trigger.
    const { rows: tables } = await db.admin.query<{ t: string; guarded: boolean }>(`
      select c.oid::regclass::text as t,
             exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = c.oid and g.tgname = 'a0_authorize' and g.tgenabled in ('O', 'A')) as guarded
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('market', 'records', 'continuity', 'site') and c.relkind = 'r'
        and (has_table_privilege('ebmr_app', c.oid, 'INSERT') or has_table_privilege('ebmr_app', c.oid, 'UPDATE'))
      order by 1`);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !t.guarded).map((t) => t.t)).toEqual([]);
  });

  it('[DI-18] every function that writes GMP data refuses administrators before it checks the permission', async () => {
    const { rows } = await db.admin.query<{ code: string; domain: string }>('select code, domain from iam.permission');
    const domain = new Map(rows.map((r) => [r.code, r.domain]));
    const { rows: trig } = await db.admin.query<Fn>("select 'market.authorize_stub_write()' as fn, prosrc as src from pg_proc where oid = 'market.authorize_stub_write'::regproc");
    const gmp = [...(await appWritableFunctions()), ...trig].filter((f) => permissionLiterals(f.src).some((p) => domain.get(p) === 'GMP'));
    expect(gmp.length).toBeGreaterThanOrEqual(30);
    const missing = gmp
      .filter((f) => {
        const guard = f.src.indexOf('iam.assert_not_administrator()');
        return guard < 0 || guard > f.src.indexOf('iam.require_permission(');
      })
      .map((f) => f.fn);
    expect(missing).toEqual([]);
  });
});

/**
 * Phase 7 slice 7b-1 (review residual 6jc-R7): the same scan over the kernel's identity, e-signature and sandbox schemas,
 * whose Phase 6 writers were proven by their own tests only. Each entry says why the function checks no permission of its
 * own: the identity and signature machinery is the check (it is what iam.require_permission and the signing ceremony are
 * built from), a session's own plumbing, or a read volatile only because it calls volatile readers.
 */
const KERNEL_WIDE: ScanRules = {
  ungated: {
    // Identity: the checks themselves, and the login and session plumbing of the person's own session.
    'iam.actor_is_validated()': 'the check: whether the command was started with kernel.begin_command; writes nothing',
    'iam.assert_validated_actor()': 'the check: refuses a command not started with kernel.begin_command; writes nothing',
    'iam.assert_not_administrator()': 'the DI-18 check itself; writes nothing',
    'iam.first_run_setup(text,jsonb)':
      'the browser\'s first-run set-up (kernel 1375; decision 0025): there is no person or session yet, so no permission can be ' +
      'checked; it refuses unless its token hashes to an unused, unexpired set-up token and refuses once the installation is set ' +
      'up, and the token is used up in the same transaction',
    'iam.require_permission(text,jsonb)': 'the DI-17 check itself (it stores its evaluation, INV-26)',
    'iam.evaluate_authority(uuid,uuid,text,jsonb,timestamp with time zone,text)': 'the authority evaluation behind require_permission; stores the evaluation (INV-26) and changes nothing else',
    'iam.evaluate_segregation(text,uuid,uuid[],text)': 'the segregation evaluation behind assert_segregated; stores the evaluation and changes nothing else',
    'iam.assert_segregated(text,uuid[],text)': 'the segregation check of the actor (DI-16); refuses or returns',
    'iam.can_sign(uuid)': 'the signing-readiness check (an active personal account with a signing permission); writes nothing',
    'iam.assert_can_sign(uuid)': 'refuses unless iam.can_sign; writes nothing',
    'iam.grant_is_live(text,timestamp with time zone,timestamp with time zone)': 'a pure test of a grant\'s window; writes nothing',
    'iam.current_command_auth_event()': 'reads the authentication this command used; writes nothing',
    'iam.resolve_device(text)': 'login plumbing: names the terminal of a fingerprint and raises the unregistered or blocked device alert (DI-19)',
    'iam.check_device_location(uuid,text,text)': 'login plumbing: checks the terminal\'s room and site and raises its alert (DI-19)',
    'iam.open_session(uuid,text)': 'login plumbing: opens the session of an authentication event the authentication service recorded, once (DI-19, DI-20)',
    'iam.end_session(uuid)': 'the person\'s own logout',
    'iam.lock_session(uuid)': 'the person\'s own screen lock (unlocking needs a fresh authentication)',
    'iam.acknowledge_esig_policy(text)': 'the person\'s own acknowledgment of the signature policy, from a personal HUMAN account only (EBMR-IAM-054)',
    'iam.request_delegation(uuid,jsonb,text[],text[],timestamp with time zone,timestamp with time zone,text,text)':
      'a request only, by a person holding signing authority (EBMR-IAM-180); it takes effect once approved under IAM.DELEGATION_APPROVE',
    // E-signatures: the ceremony evaluates the meaning's permissions itself (iam.evaluate_authority in esig.sign).
    'esig.create_challenge(text,text,bigint,text,text,uuid)': 'the challenge of the ceremony: refuses administrators, checks the signer may sign (iam.assert_can_sign); the meaning\'s permissions are evaluated when it is signed',
    'esig.sign(uuid,uuid,text,uuid,boolean)': 'the ceremony: refuses administrators, consumes a fresh authentication and evaluates the meaning\'s permissions for the signer (iam.evaluate_authority)',
    'esig.seal_signature(uuid,text,text,text)': 'seals a signature applied in this same transaction only (EBMR-ESIG-062)',
    'esig.stub_complete(uuid,uuid)': 'the test stub signable (kernel test aggregate): refuses administrators and needs valid signatures of its meanings',
    'esig.assert_signature(uuid,text,text,text)': 'verification: refuses unless the signature is valid for the record and meaning; writes nothing',
    'esig.signature_problem(uuid,text,text,text)': 'verification read (volatile because content providers are); writes nothing',
    'esig.signature_problems(uuid)': 'verification read (volatile because content providers are); writes nothing',
    'esig.signature_state(uuid)': 'verification read (volatile because content providers are); writes nothing',
    'esig.signature_state_problem(uuid)': 'verification read (volatile because content providers are); writes nothing',
    // Reads of signatures and their content (volatile because the content providers are); an edition revokes them and
    // reads through its own definers that check the reader (tablets 0410).
    'esig.content_for_signing(text,text)': 'a read of a record\'s content to sign; writes nothing',
    'esig.record_signatures(text,text)': 'a read of a record\'s signatures; writes nothing',
    'esig.manifestation(uuid)': 'a read of a signature\'s manifestation; writes nothing',
    'esig.evidence_package(uuid)': 'a read of a signature\'s evidence; writes nothing',
    'esig.resigning_required(text,text)': 'a read: whether a record\'s signatures must be given again; writes nothing',
    'esig.verify_signatures(timestamp with time zone)': 'verification read of the signatures since an instant; writes nothing',
    'esig.invariant_violations()': 'invariant query; writes nothing',
    'esig.record_signing_failure(uuid,uuid,text,text)': 'logs a failed signing against its challenge with its security alert (DI-23); records the failure only',
    'iam.keep_session_alive(uuid,uuid)': 'the session\'s own keep-alive, with a fresh authentication of its person',
    'iam.unlock_session(uuid,uuid)': 'the session\'s own unlock, with a fresh authentication of its person',
    'esig.enrol_dsc_certificate(jsonb)': 'the person\'s own certificate, from their own personal HUMAN account, with proof of possession; refuses administrators (kernel 1321)',
    'esig.record_dsc_signature(uuid,jsonb)': 'the DSC of a password signature made in this same command, by the certificate enrolled for its signer; refuses administrators (kernel 1321)',
    // Sandbox: training on the sandbox installation only, the person's own attempts.
    'sandbox.start_training(text,integer,integer)': 'training on the sandbox installation only (EBMR-SBX-039): the person\'s own attempt',
    'sandbox.complete_training_step(uuid,integer)': 'training on the sandbox installation only: a step of the person\'s own attempt (EBMR-SBX-040)',
  },
  delegates: {
    'esig.retire_meaning_type(text,text)': 'esig.configure_meaning_type',
  },
  adminAfterPermission: {
    'esig.add_meaning_type(text,jsonb,text)': 'asks MBR.APPROVE in its declarations, then refuses administrators before it reads or writes anything',
    'esig.configure_meaning_type(text,jsonb,text)': 'asks MBR.APPROVE in its declarations, then refuses administrators before it reads or writes anything',
    'esig.register_dsc_anchor(text,text,text,bytea,text)': 'asks its permission in its declarations, then refuses administrators before it reads or writes anything',
    'esig.set_dsc_meaning(text,boolean,text)': 'asks its permission in its declarations, then refuses administrators before it reads or writes anything',
    'esig.set_policy(text,text,text,text)': 'asks MBR.APPROVE in its declarations, then refuses administrators before it reads or writes anything',
  },
};

describe('the authorization scan of the identity, e-signature and sandbox schemas (6jc-R7)', () => {
  it('[DI-17][DI-18] every app-callable writer of iam, esig and sandbox checks a known permission or is listed with its reason, refuses administrators first when it names a GMP permission, and no table is app-writable', async () => {
    const r = await authorizationScan(db.admin, ['iam', 'esig', 'sandbox'], KERNEL_WIDE);
    expect(r.functions).toBeGreaterThanOrEqual(80);
    expect(r.ungated).toEqual([]);
    expect(r.unknownPermissions).toEqual([]);
    expect(r.adminNotFirst).toEqual([]);
    expect(r.staleEntries).toEqual([]);
    expect(r.appWritableTables).toEqual([]);
  });

  it('[DI-18] the DSC enrolment, its end and the DSC record refuse administrators first (6jc-R6, kernel 1321)', async () => {
    const { rows } = await db.admin.query<{ fn: string; src: string }>(
      "select p.oid::regprocedure::text as fn, p.prosrc as src from pg_proc p where p.oid in ('esig.enrol_dsc_certificate(jsonb)'::regprocedure, 'esig.record_dsc_signature(uuid,jsonb)'::regprocedure, 'esig.end_dsc_enrolment(uuid,text)'::regprocedure) order by 1");
    expect(rows).toHaveLength(3);
    for (const f of rows) {
      const body = f.src.slice(f.src.indexOf('begin'));
      expect(body.trimStart().split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'))[1], f.fn).toBe('perform iam.assert_not_administrator();');
    }
    const { admin } = await seedAdministration(db);
    await expect(sql(admin, "select esig.enrol_dsc_certificate('{}'::jsonb)")).rejects.toThrow(/EBMR-IAM-042/);
    await expect(sql(admin, "select esig.record_dsc_signature(gen_random_uuid(), '{}'::jsonb)")).rejects.toThrow(/EBMR-IAM-042/);
    await expect(sql(admin, "select esig.end_dsc_enrolment(gen_random_uuid(), 'lost token')")).rejects.toThrow(/EBMR-IAM-042/);
  });
});

describe('market-profile engine', () => {
  let steward: SeededActor;
  beforeAll(async () => {
    steward = await actor('MASTER_DATA_STEWARD');
  });

  it('[DI-17] an operator cannot publish a rule table, a steward cannot publish a source correction, a regulatory signer cannot publish an update; the refusal is logged', async () => {
    const table = `az${randomBytes(3).toString('hex')}`;
    await createTestTable(db, table);
    const operator = await actor('OPERATOR');
    const v1 = miniDocument(table);
    const publishAs = (ctx: ActorContext, doc: unknown, change: Record<string, unknown> = {}) =>
      withGuardedCommand(db.app, again(ctx), (c) => c.query('select market.publish_rule_table($1::jsonb, $2::jsonb) as r', [JSON.stringify(doc), JSON.stringify(change)]));
    await expect(publishAs(operator, v1)).rejects.toThrow('EBMR-IAM-040');
    const logged = await db.app.query<{ allowed: boolean; reasons: string[] }>(
      "select allowed, reasons from iam.authority_evaluation where person_id = $1 and permission_code = 'MARKET.RULE_TABLE_PUBLISH'",
      [operator.personId],
    );
    expect(logged.rows.length).toBeGreaterThanOrEqual(1);
    expect(logged.rows.every((r) => !r.allowed)).toBe(true);
    await publishDocumentAs(db, again(steward), v1);

    const v2 = miniDocument(table, 2);
    (v2['rows'] as Record<string, unknown>[])[1] = { ...(v2['rows'] as Record<string, unknown>[])[1], value: '25' };
    const correction = {
      kind: 'SOURCE_CORRECTION',
      description: 'EU value mis-keyed',
      citation: 'source re-read',
      vendorNoticeRef: 'VN-AZ-1',
      approvalSignatureIds: await approveSourceCorrection(db, v2),
    };
    await expect(publishAs(steward, v2, correction)).rejects.toThrow(/EBMR-IAM-040 .*MARKET\.RULE_TABLE_CORRECT/);
    const signer = await actor('REGULATORY_SIGNER');
    await publishDocumentAs(db, again(signer), v2, correction);
    const v3 = miniDocument(table, 3);
    (v3['rows'] as Record<string, unknown>[])[0] = { ...(v3['rows'] as Record<string, unknown>[])[0], value: '25' };
    await expect(publishAs(signer, v3, { kind: 'UPDATE', description: 'tighter interval' })).rejects.toThrow(/EBMR-IAM-040 .*MARKET\.RULE_TABLE_PUBLISH/);
  });

  it('[DI-18] a system administrator cannot publish a rule table, set a site value, change a policy or write the stub master data', async () => {
    const { admin } = await seedAdministration(db);
    const table = `az${randomBytes(3).toString('hex')}`;
    await createTestTable(db, table);
    await expect(publishDocumentAs(db, again(admin), miniDocument(table))).rejects.toThrow('EBMR-IAM-042');
    await expect(withCommand(db.app, underChange(again(admin)), (c) => setSiteValue(c, { siteId: randomUUID(), key: 'tablets.compression.ipcSampleMaxInterval', value: '20', effectiveFrom: '2026-01-01' }))).rejects.toThrow(
      'EBMR-IAM-042',
    );
    await expect(
      withCommand(db.app, underChange(again(admin)), (c) => definePolicy(c, { code: `adm.${randomBytes(2).toString('hex')}`, title: 't', level: 'TENANT', positions: ['OFF', 'ON'], defaultPosition: 'ON' })),
    ).rejects.toThrow('EBMR-IAM-042');
    await expect(sql(admin, "insert into market.stub_site (code, markets) values ('ADMIN-SITE', '{IN}')")).rejects.toThrow('EBMR-IAM-042');
  });

  it('[DI-17] an operator cannot write the stub master data, define a policy, pin a batch or apply a tightening; an auditor cannot record an evaluation', async () => {
    const operator = await actor('OPERATOR');
    await expect(sql(operator, "insert into market.stub_site (code, markets) values ('OP-SITE', '{IN}')")).rejects.toThrow(/EBMR-IAM-040 .*MASTERDATA\.CHANGE/);
    await expect(
      withCommand(db.app, underChange(again(await actor('QA_REVIEWER'))), (c) =>
        definePolicy(c, { code: `qa.${randomBytes(2).toString('hex')}`, title: 't', level: 'TENANT', positions: ['OFF', 'ON'], defaultPosition: 'ON' }),
      ),
    ).rejects.toThrow(/EBMR-IAM-040 .*MARKET\.POLICY_CHANGE/);
    await expect(withCommand(db.app, again(operator), (c) => pinPoliciesForBatch(c, randomUUID()))).rejects.toThrow(/EBMR-IAM-040 .*BATCH\.ISSUE/);
    await expect(sql(operator, "select market.apply_policy_tightening($1, 'x', $2, 'CC-1')", [randomUUID(), randomUUID()])).rejects.toThrow(
      /EBMR-IAM-040 .*MARKET\.POLICY_TIGHTEN_BATCH/,
    );
    const auditor = await actor('AUDITOR_READONLY');
    await expect(
      withCommand(db.app, again(auditor), (c) => evaluateStubScope(c, { key: 'kernel.selfInspection.maxIntervalMonths', scope: { kind: 'SITE', id: randomUUID() }, resolutionPoint: 'EXECUTION', asOf: '2026-01-01' })),
    ).rejects.toThrow(/EBMR-IAM-040 .*MARKET\.RULE_EVALUATE/);
  });

  it('[DI-17] a site value is authorised in its site\'s scope: a steward whose grant is limited to another site is refused', async () => {
    await publishSeedTables(db);
    const tag = randomBytes(2).toString('hex').toUpperCase();
    const ids = await withCommand(db.app, again(steward), async (c) => {
      const { rows } = await c.query<{ id: string; code: string }>(
        "insert into market.stub_site (code, markets) values ($1, '{IN}'), ($2, '{IN}') returning id, code",
        [`AZ-A-${tag}`, `AZ-B-${tag}`],
      );
      return new Map(rows.map((r) => [r.code, r.id]));
    });
    const siteA = await actor('MASTER_DATA_STEWARD', { site: `AZ-A-${tag}` });
    const set = (siteId: string) =>
      withCommand(db.app, underChange(again(siteA)), (c) => setSiteValue(c, { siteId, key: 'tablets.compression.ipcSampleMaxInterval', value: '20', effectiveFrom: '2026-01-01' }));
    await expect(set(ids.get(`AZ-A-${tag}`) ?? '')).resolves.toMatchObject({ outcome: 'TIGHTER' });
    await expect(set(ids.get(`AZ-B-${tag}`) ?? '')).rejects.toThrow(/EBMR-IAM-040 .*MARKET\.SITE_VALUE_SET/);
  });
});

describe('records', () => {
  let qa: SeededActor;
  beforeAll(async () => {
    qa = await seedActor(db, { roleCode: 'QA_REVIEWER' }); // signs its approvals (e-signature policy acknowledged)
    await registerType(db, recordType('AUTHZ_BATCH_RECORD'));
  });

  it('[DI-17] a QC analyst cannot approve a purge, and the refusal is logged; a QA reviewer can', async () => {
    const batch = randomUUID();
    // The retention inputs are kept by another QA reviewer: the approver of a disposal entered none of them (EBMR-REC-035).
    const keeper = await actor('QA_REVIEWER');
    await withCommand(db.app, again(keeper), (c) =>
      createRetentionSchedule(c, 'batch', batch, 'AUTHZ_BATCH_RECORD', { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' }),
    );
    const qc = await actor('QC_ANALYST');
    await expect(withGuardedCommand(db.app, again(qc), (c) => approvePurge(c, `batch:${batch}`, randomUUID(), 'retention ended'))).rejects.toThrow(
      /EBMR-IAM-040 .*RECORD\.DISPOSAL_APPROVE/,
    );
    const logged = await db.app.query<{ allowed: boolean }>(
      "select allowed from iam.authority_evaluation where person_id = $1 and permission_code = 'RECORD.DISPOSAL_APPROVE'",
      [qc.personId],
    );
    expect(logged.rows.length).toBeGreaterThanOrEqual(1);
    expect(logged.rows.every((r) => !r.allowed)).toBe(true);
    await expect(approveDisposal(db, qa, `batch:${batch}`, 'retention ended')).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-47][INV-09] a disposal signature covers the retention inputs and the holds: a hold placed after it unsigns the disposal, and the same QA reviewer signs the fresh approval', async () => {
    const batch = randomUUID();
    const key = `batch:${batch}`;
    const keeper = await actor('QA_REVIEWER');
    await withCommand(db.app, again(keeper), (c) =>
      createRetentionSchedule(c, 'batch', batch, 'AUTHZ_BATCH_RECORD', { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' }),
    );
    const aggregate = await disposalAggregate(db, key);
    // The signed content names the inputs in force, the hold watermark and, as authors, whoever entered the inputs.
    const content = await db.admin.query<{ c: { content: Record<string, unknown>; entered_by: string[]; aggregate_id: string } }>(
      'select records.record_disposal_content($1) as c',
      [aggregate.id],
    );
    expect(content.rows[0]?.c).toMatchObject({ aggregate_id: aggregate.id, entered_by: [keeper.personId] });
    expect(content.rows[0]?.c.content).toMatchObject({ retention_inputs: { input_version: '1' }, hold_watermark: expect.any(String) as string });
    const before = await signFor(db, qa, aggregate, 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    const state = async (id: string) => (await db.app.query<{ s: { valid: boolean; status: string } }>('select esig.signature_state($1) as s', [id])).rows[0]?.s;
    expect(await state(before)).toMatchObject({ valid: true, status: 'VALID' });

    // Another reviewer places a legal hold (and releases it): the signature made before it no longer
    // holds. (Whoever changes signed content is one of its authors, so the hold is placed by another person.)
    const holdId = await withCommand(db.app, again(keeper), (c) => placeLegalHold(c, 'batch', batch, 'claim received', 'LEGAL-AZ-1'));
    await withCommand(db.app, withReason(keeper, 'CLAIM_SETTLED', 'claim withdrawn'), (c) => releaseLegalHold(c, holdId, 'claim withdrawn'));
    expect(await state(before)).toMatchObject({ valid: false, status: 'SUPERSEDED_BY_CHANGE' });
    await expect(withCommand(db.app, again(qa), (c) => approvePurge(c, key, before, 'retention ended'))).rejects.toThrow('EBMR-ESIG-070');

    // The same reviewer signs the disposal again, now with the hold in its content, and approves.
    const after = await signFor(db, qa, aggregate, 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    expect(await state(after)).toMatchObject({ valid: true });
    await expect(withCommand(db.app, again(qa), (c) => approvePurge(c, key, after, 'retention ended; hold released'))).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-17] an operator cannot place a legal hold or investigate an incident; a service account raises an incident but cannot reclassify it', async () => {
    const operator = await actor('OPERATOR');
    await expect(withCommand(db.app, again(operator), (c) => placeLegalHold(c, 'batch', randomUUID(), 'claim'))).rejects.toThrow(/EBMR-IAM-040 .*RECORD\.LEGAL_HOLD/);
    const monitor = await seedServiceActor(db, { name: 'Interface monitor' });
    const id = await withCommand(db.app, again(monitor), (c) =>
      raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'SCALE_OFFLINE', severity: 'MINOR', title: 'scale offline', links: [{ aggregateType: 'batch', aggregateId: randomUUID() }] }),
    );
    await expect(withCommand(db.app, again(operator), (c) => startIncidentInvestigation(c, id))).rejects.toThrow(/EBMR-IAM-040 .*INCIDENT\.INVESTIGATE/);
    await expect(withCommand(db.app, again(monitor), (c) => reclassifyIncident(c, id, 'MAJOR', 'x'))).rejects.toThrow(/EBMR-IAM-040 .*INCIDENT\.INVESTIGATE/);
    await withCommand(db.app, again(qa), (c) => startIncidentInvestigation(c, id));
  });

  it('[DI-18] a system administrator cannot raise an incident, define a record type, place a hold or open a DI investigation', async () => {
    const { admin } = await seedAdministration(db);
    await expect(withCommand(db.app, again(admin), (c) => raiseIncident(c, { source: 'CRASH', type: 'SERVER_RESTART', severity: 'MINOR', title: 'restart' }))).rejects.toThrow(
      'EBMR-IAM-042',
    );
    await expect(withCommand(db.app, again(admin), (c) => defineRecordType(c, recordType('ADMIN_TYPE')))).rejects.toThrow('EBMR-IAM-042');
    await expect(withCommand(db.app, again(admin), (c) => placeLegalHold(c, 'batch', randomUUID(), 'claim'))).rejects.toThrow('EBMR-IAM-042');
    const subject = await actor('OPERATOR');
    const from = new Date(Date.UTC(2026, 0, 1));
    await expect(
      withCommand(db.app, again(admin), (c) => openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: new Date(Date.UTC(2026, 0, 2)), concern: 'x' })),
    ).rejects.toThrow('EBMR-IAM-042');
  });

  it('[DI-17] a QA reviewer cannot open a DI investigation; the CSV / DI lead can', async () => {
    const subject = await actor('OPERATOR');
    const window = { subjectPersonId: subject.personId, windowFrom: new Date(Date.UTC(2026, 0, 1)), windowTo: new Date(Date.UTC(2026, 0, 2)), concern: 'values typed late' };
    await expect(withCommand(db.app, again(qa), (c) => openDiInvestigation(c, window))).rejects.toThrow(/EBMR-IAM-040 .*VALIDATION\.MANAGE/);
    await expect(withCommand(db.app, again(await actor('CSV_DI_LEAD')), (c) => openDiInvestigation(c, window))).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-17] raising an incident is authorised where the actor works: a room-limited grant covers its own room only, a site-limited grant its own site', async () => {
    const raise = (ctx: ActorContext) =>
      withCommand(db.app, ctx, (c) => raiseIncident(c, { source: 'CONNECTION_LOSS', type: 'TERMINAL_OFFLINE', severity: 'MINOR', title: 'terminal lost connection' }));
    const inRoom = await seedActor(db, { roleCode: 'OPERATOR', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-A1', scope: { site: SEED_SITE, area: 'ROOM-A1' }, acknowledgeEsig: false });
    await expect(raise(inRoom)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    const elsewhere = await seedActor(db, { roleCode: 'OPERATOR', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-B2', scope: { site: SEED_SITE, area: 'ROOM-A1' }, acknowledgeEsig: false });
    await expect(raise(elsewhere)).rejects.toThrow(/EBMR-IAM-040 .*INCIDENT\.RAISE .*"area": "ROOM-B2"/);
    await expect(raise(await withFreshAuth(db, inRoom))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(raise(again(await actor('OPERATOR', { site: SEED_SITE })))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(raise(again(await actor('OPERATOR', { site: 'SITE-2' })))).rejects.toThrow(/EBMR-IAM-040 .*INCIDENT\.RAISE/);
  });
});

describe('continuity', () => {
  it('[DI-17] an operator cannot attest a terminal, acknowledge a continuity alarm, record a restore or reserve a number ceiling; administrators hold the IT functions', async () => {
    const operator = await actor('OPERATOR');
    const attestation = {
      deviceId: randomUUID(), deviceClass: 'SHARED' as const, usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true,
      osPatchWithinSla: true, method: 'MDM_COMPLIANCE_REPORT' as const, evidenceRef: 'MDM-AZ-1',
    };
    await expect(withCommand(db.app, again(operator), (c) => recordHardeningAttestation(c, attestation))).rejects.toThrow(/EBMR-IAM-040 .*CONTINUITY\.HARDENING_ATTEST/);
    await expect(sql(operator, "select continuity.acknowledge_alarm($1, 'seen')", [randomUUID()])).rejects.toThrow(/EBMR-IAM-040 .*CONTINUITY\.ALARM_ACKNOWLEDGE/);
    await expect(sql(operator, "select continuity.record_restore_event('{}'::jsonb, '[]'::jsonb)")).rejects.toThrow(/EBMR-IAM-040 .*CONTINUITY\.RESTORE_OPERATE/);
    await expect(sql(operator, "select continuity.reserve_counter_ceiling('x', 0, 1, 'r')")).rejects.toThrow(/EBMR-IAM-040 .*CONTINUITY\.COUNTER_RESERVE/);

    // A failed backup job (service account) raises a continuity alarm; an administrator acknowledges it.
    const agent = await seedServiceActor(db, { name: 'Backup agent' });
    await sql(agent, 'select continuity.record_backup_job($1::jsonb)', [
      JSON.stringify({ job_name: 'nightly-az', tier: 'OPERATIONAL', status: 'FAILED', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z', error_text: 'disk full' }),
    ]);
    const { rows } = await db.app.query<{ id: string }>("select id from continuity.open_alarm where alarm_code = 'BACKUP_JOB_FAILED' order by recorded_at desc limit 1");
    const alarm = rows[0]?.id ?? '';
    await expect(sql(await actor('QA_REVIEWER'), "select continuity.acknowledge_alarm($1, 'seen')", [alarm])).rejects.toThrow('EBMR-IAM-040');
    const { admin } = await seedAdministration(db);
    await sql(admin, "select continuity.acknowledge_alarm($1, 'disk extended; next run passed')", [alarm]);
    await withCommand(db.app, again(admin), (c) => recordHardeningAttestation(c, attestation));
  });

  it('[DI-17][DI-18] a QA reviewer cannot operate a restore; a system administrator named as approver cannot approve it; the QA reviewer approves it', async () => {
    const { admin } = await seedAdministration(db);
    const admin2 = await actor('SYSTEM_ADMINISTRATOR');
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
    const event = (approvers: string[]) =>
      JSON.stringify({ event_kind: 'FAILOVER', performed_at: '2026-01-01T00:00:00Z', reason: 'primary node lost', change_reference: 'CHG-AZ-1', approver_person_ids: approvers });
    await expect(sql(qa, "select continuity.record_restore_event($1::jsonb, '[]'::jsonb)", [event([admin2.personId])])).rejects.toThrow(
      /EBMR-IAM-040 .*CONTINUITY\.RESTORE_OPERATE/,
    );
    const recorded = await sql(admin, "select continuity.record_restore_event($1::jsonb, '[]'::jsonb) as id", [event([admin2.personId, qa.personId])]);
    const id = (recorded.rows[0] as { id: string }).id;
    await expect(sql(admin2, 'select continuity.approve_restore_event($1)', [id])).rejects.toThrow('EBMR-IAM-042');
    const signature = await signFor(db, qa, { type: 'restore_event', id }, 'RESTORE_APPROVED', 'RECORDED');
    await sql(qa, 'select continuity.approve_restore_event($1, $2)', [id, signature]);
    const { rows } = await db.app.query<{ approvals: string }>('select approvals::text from continuity.restore_event_status where id = $1', [id]);
    expect(rows[0]?.approvals).toBe('1');
  });
});

describe('approval signatures (DI-37)', () => {
  it('[DI-35][DI-17] the approval signature types name the approving permissions; RESTORE_APPROVED is a vendor minimum type', async () => {
    const { rows } = await db.app.query<{ code: string; permissions: string[]; origin: string; is_minimum: boolean; status: string }>(
      `select code, permissions, origin, is_minimum, status from esig.meaning_catalogue
       where code in ('RECORD_TYPE_APPROVED', 'RECORD_DISPOSAL_APPROVED', 'DI_INVESTIGATION_CLOSED', 'RESTORE_APPROVED') order by code`,
    );
    expect(rows).toEqual([
      { code: 'DI_INVESTIGATION_CLOSED', permissions: ['DI_INVESTIGATION.APPROVE_CLOSURE'], origin: 'VENDOR', is_minimum: true, status: 'ACTIVE' },
      { code: 'RECORD_DISPOSAL_APPROVED', permissions: ['RECORD.DISPOSAL_APPROVE'], origin: 'VENDOR', is_minimum: true, status: 'ACTIVE' },
      { code: 'RECORD_TYPE_APPROVED', permissions: ['RECORD.TYPE_APPROVE'], origin: 'VENDOR', is_minimum: true, status: 'ACTIVE' },
      { code: 'RESTORE_APPROVED', permissions: ['CONTINUITY.RESTORE_APPROVE'], origin: 'VENDOR', is_minimum: true, status: 'ACTIVE' },
    ]);
    const providers = await db.app.query<{ aggregate_type: string }>(
      "select aggregate_type from esig.content_provider where aggregate_type in ('record_type_version', 'di_investigation', 'record_disposal', 'restore_event') order by 1",
    );
    expect(providers.rows.map((r) => r.aggregate_type)).toEqual(['di_investigation', 'record_disposal', 'record_type_version', 'restore_event']);
    // A person without the approving permission cannot even sign the approval (EBMR-ESIG-040).
    const { admin } = await seedAdministration(db);
    const recorded = await sql(admin, "select continuity.record_restore_event($1::jsonb, '[]'::jsonb) as id", [
      JSON.stringify({ event_kind: 'FAILOVER', performed_at: '2026-01-02T00:00:00Z', reason: 'node lost', change_reference: 'CHG-AZ-3', approver_person_ids: [randomUUID()] }),
    ]);
    const operator = await seedActor(db, { roleCode: 'OPERATOR' });
    await expect(signFor(db, operator, { type: 'restore_event', id: (recorded.rows[0] as { id: string }).id }, 'RESTORE_APPROVED', 'RECORDED')).rejects.toThrow('EBMR-ESIG-040');
  });

  it('[DI-45][DI-37] a restore is approved only with the approver\'s own RESTORE_APPROVED signature of that event', async () => {
    const { admin } = await seedAdministration(db);
    const qa1 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA One' });
    const qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Two' });
    const record = async () => {
      const r = await sql(admin, "select continuity.record_restore_event($1::jsonb, '[]'::jsonb) as id", [
        JSON.stringify({ event_kind: 'FAILOVER', performed_at: '2026-01-03T00:00:00Z', reason: 'node lost', change_reference: 'CHG-AZ-4', approver_person_ids: [qa1.personId, qa2.personId] }),
      ]);
      return (r.rows[0] as { id: string }).id;
    };
    const id = await record();
    const other = await record();
    const approve = (ctx: ActorContext, signature: string | null) => sql(ctx, 'select continuity.approve_restore_event($1, $2)', [id, signature]);
    await expect(approve(qa1, null)).rejects.toThrow('EBMR-CONT-025');
    await expect(approve(qa1, randomUUID())).rejects.toThrow(/EBMR-ESIG-070 .*does not exist/);
    const ofOther = await signFor(db, qa1, { type: 'restore_event', id: other }, 'RESTORE_APPROVED', 'RECORDED');
    await expect(approve(qa1, ofOther)).rejects.toThrow(/EBMR-ESIG-070 .*never transferred/);
    const wrongMeaning = await signFor(db, qa1, { type: 'restore_event', id }, 'RECORD_DISPOSAL_APPROVED', 'RECORDED');
    await expect(approve(qa1, wrongMeaning)).rejects.toThrow(/EBMR-ESIG-070 .*means RECORD_DISPOSAL_APPROVED/);
    const own = await signFor(db, qa1, { type: 'restore_event', id }, 'RESTORE_APPROVED', 'RECORDED');
    await expect(approve(qa2, own)).rejects.toThrow('EBMR-CONT-025');
    await approve(qa1, own);
    await approve(qa2, await signFor(db, qa2, { type: 'restore_event', id }, 'RESTORE_APPROVED', 'RECORDED'));
    const { rows } = await db.app.query<{ status: string }>('select status from continuity.restore_event_status where id = $1', [id]);
    expect(rows[0]?.status).toBe('APPROVED');
    const { rows: sigs } = await db.app.query<{ signature_id: string; approver_person_id: string }>(
      'select signature_id, approver_person_id from continuity.restore_event_approval where restore_event_id = $1 order by recorded_at',
      [id],
    );
    expect(sigs.map((r) => r.approver_person_id)).toEqual([qa1.personId, qa2.personId]);
    expect(sigs[0]?.signature_id).toBe(own);
  });
});

describe('platform AUTHORITY adapter', () => {
  it('[DI-17] the platform AUTHORITY hook is the identity adapter; platform permission names map to catalogue codes', async () => {
    const { rows } = await db.admin.query<{ f: string }>("select function_oid::text as f from platform.hook where name = 'AUTHORITY'");
    expect(rows[0]?.f).toBe('iam.platform_authority(text,jsonb,text,text)');
    const map = await db.admin.query<{ n: string; c: string | null }>(
      "select n, iam.platform_permission_code(n) as c from unnest(array['platform.settings.change', 'platform.time_source.manage', 'platform.alarm.clear', 'sample_record.submit', 'PLATFORM.ALARM_CLEAR', 'Platform.Settings', 'nodot']) n",
    );
    expect(map.rows).toEqual([
      { n: 'platform.settings.change', c: 'PLATFORM.SETTINGS_CHANGE' },
      { n: 'platform.time_source.manage', c: 'PLATFORM.TIME_SOURCE_MANAGE' },
      { n: 'platform.alarm.clear', c: 'PLATFORM.ALARM_CLEAR' },
      { n: 'sample_record.submit', c: 'SAMPLE_RECORD.SUBMIT' },
      { n: 'PLATFORM.ALARM_CLEAR', c: 'PLATFORM.ALARM_CLEAR' },
      { n: 'Platform.Settings', c: null },
      { n: 'nodot', c: null },
    ]);
    // Every permission the platform names (functions and machine transitions) exists in the catalogue.
    const named = await db.admin.query<{ n: string; c: string | null }>(`
      select n, iam.platform_permission_code(n) as c from (
        select distinct permission_code as n from platform.machine_transition where permission_code is not null
        union select unnest(array['platform.settings.change', 'platform.time_source.manage', 'platform.alarm.clear'])) x
      where not exists (select 1 from iam.permission p where p.code = iam.platform_permission_code(x.n))`);
    expect(named.rows).toEqual([]);
  });

  it('[DI-17] platform permissions: a process owner changes a setting and a system administrator a time source, an operator neither; each decision is stored at the actor\'s location', async () => {
    const owner = await actor('PROCESS_OWNER');
    const operator = await actor('OPERATOR');
    const setting = (ctx: ActorContext) => sql(underChange(withReason(ctx, 'CHANGE_CONTROL', 'CC-AZ-1')), "select platform.set_setting('time.late_entry_window_min', '20')");
    await expect(setting(operator)).rejects.toThrow(/EBMR-PLAT-006 permission platform\.settings\.change denied: .*PLATFORM\.SETTINGS_CHANGE/);
    // The refusal carries what is needed to log the failed check outside the rolled-back command (F72):
    // the same JSON detail as an EBMR-IAM-040 refusal, naming the actor and the catalogue permission.
    const refusal = await setting(operator).then(
      () => undefined,
      (error: unknown) => error as { detail?: string },
    );
    expect(JSON.parse(refusal?.detail ?? '{}')).toMatchObject({
      person_id: operator.personId,
      account_id: operator.accountId,
      role_code: 'OPERATOR',
      permission: 'PLATFORM.SETTINGS_CHANGE',
      scope: { site: SEED_SITE },
    });
    await setting(owner);
    const { rows } = await db.app.query<{ allowed: boolean; scope: Record<string, string>; role_code: string }>(
      "select allowed, scope, role_code from iam.authority_evaluation where person_id = $1 and permission_code = 'PLATFORM.SETTINGS_CHANGE'",
      [owner.personId],
    );
    expect(rows).toEqual([{ allowed: true, scope: { site: SEED_SITE }, role_code: 'PROCESS_OWNER' }]);
    // A time source is registered with the person who validated it, who then confirms it (DI-27).
    const validator = await actor('CSV_DI_LEAD');
    const register = (ctx: ActorContext) =>
      sql(ctx, "select platform.register_time_source($1, 'NTP', 'ntp.example', 'NPL India', $2, 'VAL-TS-AZ')", [`AZ ${randomBytes(3).toString('hex')}`, validator.personId]);
    await expect(register(operator)).rejects.toThrow('EBMR-PLAT-006');
    await registerValidatedTimeSource(db, again(await actor('SYSTEM_ADMINISTRATOR')), again(validator), `AZ ${randomBytes(3).toString('hex')}`, 'NPL India');
  });

  it('[DI-17] the sample state machine reaches the catalogue: an MBR author submits a record, an operator cannot', async () => {
    const author = await actor('MBR_AUTHOR');
    const id = await withCommand(db.app, again(author), async (c) => {
      const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('AZ SOP', 'content') returning id");
      const recordId = rows[0]?.id ?? '';
      await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: recordId });
      return recordId;
    });
    const submit = (ctx: ActorContext) =>
      withCommand(db.app, again(ctx), (c) => transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event: 'SUBMIT', expectedVersion: 1, payload: {} }));
    await expect(submit(await actor('OPERATOR'))).rejects.toThrow(/EBMR-PLAT-006 .*SAMPLE_RECORD\.SUBMIT/);
    await expect(submit(author)).resolves.toMatchObject({ to: 'SUBMITTED' });
  });

  it('[DI-17] platform permissions are checked where the actor works: a grant limited to another site does not cover them', async () => {
    const change = (ctx: ActorContext) => sql(underChange(withReason(ctx, 'CHANGE_CONTROL', 'CC-AZ-2')), "select platform.set_setting('time.late_entry_window_min', '25')");
    await expect(change(await actor('PROCESS_OWNER', { site: 'SITE-2' }))).rejects.toThrow(/EBMR-PLAT-006 .*"site": "SITE-1"/);
    await change(await actor('PROCESS_OWNER', { site: SEED_SITE }));
  });

  it('[DI-17] the adapter trusts only the validated actor of the command and names it can map; the application cannot call it', async () => {
    const owner = await actor('PROCESS_OWNER');
    const client = await db.admin.connect();
    try {
      const call = async (permission: string, actorJson: unknown) =>
        (await client.query<{ r: string | null }>("select iam.platform_authority($1, $2::jsonb, 'platform_setting', 'x') as r", [permission, JSON.stringify(actorJson)])).rows[0]?.r;
      await client.query('begin');
      expect(await call('platform.settings.change', {})).toMatch(/^EBMR-IAM-002/);
      const ctx = toDbContext(again(owner));
      await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)]);
      const current = (await client.query<{ a: unknown }>('select kernel.current_actor() as a')).rows[0]?.a;
      expect(await call('platform.settings.change', current)).toBeNull();
      expect(await call('platform.settings.change', { ...(current as object), person_id: randomUUID() })).toMatch(/^EBMR-IAM-043/);
      expect(await call('platform.settings.change', { ...(current as object), role_code: 'SYSTEM_ADMINISTRATOR' })).toMatch(/^EBMR-IAM-043/);
      expect(await call('Platform settings', current)).toMatch(/^EBMR-IAM-043/);
      // A denied evaluation is raised as the platform's refusal, with the JSON detail that lets the
      // guarded-command wrapper log it after the rollback (F72).
      await expect(call('platform.nothing.here', current)).rejects.toThrow(/^EBMR-PLAT-006 permission platform\.nothing\.here denied: .*PERMISSION_UNKNOWN/);
      await client.query('rollback');
    } finally {
      client.release();
    }
    await expect(db.app.query("select iam.platform_authority('platform.settings.change', '{}'::jsonb, 'x', 'y')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('select iam.actor_location_scope()')).rejects.toThrow(/permission denied/);
  });
});
