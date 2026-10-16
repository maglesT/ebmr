/**
 * The site policy site.zone holds the IANA time zone name of the site's place, or UTC (DI-27; kernel
 * 0940, EBMR-IAM-119).
 *
 * Every actor context must declare the site's zone (EBMR-IAM-118, EBMR-ESIG-035), and the kernel
 * derives dates and offsets from it: the signature row's UTC offset and the manifestation's local
 * signing time (esig 0220), the market's "today" (0340), entry times (platform.entry_site_zone,
 * EBMR-PLAT-017) and the site date that ends retention (EBMR-REC-020). An abbreviation such as IST is
 * read by PostgreSQL as its own abbreviation (Israel, +02:00, in the default set), not India's
 * +05:30; a bare offset carries no daylight-saving rules; a mistyped name is no zone at all; and the
 * fixed-offset names of the Etc area carry inverted POSIX signs (Etc/GMT+5 is five hours behind UTC),
 * so a site at +05:00 that picks Etc/GMT+5 would be ten hours off. So the site rule
 * (iam.is_valid_site_zone) takes a name platform.is_valid_time_zone accepts only when it lies in one of
 * the geographic areas of the IANA database, or is UTC or Etc/UTC. Whether a link name such as
 * Asia/Calcutta is known depends on the time zone data installed with the database server, so no test
 * here relies on one either way.
 *
 * The rule holds where the value is recorded, not only in iam.set_policy: a row guard on
 * iam.policy_value refuses such a site.zone row whoever inserts it. The migration takes the table's
 * lock before it checks the zone in force, so a set_policy call already under way when it is applied
 * cannot leave a value it would refuse: either the migration waits for that call and then refuses
 * (naming the value), or the call waits for the migration and the row guard refuses it.
 *
 * Review finding K1 (phase-2/recipe-core merge review, 28 September 2026) and its residuals found by
 * the round-1 verifier (the migration gate could be raced; Etc/GMT+N names were accepted).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../src/db/command.ts';
import { KERNEL_MIGRATIONS, migrate } from '../../src/db/migrate.ts';
import { setPolicy } from '../../src/identity/admin.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { expectRefused } from './helpers.ts';
import { SEED_ZONE, seedActor, seedAdministration, withReason, type SeedAdministration, type SeededActor } from './seed.ts';

let db: TestDatabase;
let adm: SeedAdministration;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  adm = await seedAdministration(db);
});
afterAll(async () => {
  await db.drop();
});

/** The site policy site.zone as the kernel reads it now. */
async function zoneOf(database: TestDatabase): Promise<string> {
  const { rows } = await database.app.query<{ z: string }>("select iam.policy_text('site.zone') as z");
  const zone = rows[0]?.z;
  if (zone === undefined) throw new Error('no site.zone');
  return zone;
}
const siteZone = (): Promise<string> => zoneOf(db);

/** Recorded values of site.zone and their audit events (the policy history is insert-only and audited). */
async function trail(): Promise<{ values: number; events: number }> {
  const { rows } = await db.admin.query<{ values: string; events: string }>(
    `select (select count(*) from iam.policy_value where key = 'site.zone') as values,
            (select count(*) from kernel.audit_event where chain_key = 'iam_policy:site.zone') as events`,
  );
  return { values: Number(rows[0]?.values), events: Number(rows[0]?.events) };
}

/** The administrator sets site.zone, declaring the zone in force now (EBMR-IAM-118 refuses any other). */
async function setSiteZone(value: string, reason = 'DI-27 test: the site time zone'): Promise<void> {
  const declared = await siteZone();
  await withCommand(db.app, underChange(withReason({ ...adm.admin, siteZone: declared }, 'POLICY_CHANGE', reason)), (c) => setPolicy(c, 'site.zone', value, reason));
}

// Whatever a test does, the site is back in the seed's zone for the next one.
afterEach(async () => {
  if ((await siteZone()) !== SEED_ZONE) await setSiteZone(SEED_ZONE, 'DI-27 test: back to the seed zone');
});

const noWork = (): Promise<void> => Promise.resolve();

/** The refusal of a site.zone value, from iam.set_policy and from the row guard alike. */
const REFUSAL = /^EBMR-IAM-119 DI-27: site\.zone takes an IANA time zone name \(Area\/Location in a geographic area, or UTC\) that the database knows; '.*' is not one$/;

/** The geographic areas of the IANA time zone database: a site lies in one of them. */
const GEOGRAPHIC_AREAS = ['Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific'];

/** The site rule, written out here on its own: a name platform.is_valid_time_zone accepts, in a geographic area, or UTC. */
const siteRule = (zone: string, platformValid: boolean): boolean =>
  platformValid && (zone === 'UTC' || zone === 'Etc/UTC' || GEOGRAPHIC_AREAS.includes(zone.split('/')[0] ?? ''));

async function platformValid(zone: string): Promise<boolean> {
  const { rows } = await db.app.query<{ v: boolean }>('select platform.is_valid_time_zone($1) as v', [zone]);
  return rows[0]?.v === true;
}

/** `work` in a superuser transaction that is always rolled back; the error it raised, or null. */
async function rolledBack(database: TestDatabase, work: (c: pg.PoolClient) => Promise<unknown>): Promise<unknown> {
  const c = await database.admin.connect();
  try {
    await c.query('begin');
    await work(c);
    return null;
  } catch (error) {
    return error;
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** A site.zone row written straight into iam.policy_value in a validated command, as `role` (null: the superuser itself). */
async function insertSiteZoneRow(c: pg.PoolClient, actor: SeededActor, role: string | null, value: string): Promise<void> {
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(underChange(withReason(actor, 'TEST_SETUP', 'DI-27 test: a site.zone row written directly'))))]);
  if (role !== null) await c.query(`set local role ${role}`);
  await c.query(
    "insert into iam.policy_value (key, value, set_by_person, set_by_account, reason) values ('site.zone', $1, $2, $3, 'DI-27 test: written directly')",
    [value, actor.personId, actor.accountId],
  );
}

describe('the site policy site.zone takes only the IANA time zone name of a place, or UTC (DI-27, EBMR-IAM-119)', () => {
  it('[DI-27] IST, a bare offset and an unknown or mistyped zone name are refused (EBMR-IAM-119); nothing is recorded or audited and the site keeps its zone', async () => {
    expect(await siteZone()).toBe(SEED_ZONE);
    const before = await trail();
    for (const value of [
      'IST', // an abbreviation: PostgreSQL reads it as its own abbreviation, not India's +05:30
      'EST',
      'GMT',
      '+05:30', // a bare offset: no daylight-saving rules
      '+0530',
      'UTC+05:30',
      '5.5',
      'Asia/Kolkatta', // a typo
      'Mars/Olympus', // well formed, unknown to the database
      'asia/kolkata', // zone names are case-sensitive
      'EST5EDT', // a POSIX-style rule name, not Area/Location
      '',
      '   ',
    ]) {
      await expectRefused(setSiteZone(value), 'EBMR-IAM-119', REFUSAL);
      expect([value, await siteZone()]).toEqual([value, SEED_ZONE]);
    }
    expect(await trail()).toEqual(before);
    // A context declaring the refused text is still refused, since the site keeps its zone (EBMR-IAM-118).
    await expectRefused(withCommand(db.app, { ...adm.admin, siteZone: 'IST', correlationId: randomUUID() }, noWork), 'EBMR-IAM-118');
  });

  it('[DI-27] a valid IANA zone is accepted and becomes the site zone every context must declare; UTC and a three-part name too', async () => {
    const before = await trail();
    await setSiteZone('Europe/Berlin');
    expect(await siteZone()).toBe('Europe/Berlin');
    // Every context now declares the new zone; the old one is refused (EBMR-IAM-118).
    await expectRefused(withCommand(db.app, { ...adm.admin, siteZone: SEED_ZONE, correlationId: randomUUID() }, noWork), 'EBMR-IAM-118');
    await withCommand(db.app, { ...adm.admin, siteZone: 'Europe/Berlin', correlationId: randomUUID() }, noWork);
    await setSiteZone('UTC');
    expect(await siteZone()).toBe('UTC');
    await setSiteZone('America/Argentina/Buenos_Aires');
    expect(await siteZone()).toBe('America/Argentina/Buenos_Aires');
    // Surrounding blanks are trimmed before the check, as for every policy value.
    await setSiteZone(`  ${SEED_ZONE} `);
    expect(await siteZone()).toBe(SEED_ZONE);
    expect(await trail()).toEqual({ values: before.values + 4, events: before.events + 4 });
  });

  it('[DI-27] the fixed-offset names of the Etc area are refused (EBMR-IAM-119) though the database knows them: Etc/GMT+5 is five hours behind UTC; Etc/UTC alone is accepted', async () => {
    const { rows } = await db.admin.query<{ name: string; offset: string }>(
      "select name, utc_offset::text as offset from pg_timezone_names where name like 'Etc/%' and name <> 'Etc/UTC' order by name",
    );
    const offsets = new Map(rows.map((r) => [r.name, r.offset]));
    // The inverted POSIX sign that makes these names a trap for a site east of Greenwich.
    expect([offsets.get('Etc/GMT+5'), offsets.get('Etc/GMT-5')]).toEqual(['-05:00:00', '05:00:00']);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    const before = await trail();
    for (const { name } of rows) {
      // platform.is_valid_time_zone (EBMR-PLAT-017) accepts them; the site rule is the stricter one.
      expect([name, await platformValid(name)]).toEqual([name, true]);
      await expectRefused(setSiteZone(name), 'EBMR-IAM-119', REFUSAL);
      expect([name, await siteZone()]).toEqual([name, SEED_ZONE]);
    }
    expect(await trail()).toEqual(before);
    await setSiteZone('Etc/UTC');
    expect(await siteZone()).toBe('Etc/UTC');
  });

  it('[DI-27] iam.set_policy records a zone exactly when the site rule accepts it: a name platform.is_valid_time_zone accepts (EBMR-PLAT-017) in a geographic area, or UTC or Etc/UTC', async () => {
    const candidates = [
      'Asia/Kolkata', 'Etc/UTC', 'Europe/Berlin', 'UTC', 'Asia/Calcutta', 'America/Argentina/Buenos_Aires',
      'Etc/GMT-5', 'Etc/GMT+5', 'Etc/GMT', 'Etc/Zulu', 'US/Eastern', 'posix/Asia/Kolkata',
      'IST', '+05:30', 'Z', 'Etc', 'Asia/', '/Kolkata', 'Asia//Kolkata', 'Asia/Kolkata/',
    ];
    let accepted = 0;
    for (const value of candidates) {
      const valid = siteRule(value, await platformValid(value));
      let refusal: string | undefined;
      try {
        await setSiteZone(value);
      } catch (error) {
        refusal = ebmrCode(error) ?? String(error);
      }
      expect([value, refusal]).toEqual([value, valid ? undefined : 'EBMR-IAM-119']);
      if (valid) {
        accepted += 1;
        expect(await siteZone()).toBe(value);
      }
    }
    // The list holds both kinds whatever time zone data the database has (a link name such as
    // Asia/Calcutta or US/Eastern may or may not be known), so the comparison proves something either way.
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(candidates.length - accepted).toBeGreaterThanOrEqual(12);
  });

  it('[DI-27] over every zone name the database knows, iam.is_valid_site_zone is the site rule: it never accepts what platform.is_valid_time_zone refuses', async () => {
    const { rows } = await db.admin.query<{ name: string; platform: boolean; site: boolean }>(
      `select n.name, platform.is_valid_time_zone(n.name) as platform, iam.is_valid_site_zone(n.name) as site
       from (select name from pg_timezone_names union select 'UTC' union select 'IST' union select 'Etc/GMT+5') n`,
    );
    const mismatches = rows.filter((r) => r.site !== siteRule(r.name, r.platform)).map((r) => r.name);
    expect(mismatches).toEqual([]);
    expect(rows.filter((r) => r.site).length).toBeGreaterThanOrEqual(300);
    expect(rows.filter((r) => r.platform && !r.site).length).toBeGreaterThanOrEqual(25);
  });

  it('[DI-27] the zone check does not open the policy to anyone else: a person without IAM.POLICY_MANAGE is refused before the value is looked at', async () => {
    const operator = await seedActor(db);
    await expectRefused(
      withCommand(db.app, underChange(withReason(operator, 'POLICY_CHANGE')), (c) => setPolicy(c, 'site.zone', 'Europe/Berlin', 'not mine to change')),
      'EBMR-IAM-040',
    );
    await expectRefused(
      withCommand(db.app, underChange(withReason(operator, 'POLICY_CHANGE')), (c) => setPolicy(c, 'site.zone', 'IST', 'not mine to change')),
      'EBMR-IAM-040',
    );
    expect(await siteZone()).toBe(SEED_ZONE);
  });
});

describe('the table iam.policy_value itself refuses a site.zone row the site rule refuses (DI-27, EBMR-IAM-119)', () => {
  it('[DI-27] a site.zone row written without iam.set_policy is refused by the row guard, whoever writes it: the owner ebmr_owner (as any SECURITY DEFINER code) or the superuser; valid zones and other keys pass', async () => {
    const before = await trail();
    for (const role of ['ebmr_owner', null]) {
      for (const value of ['IST', '+05:30', 'Asia/Kolkatta', 'Etc/GMT+5', '']) {
        const refused = await rolledBack(db, (c) => insertSiteZoneRow(c, adm.admin, role, value));
        expect([role, value, ebmrCode(refused)]).toEqual([role, value, 'EBMR-IAM-119']);
        expect(String((refused as Error).message)).toMatch(REFUSAL);
      }
      const recorded = await rolledBack(db, async (c) => {
        await insertSiteZoneRow(c, adm.admin, role, 'Europe/Berlin');
        await c.query(
          "insert into iam.policy_value (key, value, set_by_person, set_by_account, reason) values ('authn.lockout_threshold', '4', $1, $2, 'DI-27 test: another key')",
          [adm.admin.personId, adm.admin.accountId],
        );
        const { rows } = await c.query<{ z: string }>("select iam.policy_text('site.zone') as z");
        expect(rows[0]?.z).toBe('Europe/Berlin');
      });
      expect([role, recorded]).toEqual([role, null]);
    }
    expect(await trail()).toEqual(before);
    expect(await siteZone()).toBe(SEED_ZONE);
  });

  it('[DI-27] iam.set_policy checks the zone itself as well: with the row guard disabled (only a superuser can do that), it still refuses (EBMR-IAM-119)', async () => {
    const guardOff = (c: pg.PoolClient) => c.query('alter table iam.policy_value disable trigger aa_site_zone_iam_policy_value');
    for (const value of ['IST', 'Etc/GMT+5']) {
      // With the guard disabled, the table takes the value (so the refusal below is the function's own) ...
      const taken = await rolledBack(db, async (c) => {
        await guardOff(c);
        await insertSiteZoneRow(c, adm.admin, 'ebmr_owner', value);
      });
      expect([value, taken]).toEqual([value, null]);
      // ... but iam.set_policy refuses it before it records anything.
      const reason = 'DI-27 test: the row guard is disabled';
      const refused = await rolledBack(db, async (c) => {
        await guardOff(c);
        await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(underChange(withReason({ ...adm.admin, siteZone: SEED_ZONE }, 'POLICY_CHANGE', reason))))]);
        await c.query('select iam.set_policy($1, $2, $3)', ['site.zone', value, reason]);
      });
      expect([value, ebmrCode(refused)]).toEqual([value, 'EBMR-IAM-119']);
      expect(String((refused as Error).message)).toMatch(REFUSAL);
    }
    expect(await siteZone()).toBe(SEED_ZONE);
  });
});

const KERNEL_SQL = new URL('../../sql/', import.meta.url);
const MIGRATION_0940_FILE = '0940_site_zone_policy_check.sql';

/** Kernel migration 0940 as it is released. */
const MIGRATION_0940 = readFileSync(new URL(MIGRATION_0940_FILE, KERNEL_SQL), 'utf8');

/** iam.set_policy as kernel 0130 released it, before 0940 added the site.zone check. */
const SET_POLICY_0130 = ((): string => {
  const text = readFileSync(new URL('0130_iam_qualifications_authority.sql', KERNEL_SQL), 'utf8');
  const found = /create function iam\.set_policy\(p_key text, p_value text, p_reason text\)[\s\S]*?\n\$\$;/.exec(text);
  if (!found) throw new Error('iam.set_policy not found in kernel 0130');
  return found[0].replace('create function', 'create or replace function');
})();

/**
 * The database as it was before kernel 0940: its row guard and site rule gone, iam.set_policy as 0130
 * released it, and 0940 not recorded as applied. Run inside a transaction, as the owner, like a migration.
 */
const BEFORE_0940 = `
  set local role ebmr_owner;
  drop trigger if exists aa_site_zone_iam_policy_value on iam.policy_value;
  drop function if exists iam.site_zone_row_guard();
  drop function if exists iam.assert_site_zone(text);
  drop function if exists iam.is_valid_site_zone(text);
  ${SET_POLICY_0130}
  reset role;
  delete from public.schema_migration where namespace = 'kernel' and name = '${MIGRATION_0940_FILE}';
`;

/** Kernel migration 0940 run again on the database as it was before it, after `arrange`, in a superuser transaction that is always rolled back; the error, if any. */
function apply0940(arrange: (c: pg.PoolClient) => Promise<unknown>): Promise<unknown> {
  return rolledBack(db, async (c) => {
    await c.query(BEFORE_0940);
    await arrange(c);
    await c.query(MIGRATION_0940);
  });
}

describe('kernel 0940 applies only where the site zone in force is the IANA time zone name of a place, or UTC (DI-27, EBMR-IAM-119)', () => {
  it('[DI-27] the migration refuses to apply while site.zone holds a value recorded before it that the site rule refuses, naming the value; it applies otherwise', async () => {
    expect(await apply0940(() => Promise.resolve())).toBeNull();
    for (const legacy of ['IST', '+05:30', 'Asia/Kolkatta', 'Etc/GMT+5']) {
      // A value iam.set_policy recorded before 0940, arranged with the superuser in a validated command.
      const refused = await apply0940((c) => insertSiteZoneRow(c, adm.admin, null, legacy));
      expect([legacy, ebmrCode(refused)]).toEqual([legacy, 'EBMR-IAM-119']);
      expect(String(refused)).toContain(`the site policy site.zone holds '${legacy}', which is not an IANA time zone name`);
    }
    expect(await siteZone()).toBe(SEED_ZONE);
  });
});

/** A fresh database rewound to its state before kernel 0940, with its administrator; dropped afterwards. */
async function withDatabaseBefore0940(work: (database: TestDatabase, admin: SeededActor) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  await ensureFixtureChangeRecord(database);
  try {
    const { admin } = await seedAdministration(database);
    const c = await database.admin.connect();
    try {
      await c.query('begin');
      await c.query(BEFORE_0940);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
    await work(database, admin);
  } finally {
    await database.drop();
  }
}

/** A connection of its own, as the migration runner (a superuser) has. */
async function runnerFor(database: TestDatabase): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: urlFor(database.name) });
  await client.connect();
  return client;
}

/** Polls `sql` (a count) until it is positive ('waiting') or `settled` settles first ('settled'); 'timeout' after 15 s. */
async function waitingOrSettled(database: TestDatabase, sql: string, params: unknown[], settled: Promise<unknown>): Promise<'waiting' | 'settled' | 'timeout'> {
  let done = false;
  void settled.then(() => {
    done = true;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await database.admin.query<{ n: number }>(sql, params);
    if (Number(rows[0]?.n) > 0) return 'waiting';
    if (done) return 'settled';
    await sleep(20);
  }
  return 'timeout';
}

const settle = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (error: unknown) => error);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('kernel 0940 cannot be raced by an iam.set_policy call already under way when it is applied (DI-27, EBMR-IAM-119)', () => {
  it('[DI-27] a pre-0940 set_policy has recorded IST and not yet committed: the migration waits for it, then refuses, naming IST, and applies once the policy is corrected', async () => {
    await withDatabaseBefore0940(async (race, admin) => {
      const reason = 'DI-27 test: IST set while kernel 0940 is applied';
      const recorded = deferred();
      const release = deferred();
      // The administrator's call runs the body kernel 0130 released: it records IST and waits to commit.
      const caller = settle(
        withCommand(race.app, underChange(withReason({ ...admin, siteZone: SEED_ZONE }, 'POLICY_CHANGE', reason)), async (c) => {
          await setPolicy(c, 'site.zone', 'IST', reason);
          recorded.resolve();
          await release.promise;
        }),
      );
      expect(await Promise.race([recorded.promise.then(() => 'recorded'), caller])).toBe('recorded');

      const runner = await runnerFor(race);
      try {
        const pid = (await runner.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
        // The runner applies 0940 in its own transaction, as at an installation's upgrade.
        const migration = settle(migrate(runner, [{ ...KERNEL_MIGRATIONS, include: /^0940_/ }]));
        const state = await waitingOrSettled(race, "select count(*)::int as n from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid], migration);
        expect(state).not.toBe('timeout');
        release.resolve();
        expect(await caller).toBeNull();
        const refused = await migration;

        // IST is in force, so the migration did not commit: the installation stays before 0940 until corrected.
        expect(await zoneOf(race)).toBe('IST');
        expect(refused).toBeInstanceOf(Error);
        expect(ebmrCode((refused as Error).cause)).toBe('EBMR-IAM-119');
        expect(String(refused)).toContain("the site policy site.zone holds 'IST', which is not an IANA time zone name");
        const { rows } = await race.admin.query<{ n: number }>('select count(*)::int as n from public.schema_migration where namespace = $1 and name = $2', ['kernel', MIGRATION_0940_FILE]);
        expect(rows[0]?.n).toBe(0);

        // The administrator corrects the policy (still through the 0130 body), and 0940 then applies; IST is refused from then on.
        const fix = 'DI-27 test: site zone corrected before kernel 0940';
        await withCommand(race.app, underChange(withReason({ ...admin, siteZone: 'IST' }, 'POLICY_CHANGE', fix)), (c) => setPolicy(c, 'site.zone', SEED_ZONE, fix));
        expect((await migrate(runner, [{ ...KERNEL_MIGRATIONS, include: /^0940_/ }])).map((m) => m.name)).toEqual([MIGRATION_0940_FILE]);
        await expectRefused(
          withCommand(race.app, underChange(withReason({ ...admin, siteZone: SEED_ZONE }, 'POLICY_CHANGE', reason)), (c) => setPolicy(c, 'site.zone', 'IST', reason)),
          'EBMR-IAM-119',
          REFUSAL,
        );
        expect(await zoneOf(race)).toBe(SEED_ZONE);
      } finally {
        await runner.end();
      }
    });
  });

  it('[DI-27] a pre-0940 set_policy reaches its insert while the migration is being applied: the insert waits for the migration, and the row guard then refuses IST (EBMR-IAM-119)', async () => {
    await withDatabaseBefore0940(async (race, admin) => {
      const runner = await runnerFor(race);
      try {
        // The runner's transaction: 0940 applied, not yet committed.
        await runner.query('begin');
        await runner.query(MIGRATION_0940);
        // The administrator's call runs the body kernel 0130 released, the one committed now; its checks pass.
        const reason = 'DI-27 test: IST set while kernel 0940 is applied';
        const caller = settle(withCommand(race.app, underChange(withReason({ ...admin, siteZone: SEED_ZONE }, 'POLICY_CHANGE', reason)), (c) => setPolicy(c, 'site.zone', 'IST', reason)));
        const state = await waitingOrSettled(
          race,
          "select count(*)::int as n from pg_locks where database = (select oid from pg_database where datname = current_database()) and relation = 'iam.policy_value'::regclass and not granted",
          [],
          caller,
        );
        expect(state).not.toBe('timeout');
        await runner.query('insert into public.schema_migration (namespace, name, checksum) values ($1, $2, $3)', [
          'kernel',
          MIGRATION_0940_FILE,
          createHash('sha256').update(MIGRATION_0940).digest('hex'),
        ]);
        await runner.query('commit');

        const refused = await caller;
        expect(ebmrCode(refused)).toBe('EBMR-IAM-119');
        expect(String((refused as Error).message)).toMatch(REFUSAL);
        expect(await zoneOf(race)).toBe(SEED_ZONE);
      } finally {
        await runner.end();
      }
    });
  });
});
