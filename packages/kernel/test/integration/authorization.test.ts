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
import { approvePurge, createRetentionSchedule, placeLegalHold } from '../../src/records/retention-store.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { SEED_SITE, seedActor, seedAdministration, seedServiceActor, withFreshAuth, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestTable, miniDocument, publishDocumentAs, publishSeedTables } from '../market/helpers.ts';
import { approveDisposal, recordType, registerType, signFor } from '../records/helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
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
  'SAMPLE_RECORD.SUBMIT': { domain: 'GMP', effect: 'WRITE', roles: ['MBR_AUTHOR'] },
  'SAMPLE_RECORD.CHECK': { domain: 'GMP', effect: 'SIGN', roles: ['MBR_CHECKER', 'QA_REVIEWER'] },
  'SAMPLE_RECORD.APPROVE': { domain: 'GMP', effect: 'SIGN', roles: ['QA_REVIEWER'] },
  'SAMPLE_RECORD.RETIRE': { domain: 'GMP', effect: 'WRITE', roles: ['QA_REVIEWER'] },
};

/** App-callable functions that may write but are deliberately not gated (with the reason). */
const UNGATED: Record<string, string> = {
  'records.lock_blocker_epoch(text,text)':
    'derived concurrency token read and locked inside a disposition transaction (0400, 0430); the disposition itself is gated. Before locking it only adds ' +
    'the DI-50 link and hold that an open investigation already requires (what the scope refresh adds), refusing administrators; it never removes anything',
};

interface Fn {
  fn: string;
  src: string;
}
/** Functions of the four modules the application role may execute and that are VOLATILE (only those can write). */
async function appWritableFunctions(): Promise<Fn[]> {
  const { rows } = await db.admin.query<Fn>(`
    select p.oid::regprocedure::text as fn, p.prosrc as src
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('market', 'records', 'continuity', 'site') and p.provolatile = 'v' and p.prokind = 'f'
      and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')
    order by 1`);
  return rows;
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
  it('[DI-17] every function of market, records and continuity (and site services) that the application may call and that can write checks a known permission', async () => {
    const fns = await appWritableFunctions();
    expect(fns.length).toBeGreaterThanOrEqual(40);
    const ungated = fns.filter((f) => !f.src.includes('iam.require_permission(') && !(f.fn in UNGATED)).map((f) => f.fn);
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
    const correction = { kind: 'SOURCE_CORRECTION', description: 'EU value mis-keyed', citation: 'source re-read', approverIds: [randomUUID(), randomUUID()] };
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
    await expect(withCommand(db.app, again(admin), (c) => setSiteValue(c, { siteId: randomUUID(), key: 'tablets.compression.ipcSampleMaxInterval', value: '20', effectiveFrom: '2026-01-01' }))).rejects.toThrow(
      'EBMR-IAM-042',
    );
    await expect(
      withCommand(db.app, again(admin), (c) => definePolicy(c, { code: `adm.${randomBytes(2).toString('hex')}`, title: 't', level: 'TENANT', positions: ['OFF', 'ON'], defaultPosition: 'ON' })),
    ).rejects.toThrow('EBMR-IAM-042');
    await expect(sql(admin, "insert into market.stub_site (code, markets) values ('ADMIN-SITE', '{IN}')")).rejects.toThrow('EBMR-IAM-042');
  });

  it('[DI-17] an operator cannot write the stub master data, define a policy, pin a batch or apply a tightening; an auditor cannot record an evaluation', async () => {
    const operator = await actor('OPERATOR');
    await expect(sql(operator, "insert into market.stub_site (code, markets) values ('OP-SITE', '{IN}')")).rejects.toThrow(/EBMR-IAM-040 .*MASTERDATA\.CHANGE/);
    await expect(
      withCommand(db.app, again(await actor('QA_REVIEWER')), (c) =>
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
      withCommand(db.app, again(siteA), (c) => setSiteValue(c, { siteId, key: 'tablets.compression.ipcSampleMaxInterval', value: '20', effectiveFrom: '2026-01-01' }));
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
    const setting = (ctx: ActorContext) => sql(withReason(ctx, 'CHANGE_CONTROL', 'CC-AZ-1'), "select platform.set_setting('time.late_entry_window_min', '20')");
    await expect(setting(operator)).rejects.toThrow(/EBMR-PLAT-006 permission platform\.settings\.change denied: .*PLATFORM\.SETTINGS_CHANGE/);
    await setting(owner);
    const { rows } = await db.app.query<{ allowed: boolean; scope: Record<string, string>; role_code: string }>(
      "select allowed, scope, role_code from iam.authority_evaluation where person_id = $1 and permission_code = 'PLATFORM.SETTINGS_CHANGE'",
      [owner.personId],
    );
    expect(rows).toEqual([{ allowed: true, scope: { site: SEED_SITE }, role_code: 'PROCESS_OWNER' }]);
    const register = (ctx: ActorContext) =>
      sql(ctx, "select platform.register_time_source($1, 'NTP', 'ntp.example', 'NPL India', gen_random_uuid(), 'VAL-TS-AZ')", [`AZ ${randomBytes(3).toString('hex')}`]);
    await expect(register(operator)).rejects.toThrow('EBMR-PLAT-006');
    await register(await actor('SYSTEM_ADMINISTRATOR'));
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
    const change = (ctx: ActorContext) => sql(withReason(ctx, 'CHANGE_CONTROL', 'CC-AZ-2'), "select platform.set_setting('time.late_entry_window_min', '25')");
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
      expect(await call('platform.nothing.here', current)).toMatch(/PERMISSION_UNKNOWN/);
      await client.query('rollback');
    } finally {
      client.release();
    }
    await expect(db.app.query("select iam.platform_authority('platform.settings.change', '{}'::jsonb, 'x', 'y')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('select iam.actor_location_scope()')).rejects.toThrow(/permission denied/);
  });
});
