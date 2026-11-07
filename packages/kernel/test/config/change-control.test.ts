/**
 * Configuration change control (DI-09; kernel 1195; Phase 6 slice 6f, builder A).
 *
 * Every configuration change needs the number of an approved, open change record that covers its area; the database
 * refuses it otherwise, whichever function writes the row (the guard is a trigger on each configuration table). Every
 * configuration row is an insert-only version with its validity start, so the configuration of any past instant and
 * the difference between two instants are read back. Run as the application role, with bypass attempts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveChangeRecord,
  closeChangeRecord,
  configurationAsOf,
  configurationDiff,
  listChangeRecords,
  raiseChangeRecord,
  type ChangeRecordDefinition,
} from '../../src/config/change-control.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { signFor } from '../records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let owner: SeededActor;
let admin: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;
let mbrApprover: SeededActor;
let operator: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ owner, admin } = await seedAdministration(db));
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  mbrApprover = await seedActor(db, { roleCode: 'QA_MBR_APPROVER' });
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
});
afterAll(async () => {
  await db.drop();
});

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const cr = (ctx: ActorContext, changeRecord: string): ActorContext => ({ ...withReason(ctx, 'CONFIG_CHANGE', 'test change'), changeRecord });
const newNumber = (): string => `CR-${randomBytes(4).toString('hex').toUpperCase()}`;

async function raise(by: SeededActor, areas: string[], num = newNumber()): Promise<string> {
  const def: ChangeRecordDefinition = { number: num, title: `Change ${num}`, description: 'test configuration change', areas };
  await withCommand(db.app, again(by), (c) => raiseChangeRecord(c, def));
  return num;
}
async function approve(num: string, signer: SeededActor = qa): Promise<string> {
  const sig = await signFor(db, signer, { type: 'config_change_record', id: num }, 'CONFIG_CHANGE_APPROVED', 'OPEN');
  await withCommand(db.app, again(signer), (c) => approveChangeRecord(c, num, sig));
  return sig;
}
async function approvedRecord(areas: string[]): Promise<string> {
  const num = await raise(owner, areas);
  await approve(num);
  return num;
}
const setSetting = (ctx: ActorContext, key: string, value: string) =>
  withCommand(db.app, ctx, (c) => c.query('select platform.set_setting($1, $2)', [key, value]));
const dbNow = async (): Promise<string> => (await db.admin.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]!.t;

describe('a configuration change needs an approved change record (DI-09)', () => {
  let num: string;
  beforeAll(async () => {
    num = await approvedRecord(['PLATFORM_SETTING', 'IAM_POLICY', 'ESIG_POLICY', 'ESIG_MEANING']);
  });

  it('[DI-09] a configuration change without a change-record id is rejected: adapter mode, freshness bound, identity and e-signature policy, signature catalogue', async () => {
    await expect(setSetting(withReason(owner), 'integration.mode.qms_status', 'MIRROR')).rejects.toThrow('EBMR-CFG-001');
    await expect(setSetting(withReason(owner), 'integration.mirror_max_age_s.lms_qualification', '1800')).rejects.toThrow('EBMR-CFG-001');
    await expect(
      withCommand(db.app, withReason(admin), (c) => c.query("select iam.set_policy('credential.password_history', '6', 'longer password history')")),
    ).rejects.toThrow('EBMR-CFG-001');
    await expect(
      withCommand(db.app, withReason(mbrApprover), (c) => c.query("select esig.set_policy('esig.challenge_validity_seconds', '90', 'tighter', 'CC-1')")),
    ).rejects.toThrow(/EBMR-CFG-001|EBMR-ESIG-002/);
    await expect(
      withCommand(db.app, again(mbrApprover), (c) =>
        c.query("select esig.configure_meaning_type('CONFIG_CHANGE_APPROVED', '{\"title\": \"Changed\"}'::jsonb, 'retitle')")),
    ).rejects.toThrow('EBMR-CFG-001');
    // Nothing was written: no version of these items under a change record.
    const { rows } = await db.admin.query("select 1 from platform.config_version where basis = 'CHANGE_RECORD'");
    expect(rows).toEqual([]);
  });

  it('[DI-09] the same changes under an approved change record are accepted and become versions naming the record', async () => {
    await setSetting(cr(owner, num), 'integration.mode.qms_status', 'MIRROR');
    await setSetting(cr(owner, num), 'integration.mirror_max_age_s.lms_qualification', '1800');
    await withCommand(db.app, cr(admin, num), (c) => c.query("select iam.set_policy('credential.password_history', '6', 'longer password history')"));
    const { rows } = await db.admin.query<{ area: string; item_key: string; value: unknown; number: string; person_id: string }>(
      `select v.area, v.item_key, v.value, c.number, v.person_id::text from platform.config_version v join platform.change_record c on c.id = v.change_record_id
        where c.number = $1 order by v.id`,
      [num],
    );
    expect(rows).toEqual([
      { area: 'PLATFORM_SETTING', item_key: 'integration.mode.qms_status', value: { value: 'MIRROR' }, number: num, person_id: owner.personId },
      { area: 'PLATFORM_SETTING', item_key: 'integration.mirror_max_age_s.lms_qualification', value: { value: '1800' }, number: num, person_id: owner.personId },
      { area: 'IAM_POLICY', item_key: 'credential.password_history', value: { value: '6' }, number: num, person_id: admin.personId },
    ]);
    // Each version is in the audit trail (the configuration audit trail of DI-09), with the row's hash.
    const audit = await db.admin.query<{ n: string }>(
      `select count(*)::text as n from kernel.audit_event e join platform.config_version v on e.record_id = v.id::text
        join platform.change_record c on c.id = v.change_record_id where c.number = $1 and e.chain_key = 'config_area:' || v.area`,
      [num],
    );
    expect(audit.rows[0]?.n).toBe('3');
  });

  it('[DI-09] an unknown, unapproved, closed or other-area change record is refused', async () => {
    await expect(setSetting(cr(owner, 'CR-NOPE'), 'integration.mode.qms_status', 'STAND_IN')).rejects.toThrow('EBMR-CFG-002');
    const open = await raise(owner, ['PLATFORM_SETTING']);
    await expect(setSetting(cr(owner, open), 'integration.mode.qms_status', 'STAND_IN')).rejects.toThrow('EBMR-CFG-003');
    const other = await approvedRecord(['SITE_VALUE']);
    await expect(setSetting(cr(owner, other), 'integration.mode.qms_status', 'STAND_IN')).rejects.toThrow('EBMR-CFG-004');
    const closed = await approvedRecord(['PLATFORM_SETTING']);
    await setSetting(cr(owner, closed), 'integration.mode.qms_status', 'STAND_IN');
    await withCommand(db.app, again(owner), (c) => closeChangeRecord(c, closed, 'implemented and verified'));
    await expect(setSetting(cr(owner, closed), 'integration.mode.qms_status', 'MIRROR')).rejects.toThrow('EBMR-CFG-003');
    expect((await withCommand(db.app, again(owner), (c) => listChangeRecords(c, closed)))[0]).toMatchObject({ state: 'CLOSED', areas: ['PLATFORM_SETTING'] });
  });

  it('[DI-09] bypass attempts: the application role cannot write a configuration table or a change record directly, and a hand-set context does not count', async () => {
    await expect(db.app.query("insert into platform.setting_value (key, value, set_by_person, reason_code) values ('integration.mode.qms_status', 'MIRROR', 'x', 'x')")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.app.query("insert into platform.change_record (number, title, description, areas, raised_by_person, raised_by_account) values ('CR-X', 't', 'd', '{PLATFORM_SETTING}', gen_random_uuid(), gen_random_uuid())")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into platform.change_record_event (change_record_id, event, signature_id, person_id, account_id) select id, 'APPROVED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from platform.change_record limit 1")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('select platform.require_change_record($1, $2)', ['PLATFORM_SETTING', 'x'])).rejects.toThrow(/permission denied/);
    // A context written with set_config (claiming a change record, or the release identity) is not a validated context.
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('ebmr.ctx', $1, true)", [
        JSON.stringify({ person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'SOFTWARE_RELEASE', source: 'SYSTEM', change_record: num }),
      ]);
      await expect(c.query("select platform.set_setting('integration.mode.qms_status', 'MIRROR')")).rejects.toThrow(/EBMR-PLAT-001|EBMR-AUDIT|EBMR-CFG/);
    } finally {
      await c.query('rollback');
      c.release();
    }
    // The release identity cannot be claimed through a command.
    await expect(
      withCommand(db.app, { personId: '00000000-0000-0000-0000-000000000000', accountId: '00000000-0000-0000-0000-000000000000', roleCode: 'SOFTWARE_RELEASE', sessionId: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', siteZone: 'UTC' }, (cl) =>
        cl.query("select platform.set_setting('integration.mode.qms_status', 'MIRROR')")),
    ).rejects.toThrow(/EBMR-/);
    const { rows } = await db.admin.query("select value from platform.setting_value where key = 'integration.mode.qms_status' order by id desc limit 1");
    expect(rows[0]).toEqual({ value: 'STAND_IN' });
  });
});

describe('change records: raised, approved by the quality unit with an e-signature, closed (DI-09)', () => {
  it('[DI-09] only authorised people raise a change record; it names known areas, a number, a title and a description', async () => {
    await expect(raise(operator, ['PLATFORM_SETTING'])).rejects.toThrow('EBMR-IAM-040');
    await expect(raise(admin, ['PLATFORM_SETTING'])).rejects.toThrow('EBMR-IAM-042');
    await expect(raise(owner, [])).rejects.toThrow('EBMR-CFG-011');
    await expect(raise(owner, ['NO_SUCH_AREA'])).rejects.toThrow('EBMR-CFG-011');
    const num = await raise(owner, ['PLATFORM_SETTING']);
    await expect(raise(owner, ['PLATFORM_SETTING'], num)).rejects.toThrow('EBMR-CFG-012');
    await expect(
      withCommand(db.app, again(owner), (c) => raiseChangeRecord(c, { number: newNumber(), title: ' ', description: 'd', areas: ['PLATFORM_SETTING'] })),
    ).rejects.toThrow('EBMR-CFG-012');
  });

  it('[DI-09] the approval is the e-signature of another person of the quality unit, recorded by that person; the raiser cannot approve', async () => {
    const num = await raise(mbrApprover, ['PLATFORM_SETTING']);
    // The raiser is excluded from signing their own record (the signature catalogue's performer exclusion) ...
    await expect(signFor(db, mbrApprover, { type: 'config_change_record', id: num }, 'CONFIG_CHANGE_APPROVED', 'OPEN')).rejects.toThrow(/EBMR-ESIG/);
    // ... someone without the permission cannot record an approval ...
    const sig = await signFor(db, qa, { type: 'config_change_record', id: num }, 'CONFIG_CHANGE_APPROVED', 'OPEN');
    await expect(withCommand(db.app, again(owner), (c) => approveChangeRecord(c, num, sig))).rejects.toThrow('EBMR-IAM-040');
    // ... another approver cannot record someone else's signature, a random id is no signature ...
    await expect(withCommand(db.app, again(qa2), (c) => approveChangeRecord(c, num, sig))).rejects.toThrow('EBMR-CFG-014');
    await expect(withCommand(db.app, again(qa), (c) => approveChangeRecord(c, num, randomUUID()))).rejects.toThrow('EBMR-ESIG-070');
    // ... the signature of another record does not approve this one.
    const other = await raise(owner, ['PLATFORM_SETTING']);
    const otherSig = await signFor(db, qa2, { type: 'config_change_record', id: other }, 'CONFIG_CHANGE_APPROVED', 'OPEN');
    await expect(withCommand(db.app, again(qa2), (c) => approveChangeRecord(c, num, otherSig))).rejects.toThrow('EBMR-ESIG-070');
    await withCommand(db.app, again(qa), (c) => approveChangeRecord(c, num, sig));
    const [rec] = await withCommand(db.app, again(qa), (c) => listChangeRecords(c, num));
    expect(rec).toMatchObject({ state: 'APPROVED', approvedBy: qa.personId, raisedBy: mbrApprover.personId });
    await expect(approve(num, qa2)).rejects.toThrow(/EBMR-CFG-013|EBMR-ESIG/);
  });

  it('[DI-09] a change record cannot be approved after it is closed, nor closed twice, nor closed without a note', async () => {
    const num = await raise(owner, ['PLATFORM_SETTING']);
    await expect(withCommand(db.app, again(owner), (c) => closeChangeRecord(c, num, ' '))).rejects.toThrow('EBMR-CFG-015');
    await withCommand(db.app, again(owner), (c) => closeChangeRecord(c, num, 'withdrawn'));
    await expect(withCommand(db.app, again(owner), (c) => closeChangeRecord(c, num, 'again'))).rejects.toThrow('EBMR-CFG-015');
    await expect(approve(num)).rejects.toThrow(/EBMR-CFG-013|EBMR-ESIG/);
  });
});

describe('configuration versions and the diff for a past date (DI-09, D-P6f-1)', () => {
  it('[DI-09] a configuration diff for a past date: the configuration valid then, and what changed since, with the change records', async () => {
    const first = await approvedRecord(['PLATFORM_SETTING']);
    await setSetting(cr(owner, first), 'integration.mirror_max_age_s.cmms_calibration', '3000');
    const t1 = await dbNow();
    const second = await approvedRecord(['PLATFORM_SETTING', 'IAM_POLICY']);
    await setSetting(cr(owner, second), 'integration.mirror_max_age_s.cmms_calibration', '2400');
    await withCommand(db.app, cr(admin, second), (c) => c.query("select iam.set_policy('credential.password_history', '7', 'longer again')"));
    const t2 = await dbNow();

    const then = await withCommand(db.app, again(qa), (c) => configurationAsOf(c, t1, 'PLATFORM_SETTING'));
    expect(then.find((v) => v.itemKey === 'integration.mirror_max_age_s.cmms_calibration')).toMatchObject({ value: { value: '3000' }, changeRecord: first, basis: 'CHANGE_RECORD' });
    const now = await withCommand(db.app, again(qa), (c) => configurationAsOf(c, t2, 'PLATFORM_SETTING'));
    expect(now.find((v) => v.itemKey === 'integration.mirror_max_age_s.cmms_calibration')).toMatchObject({ value: { value: '2400' }, changeRecord: second });

    const diff = await withCommand(db.app, again(qa), (c) => configurationDiff(c, t1, t2));
    expect(diff).toEqual([
      { area: 'IAM_POLICY', itemKey: 'credential.password_history', before: { value: '6' }, after: { value: '7' }, changeRecords: [second] },
      { area: 'PLATFORM_SETTING', itemKey: 'integration.mirror_max_age_s.cmms_calibration', before: { value: '3000' }, after: { value: '2400' }, changeRecords: [second] },
    ]);
    // An instant before any change of the item: no version yet, so the diff shows it appearing.
    const before = await withCommand(db.app, again(qa), (c) => configurationDiff(c, '2000-01-01T00:00:00Z', t1, 'PLATFORM_SETTING'));
    expect(before.find((d) => d.itemKey === 'integration.mirror_max_age_s.cmms_calibration')).toMatchObject({ before: null, after: { value: '3000' } });
    await expect(withCommand(db.app, again(qa), (c) => configurationDiff(c, t2, t1))).rejects.toThrow('EBMR-CFG-016');
  });

  it('[DI-09] the history starts complete: rows written before change control and by the software release are versions too', async () => {
    const { rows } = await db.admin.query<{ area: string; basis: string }>(
      'select distinct area, basis from platform.config_version where basis <> $1 order by 1, 2', ['CHANGE_RECORD'],
    );
    expect(rows).toContainEqual({ area: 'ESIG_MEANING', basis: 'BEFORE_CONTROL' });
    const meanings = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from esig.meaning_type m where not exists (select 1 from platform.config_version v where v.area = 'ESIG_MEANING' and v.item_key = m.code and (v.value ->> 'version')::int = m.version)",
    );
    expect(meanings.rows[0]?.n).toBe('0');
    // Versions are insert-only for every role.
    await expect(db.app.query('update platform.config_version set value = $1', ['{}'])).rejects.toThrow(/permission denied/);
    await expect(db.admin.query("update platform.config_version set value = '{}' where id = (select min(id) from platform.config_version)")).rejects.toThrow(/EBMR-/);
  });
});

/** Table names that look like configuration (values, versions, policies, settings, limits, rules) and their status. */
const NOT_CONFIGURATION: Record<string, string> = {
  'platform.setting_definition': 'definitions of settings: shipped by the software release (migrations), not site configuration',
  'iam.policy_key': 'definitions of identity policies: shipped by the release',
  'esig.policy_key': 'definitions of e-signature policies: shipped by the release',
  'market.policy': 'definitions of policy switches; each change of a switch is a market.policy_version row (MARKET_POLICY)',
  'market.batch_policy_pin': 'a batch record: the policy version pinned to one batch at issue (INV-47), not configuration',
  'market.rule_table': 'regulatory rule tables: published documents with their own signed approval (source corrections)',
  'market.rule_table_version': 'regulatory rule tables: published documents with their own signed approval (source corrections)',
  'market.rule_row': 'rows of a published rule table',
  'market.rule_key': 'keys of a published rule table',
  'market.stub_mbr_limit': 'stub master data of the market engine (sandbox), not configuration',
  'iam.esig_policy': 'per-person e-signature policy acknowledgements, not configuration',
  'iam.delegation': "a person's own signed delegation to another person (an IAM act); whether a meaning may be delegated is ESIG_MEANING",
  'iam.role_permission_request': 'the two-person request for a role-permission change; the change itself is ROLE_PERMISSION',
  'iam.role_grant': "a person's role assignment: their own signed IAM act (two persons), not configuration",
  'platform.config_version': 'the configuration history itself',
  'platform.config_area': 'the registry of configuration areas, written by migrations only',
};

describe('every configuration table is under change control (DI-09 scan)', () => {
  it('[DI-09] every registered configuration table carries the guard and the version log, enabled', async () => {
    const { rows } = await db.admin.query<{ code: string; t: string; guard: boolean; log: boolean }>(`
      select a.code, a.table_name::text as t,
             exists (select 1 from pg_trigger g where g.tgrelid = a.table_name and g.tgname = 'a00_config_change' and g.tgenabled in ('O', 'A')) as guard,
             exists (select 1 from pg_trigger g where g.tgrelid = a.table_name and g.tgname = 'zz_config_version' and g.tgenabled in ('O', 'A')) as log
      from platform.config_area a order by a.code`);
    expect(rows.map((r) => r.code)).toEqual(expect.arrayContaining(['ESIG_MEANING', 'ESIG_POLICY', 'IAM_POLICY', 'MARKET_POLICY', 'PLATFORM_SETTING', 'SITE_VALUE', 'ROLE', 'ROLE_PERMISSION', 'RETENTION_RULE_SET', 'RETENTION_RULE']));
    expect(rows.filter((r) => !r.guard || !r.log)).toEqual([]);
  });

  it('[DI-09] every table whose name marks it as configuration is registered or listed here with the reason it is not configuration', async () => {
    const { rows } = await db.admin.query<{ t: string; registered: boolean }>(`
      select c.oid::regclass::text as t, exists (select 1 from platform.config_area a where a.table_name = c.oid) as registered
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', 'public')
        and c.relname ~ '(setting|policy|policies|site_value|limit_set|alarm_limit|rbe_rule|config|^role$|^role_permission|^role_grant$|retention_rule|delegation)'
      order by 1`);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => !r.registered && !(r.t in NOT_CONFIGURATION)).map((r) => r.t)).toEqual([]);
  });
});

describe('roles, permission sets and retention rules are configuration (DI-09, D-P6f-A-9)', () => {
  const grantAs = (ctx: ActorContext, role: string, permission: string) =>
    withCommand(db.app, ctx, async (c) => (await c.query<{ id: string }>('select iam.add_role_permission($1, $2, $3) as id', [role, permission, 'test change'])).rows[0]!.id);
  const decideAs = (ctx: ActorContext, request: string) => withCommand(db.app, ctx, (c) => c.query('select iam.decide_role_permission($1, true, $2)', [request, 'approved']));

  it('[DI-09] a role definition, a permission added to a role and one removed from it each need a change record; each is a version naming it', async () => {
    const code = `ROLE_${randomBytes(3).toString('hex').toUpperCase()}`;
    const create = (ctx: ActorContext) =>
      withCommand(db.app, ctx, (c) => c.query("select iam.create_role($1, 'Test role', 'EXECUTION', 'a test role', array['HUMAN'])", [code]));
    await expect(create(withReason(admin))).rejects.toThrow('EBMR-CFG-001');
    const other = await approvedRecord(['PLATFORM_SETTING']);
    await expect(create(cr(admin, other))).rejects.toThrow('EBMR-CFG-004');
    const num = await approvedRecord(['ROLE', 'ROLE_PERMISSION']);
    await create(cr(admin, num));
    // The two-person permission change: the request is not configuration; the approval that adds the permission is.
    const request = await grantAs(cr(admin, num), code, 'INCIDENT.RAISE');
    await expect(decideAs(withReason(owner), request)).rejects.toThrow('EBMR-CFG-001');
    await decideAs(cr(owner, num), request);
    await expect(
      withCommand(db.app, withReason(admin), (c) => c.query('select iam.remove_role_permission($1, $2)', [code, 'INCIDENT.RAISE'])),
    ).rejects.toThrow('EBMR-CFG-001');
    await withCommand(db.app, cr(admin, num), (c) => c.query('select iam.remove_role_permission($1, $2)', [code, 'INCIDENT.RAISE']));
    const { rows } = await db.admin.query<{ area: string; item_key: string; removed: boolean; cr: string }>(
      `select v.area, v.item_key, (v.value ->> 'removed_at') is not null as removed, c.number as cr from platform.config_version v
         join platform.change_record c on c.id = v.change_record_id where v.item_key like $1 order by v.id`,
      [`${code}%`],
    );
    expect(rows).toEqual([
      { area: 'ROLE', item_key: code, removed: false, cr: num },
      { area: 'ROLE_PERMISSION', item_key: `${code}|INCIDENT.RAISE`, removed: false, cr: num },
      { area: 'ROLE_PERMISSION', item_key: `${code}|INCIDENT.RAISE`, removed: true, cr: num },
    ]);
    // Valid from: the addition from the row's own validity column, the removal (an UPDATE) from the moment it was made,
    // so a diff for a date between the two still shows the permission (slice 6j mutation triage, platform.config_version_log).
    const valid = await db.admin.query<{ added: boolean; removed_later: boolean }>(
      `select bool_and(v.valid_from = p.added_at) filter (where v.value ->> 'removed_at' is null) as added,
              bool_and(v.valid_from > p.added_at and v.valid_from >= p.removed_at) filter (where v.value ->> 'removed_at' is not null) as removed_later
         from platform.config_version v join iam.role_permission p on p.role_code = $1 and p.permission_code = 'INCIDENT.RAISE'
        where v.area = 'ROLE_PERMISSION' and v.item_key = $2`,
      [code, `${code}|INCIDENT.RAISE`],
    );
    expect(valid.rows[0]).toEqual({ added: true, removed_later: true });
    // Bypass: the application role cannot write the tables directly.
    await expect(db.app.query("update iam.role_permission set removed_at = now() where role_code = 'QA_REVIEWER'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into records.retention_rule_set (version, note) values ('X', 'x')")).rejects.toThrow(/permission denied/);
  });

  it('[DI-09] the retention rules and the permission sets shipped before change control are versions too, valid from when they were published', async () => {
    const { rows } = await db.admin.query<{ n: string; m: string }>(
      `select (select count(*) from records.retention_rule r join records.retention_rule_set s on s.version = r.rule_set_version
                where s.version in (select v.item_key from platform.config_version v where v.area = 'RETENTION_RULE_SET' and v.basis = 'BEFORE_CONTROL'))::text as n,
              (select count(*) from platform.config_version v where v.area = 'RETENTION_RULE' and v.basis = 'BEFORE_CONTROL'
                  and v.valid_from = (select s.published_at from records.retention_rule_set s where s.version = v.source_row ->> 'rule_set_version'))::text as m`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    expect(rows[0]!.m).toBe(rows[0]!.n);
    // A rule set a later release publishes (RET-2026.2, kernel 1405) is recorded as it is written: every rule a version,
    // never valid before its set was published.
    const later = await db.admin.query<{ n: string; m: string }>(
      `select (select count(*) from records.retention_rule r where r.rule_set_version not in
                (select v.item_key from platform.config_version v where v.area = 'RETENTION_RULE_SET' and v.basis = 'BEFORE_CONTROL'))::text as n,
              (select count(*) from platform.config_version v where v.area = 'RETENTION_RULE' and v.basis = 'RELEASE'
                  and v.valid_from >= (select s.published_at from records.retention_rule_set s where s.version = v.source_row ->> 'rule_set_version'))::text as m`,
    );
    expect(later.rows[0]!.m).toBe(later.rows[0]!.n);
    const live = await db.admin.query<{ n: string }>(
      `select count(*)::text as n from iam.role_permission p where p.removed_at is null and not exists (
         select 1 from platform.config_as_of(clock_timestamp()) v where v.area = 'ROLE_PERMISSION' and v.item_key = p.role_code || '|' || p.permission_code
           and v.value ->> 'removed_at' is null)`,
    );
    expect(live.rows[0]?.n).toBe('0');
  });
});
