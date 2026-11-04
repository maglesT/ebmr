/**
 * MEDHANTA platform, Phase B slice 6 (docs/build-plan/phase-b/platform-move-plan.md, "Data move"; tools/platform): the
 * move of a standalone Batchwright onto the platform, from a copy of the GMP test installation into a platform-initialised
 * ebmr database, with stand-ins for core's identity and master_data databases (their tables as databsee db/identity and
 * db/master_data define them).
 *
 * Platform rules PL-01 (codes from core only), PL-03 (people mapped to core's employee ids), PL-07 (records keep their
 * codes), PL-08 (master items linked), PL-13 (counts, checksums, chains and signatures checked); INV-11.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { ADMIN_URL, asAdmin, bootstrapInstallation, createGmpDatabase, dropDatabase, editionMigrationSources, onServer, openDatabase, passwordActor, seedDemoSite, uniqueSuffix, urlFor, type SiteSeed } from '@ebmr/test-kit';
import { coreLoginOf, MOVE_REASON, RESET_IN_CORE, runMove, type MoveOptions, type MoveReport } from '../src/move.ts';
import { platformMigrate } from '../../../apps/tablets-server/src/cli/platform-migrate.ts';
import { TABLETS_SQL } from '../../../apps/tablets-server/src/cli/installation.ts';
import { platformInitDatabase } from '../../../apps/tablets-server/test/support/platform-db.ts';
import { routes } from '@ebmr/api-contract';
import { FakeCore } from '../../../apps/tablets-server/test/support/fake-core.ts';
import { FakeMaster } from '../../../apps/tablets-server/test/support/fake-master.ts';
import { startServer } from '../../../apps/tablets-server/test/support/harness.ts';
import { sessionOfBrowser, valueOf } from '../../../apps/tablets-server/test/esig/support.ts';

const s = uniqueSuffix();
const db = { source: `ebmr_mvsrc_${s}`, ebmr: `ebmr_mvplat_${s}`, identity: `ebmr_mvid_${s}`, masterData: `ebmr_mvmd_${s}` };
let seed: SiteSeed;

async function identitySchema(): Promise<void> {
  await onServer((c) => c.query(`create database ${db.identity}`));
  await asAdmin(db.identity, (c) => c.query(`
    create table employee (id uuid primary key default gen_random_uuid(), login text not null unique check (login ~ '^[a-z][a-z0-9._-]{1,39}$'),
      identity_verified_by text, identity_verified_how text, created_at timestamptz not null default now());
    create table employee_version (employee_id uuid not null references employee, version int not null check (version > 0), full_name text not null,
      email text, active boolean not null, changed_by uuid not null, changed_by_name text not null, changed_at timestamptz not null default now(),
      reason text not null, primary key (employee_id, version));
    create table credential (employee_id uuid primary key references employee, password_hash text not null, must_change boolean not null default true,
      changed_at timestamptz not null default now(), failed_count int not null default 0, locked_at timestamptz);
    create table permission_grant (employee_id uuid not null references employee, product text not null, code text not null check (code like product || '.%'),
      granted boolean not null, by_id uuid not null, by_name text not null, at timestamptz not null default now(), reason text not null);
    with me as (insert into employee (login) values ('mover') returning id)
    insert into employee_version (employee_id, version, full_name, active, changed_by, changed_by_name, reason)
      select id, 1, 'Platform Mover', true, id, 'Platform Mover', 'set-up' from me;`));
}

async function masterSchema(): Promise<void> {
  await onServer((c) => c.query(`create database ${db.masterData}`));
  await asAdmin(db.masterData, (c) => c.query(`
    create table item (id uuid primary key default gen_random_uuid(), kind text not null, code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
      created_at timestamptz not null default now(), unique (kind, code));
    create table item_version (item_id uuid not null references item, version int not null check (version > 0), name text not null, fields jsonb not null default '{}',
      active boolean not null, changed_by uuid not null, changed_by_name text not null, changed_at timestamptz not null default now(), reason text not null,
      primary key (item_id, version));`));
}

const q = async <T>(database: string, sql: string, params: unknown[] = []): Promise<T[]> => asAdmin(database, async (c) => (await c.query(sql, params)).rows as T[]);

let people: { login: string; account_id: string }[];
let linked: string;
let offLogin: string;
let item: { kind: string; code: string };

const options = (over: Partial<MoveOptions> = {}): MoveOptions => ({
  sourceUrl: urlFor(db.source), platformUrl: ADMIN_URL, databases: { ebmr: db.ebmr, identity: db.identity, masterData: db.masterData },
  by: 'mover', verifiedBy: 'Site QA', verifiedHow: 'badge register', commit: false, reportDir: mkdtempSync(join(tmpdir(), 'ebmr-move-')), ...over,
});

beforeAll(async () => {
  await createGmpDatabase(db.source, editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]));
  const seeding = openDatabase(db.source, 'GMP');
  try {
    seed = await seedDemoSite(seeding, 'GMP', await bootstrapInstallation(db.source, 'GMP'));
  } finally {
    await seeding.close();
  }
  await platformInitDatabase(db.ebmr);
  await platformMigrate({ url: urlFor(db.ebmr), passwords: { authn: 'x'.repeat(16), analytics: 'y'.repeat(16) }, keysDir: mkdtempSync(join(tmpdir(), 'ebmr-mv-keys-')), setLogins: false });
  await Promise.all([identitySchema(), masterSchema()]);
  people = await q(db.source, "select login_name as login, id::text as account_id from iam.account where kind = 'HUMAN' order by login_name");
  // One person core has already (linked, holding one code), one who left the site (no codes), and one master item core holds.
  const granted = await q<{ login: string }>(db.source, `select distinct a.login_name as login from iam.account a join iam.role_grant g on g.account_id = a.id
     join iam.role_permission rp on rp.role_code = g.role_code and rp.removed_at is null join iam.permission p on p.code = rp.permission_code
    where a.kind = 'HUMAN' and iam.grant_is_live(g.status, g.valid_to, g.revoked_at) and p.domain = 'GMP' order by 1 limit 2`);
  linked = granted[0]?.login ?? '';
  offLogin = granted[1]?.login ?? '';
  const handle = openDatabase(db.source, 'GMP');
  try {
    const admin = await passwordActor(handle, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST', reasonText: 'slice 6', correlationId: crypto.randomUUID() });
    await withCommand(handle.app, admin, (c) => c.query("select iam.suspend_account((select id from iam.account where login_name = $1), 'left the site')", [offLogin]));
  } finally {
    await handle.close();
  }
  await asAdmin(db.identity, async (c) => {
    const me = (await c.query<{ id: string }>("select id from employee where login = 'mover'")).rows[0]?.id;
    const id = (await c.query<{ id: string }>('insert into employee (login) values ($1) returning id', [coreLoginOf(linked)])).rows[0]?.id;
    await c.query("insert into employee_version (employee_id, version, full_name, active, changed_by, changed_by_name, reason) values ($1, 1, 'Linked Person', true, $2, 'Platform Mover', 'core')", [id, me]);
    await c.query("insert into credential (employee_id, password_hash) values ($1, 'scrypt$core')", [id]);
    await c.query("insert into permission_grant (employee_id, product, code, granted, by_id, by_name, reason) values ($1, 'ebmr', 'ebmr.record.read', true, $2, 'Platform Mover', 'core')", [id, me]);
  });
  item = (await q<{ kind: string; code: string }>(db.source, "select case when kind = 'INSTRUMENT' then 'instrument' else 'equipment' end as kind, code from plant.equipment order by code limit 1"))[0] ?? { kind: 'product', code: '' };
  if (item.code) await asAdmin(db.masterData, (c) => c.query('insert into item (kind, code) values ($1, $2)', [item.kind, item.code]));
}, 600_000);

afterAll(async () => {
  for (const d of Object.values(db)) await dropDatabase(d).catch(() => undefined);
});

describe('the move onto the platform (PL-13)', () => {
  it('[PL-03] a core login is the old login in lower case, u + it when it starts with a digit', () => {
    expect([coreLoginOf('QA.Reviewer'), coreLoginOf('1024'), coreLoginOf('a'), coreLoginOf('x'.repeat(41))]).toEqual(['qa.reviewer', 'u1024', null, null]);
  });

  let dry: MoveReport;
  it('[PL-13][PL-01] a dry run checks everything and writes nothing; a person core has, not named in --link, is refused', async () => {
    const refused = await runMove(options());
    expect(refused.result).toBe('FAIL');
    expect(refused.failures.join(' ')).toContain(`core already has login ${coreLoginOf(linked) ?? ''}`);
    dry = await runMove(options({ link: [linked] }));
    expect(dry.failures).toEqual([]);
    expect([dry.result, dry.committed, dry.drill.result, dry.restore.mismatched, dry.signatures.problems]).toEqual(['PASS', false, 'PASS', [], 0]);
    expect(dry.people.map((p) => p.login).sort()).toEqual(people.map((p) => p.login).sort());
    expect((await q<{ n: string }>(db.identity, 'select count(*)::text as n from employee'))[0]?.n).toBe('2');
    expect((await q<{ n: string }>(db.masterData, 'select count(*)::text as n from item_version'))[0]?.n).toBe('0');
    expect((await q<{ n: string }>(db.ebmr, "select count(*)::text as n from iam.account where kind = 'HUMAN'"))[0]?.n).toBe('0');
  }, 600_000);

  let done: MoveReport;
  it('[PL-13][PL-03][PL-01][INV-11] the move maps every person to core, gives codes only to people active in the source, and checks counts, chains and signatures', async () => {
    done = await runMove(options({ link: [linked], commit: true }));
    expect(done.failures).toEqual([]);
    expect([done.result, done.committed]).toEqual(['PASS', true]);
    expect(Object.values(done.checks).every(Boolean)).toBe(true);
    // The platform's ebmr database is now the moved one, a platform build; every human account maps to a core employee.
    const mapped = await q<{ login_name: string; employee_id: string }>(db.ebmr, 'select login_name, employee_id from iam.platform_identity order by 1');
    expect(mapped.map((m) => m.login_name)).toEqual(people.map((p) => coreLoginOf(p.login)).sort());
    expect((await q<{ b: boolean }>(db.ebmr, 'select iam.platform_build() as b'))[0]?.b).toBe(true);
    // New people: version 1 with the move's reason, a credential core must reset (no hash copied); the linked one untouched.
    const emp = await q<{ login: string; hash: string; must: boolean; reason: string | null }>(db.identity,
      `select e.login, c.password_hash as hash, c.must_change as must, v.reason from employee e join credential c on c.employee_id = e.id
         left join employee_version v on v.employee_id = e.id and v.reason = $1 where e.login <> 'mover' order by 1`, [MOVE_REASON]);
    for (const e of emp) {
      if (e.login === coreLoginOf(linked)) expect([e.hash, e.reason]).toEqual(['scrypt$core', null]);
      else expect([e.hash, e.must, e.reason]).toEqual([RESET_IN_CORE, true, MOVE_REASON]);
    }
    // The suspended person gets no code; the linked one only the codes they lacked; nobody holds administration and GMP codes together.
    const off = done.people.find((p) => p.login === offLogin);
    expect(off?.codes).toEqual([]);
    const link = done.people.find((p) => p.login === linked);
    expect(link?.action).toBe('LINK');
    expect(link?.codes).not.toContain('ebmr.record.read');
    expect(link?.codes.length).toBeGreaterThan(0);
    const grants = await q<{ login: string; codes: string[] }>(db.identity,
      "select e.login, array_agg(g.code) as codes from permission_grant g join employee e on e.id = g.employee_id where g.granted group by 1");
    expect(grants.find((g) => g.login === coreLoginOf(offLogin))).toBeUndefined();
    for (const g of grants) {
      const admin = g.codes.some((c) => c === 'ebmr.platform.operate' || c === 'ebmr.system.configure');
      const gmp = g.codes.some((c) => c === 'ebmr.step.execute' || c === 'ebmr.batch.issue' || c === 'ebmr.release.decide');
      expect(admin && gmp, g.login).toBe(false);
    }
    // No moved person keeps a local role grant; their codes come from core at the next sign-on.
    expect(await q(db.ebmr, `select 1 from iam.role_grant g join iam.platform_identity i on i.account_id = g.account_id
                              where iam.grant_is_live(g.status, g.valid_to, g.revoked_at)`)).toEqual([]);
  }, 900_000);

  it('[PL-08][PL-07] every master item is linked: the one core held is reused, the others created as moved items; records keep their codes', async () => {
    const links = await q<{ kind: string; local_code: string; master_id: string }>(db.ebmr, 'select kind, local_code, master_id from md.item_map');
    expect(links.length).toBe(done.items.length);
    const items = await q<{ id: string; kind: string; code: string; reason: string | null }>(db.masterData,
      'select i.id::text as id, i.kind, i.code, v.reason from item i left join item_version v on v.item_id = i.id');
    for (const l of links) expect(items.find((i) => i.id === l.master_id && i.kind === l.kind && i.code === l.local_code), `${l.kind} ${l.local_code}`).toBeDefined();
    if (item.code) expect(done.items.find((i) => i.localCode === item.code)?.action).toBe('REUSED');
    expect(items.filter((i) => i.reason === MOVE_REASON).length).toBe(done.items.filter((i) => i.action === 'CREATED').length);
  });

  it('[PL-13] the move runs once: a second run finds the platform\'s ebmr database holding records and changes nothing', async () => {
    const again = await runMove(options({ link: [linked], commit: true }));
    expect([again.result, again.committed]).toEqual(['FAIL', false]);
    expect(again.failures.join(' ')).toContain('holds records already');
  }, 300_000);

  it('[PL-03][PL-01] a moved person signs in through core as the same person, with the codes core grants', async () => {
    const core = new FakeCore();
    const master = await new FakeMaster().create();
    const server = await startServer('GMP', { prepared: { database: db.ebmr, seed }, env: { ...core.env, EBMR_MASTER_DATA_URL: master.url }, coreFetch: core.fetch });
    try {
      const p = done.people.find((x) => x.action === 'NEW' && x.codes.includes('ebmr.record.read') && !x.codes.includes('ebmr.platform.operate'));
      if (!p?.employeeId || !p.coreLogin) throw new Error('no moved person with codes');
      const b = server.browser('PC-DESIGN-01');
      const { proof } = await core.roundTrip(b, '/signin', { sub: p.employeeId, login: p.coreLogin, name: p.name, codes: p.codes });
      if (!proof) throw new Error('no sign-on proof');
      const body = { method: 'PLATFORM' as const, signonProof: proof };
      valueOf(await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } }));
      const session = await sessionOfBrowser(server, b);
      expect(session.accountId).toBe(p.accountId);
      expect(session.roleCode).toMatch(/^PLATFORM_[0-9A-F]{32}_WORK$/);
    } finally {
      await server.close();
      await master.drop();
    }
  }, 600_000);
});
