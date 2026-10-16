/**
 * The checks iam.set_policy applies before it records a policy value, check by check (SQL mutation group
 * "site-zone": iam.is_valid_site_zone, iam.assert_site_zone and iam.set_policy in kernel 0940, which
 * redefined iam.set_policy of kernel 0130 with the site.zone check; site.site_zone_row_guard in
 * site-services 0700). The scenario tests in identity/site-zone-policy.test.ts prove the site.zone rule
 * (DI-27, EBMR-IAM-119), and identity/credentials.test.ts and identity/access.test.ts the ranges of a few
 * whole-number policies. These tests prove the other refusals of iam.set_policy where it applies them,
 * each by its own EBMR-IAM-110 message, and that a refused value leaves no policy row and no audit event:
 *
 *   - a key the kernel does not define is refused as unknown, before anything is looked up or written;
 *   - an INTEGER policy takes plain decimal digits only (at most 15, an optional minus sign): PostgreSQL
 *     itself would read '+4', '0x4' or '0b100' as the number 4, so the pattern is the check, not the cast;
 *   - the BOOLEAN policy takes true or false only, in any case: PostgreSQL would read 'yes', 'on', '1' or 't'
 *     as true, and the policy reader (iam.policy_bool) would then switch screening on from a word the
 *     administrator never chose;
 *   - a TEXT policy with listed values takes exactly one of them.
 *
 * Controls: DI-19 (credential policies are configurable within their allowed values; aging or screening
 * stays active), DI-15 (esig.us_certification_mode: BLOCK, the outline's default, or FLAG, the catalog's
 * position, and nothing else).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { setPolicy } from '../../src/identity/admin.ts';
import { seedAdministration, withReason, type SeedAdministration } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

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

/** The administrator (IAM.POLICY_MANAGE) sets a policy value through iam.set_policy, in a command with its reason. */
const setAs = (key: string, value: string, reason = 'DI-19 test: policy change'): Promise<void> =>
  withCommand(db.app, underChange(withReason(adm.admin, 'POLICY_CHANGE', reason)), (c: pg.PoolClient) => setPolicy(c, key, value, reason));

/** The value in force (iam.policy_text: the last recorded value, else the default). */
async function inForce(key: string): Promise<string> {
  const { rows } = await db.admin.query<{ v: string }>('select iam.policy_text($1) as v', [key]);
  const v = rows[0]?.v;
  if (v === undefined) throw new Error(`no value for ${key}`);
  return v;
}

/** Every recorded policy value and every policy audit event, all keys together (the history is insert-only and audited). */
async function trail(): Promise<{ values: number; events: number }> {
  const { rows } = await db.admin.query<{ values: string; events: string }>(
    `select (select count(*) from iam.policy_value) as values,
            (select count(*) from kernel.audit_event where chain_key like 'iam\\_policy:%') as events`,
  );
  return { values: Number(rows[0]?.values), events: Number(rows[0]?.events) };
}

/** The last recorded row of a key, as written. */
async function lastRow(key: string): Promise<{ key: string; value: string; set_by_person: string; set_by_account: string; reason: string } | undefined> {
  const { rows } = await db.admin.query<{ key: string; value: string; set_by_person: string; set_by_account: string; reason: string }>(
    'select key, value, set_by_person::text, set_by_account::text, reason from iam.policy_value where key = $1 order by id desc limit 1',
    [key],
  );
  return rows[0];
}

/** `p` is refused with the PL/pgSQL refusal (SQLSTATE P0001) whose whole message is `message`. */
async function refusedWith(p: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected the refusal "${message}"`).toBeInstanceOf(Error);
  const e = caught as Error & { code?: string };
  expect([e.code, e.message]).toEqual(['P0001', message]);
}

describe('iam.set_policy records a policy value only for a key the kernel defines (DI-19, EBMR-IAM-110)', () => {
  it('[DI-19] a key that is not a policy key is refused as unknown (EBMR-IAM-110), naming it; nothing is recorded or audited', async () => {
    const before = await trail();
    for (const key of ['authn.no_such_policy', 'Authn.lockout_threshold', 'site.Zone', 'esig.us_certification_mode ', 'credential', '']) {
      await refusedWith(setAs(key, '4'), `EBMR-IAM-110 unknown policy key ${key}`);
    }
    expect(await trail()).toEqual(before);
    // The key the kernel does define is taken, so the refusals above are the key's own.
    await setAs('authn.lockout_threshold', '4');
    expect(await inForce('authn.lockout_threshold')).toBe('4');
    await setAs('authn.lockout_threshold', '5');
    expect(await trail()).toEqual({ values: before.values + 2, events: before.events + 2 });
  });
});

describe('iam.set_policy: an INTEGER policy takes a whole number in plain decimal digits (DI-19, EBMR-IAM-110)', () => {
  it('[DI-19] a sign, a hexadecimal, octal, binary or underscore-grouped literal PostgreSQL reads as a number, a fraction, a word, a blank or more than 15 digits is refused as not a whole number; nothing is recorded or audited', async () => {
    const key = 'authn.lockout_threshold';
    const kept = await inForce(key);
    const before = await trail();
    for (const value of ['+4', '0x4', '0o4', '0b100', '4_0', '4.0', '4.5', '4e0', 'four', '', '   ', '- 4', '1234567890123456', '0000000000000004']) {
      await refusedWith(setAs(key, value), `EBMR-IAM-110 ${key} takes a whole number`);
      expect([value, await inForce(key)]).toEqual([value, kept]);
    }
    expect(await trail()).toEqual(before);
  });

  it('[DI-19] a whole number in the allowed range is recorded in its canonical form: blanks trimmed, leading zeros dropped; out of range is refused with the range', async () => {
    const key = 'authn.lockout_threshold';
    const before = await trail();
    await setAs(key, '  003 ', 'DI-19 test: lockout after three attempts');
    expect(await lastRow(key)).toEqual({
      key,
      value: '3',
      set_by_person: adm.admin.personId,
      set_by_account: adm.admin.accountId,
      reason: 'DI-19 test: lockout after three attempts',
    });
    expect(await inForce(key)).toBe('3');
    // 15 digits pass the pattern; the range then refuses them (allowed 3-5).
    await refusedWith(setAs(key, '999999999999999'), `EBMR-IAM-110 ${key} must lie between 3 and 5`);
    await refusedWith(setAs(key, '-3'), `EBMR-IAM-110 ${key} must lie between 3 and 5`);
    await setAs(key, '5');
    expect(await inForce(key)).toBe('5');
    expect(await trail()).toEqual({ values: before.values + 2, events: before.events + 2 });
  });
});

describe('iam.set_policy: the BOOLEAN policy credential.compromised_screening takes true or false (DI-19, EBMR-IAM-110)', () => {
  it('[DI-19] yes, on, 1, t, y and other words PostgreSQL reads as booleans or not are refused as not true or false; nothing is recorded or audited and screening keeps its value', async () => {
    const key = 'credential.compromised_screening';
    const kept = await inForce(key);
    const before = await trail();
    for (const value of ['yes', 'on', '1', 't', 'y', 'no', 'off', '0', 'f', 'maybe', '', 'true false']) {
      await refusedWith(setAs(key, value), `EBMR-IAM-110 ${key} takes true or false`);
      expect([value, await inForce(key)]).toEqual([value, kept]);
    }
    expect(await trail()).toEqual(before);
  });

  it('[DI-19] true or false in any case and with surrounding blanks is recorded in lower case', async () => {
    const key = 'credential.compromised_screening';
    const kept = await inForce(key);
    const before = await trail();
    await setAs(key, ' TRUE ', 'DI-19 test: screening on');
    expect(await lastRow(key)).toEqual({
      key,
      value: 'true',
      set_by_person: adm.admin.personId,
      set_by_account: adm.admin.accountId,
      reason: 'DI-19 test: screening on',
    });
    await setAs(key, 'False');
    expect(await inForce(key)).toBe('false');
    await setAs(key, kept);
    expect(await inForce(key)).toBe(kept);
    expect(await trail()).toEqual({ values: before.values + 3, events: before.events + 3 });
  });
});

describe('iam.set_policy: a TEXT policy with listed values takes exactly one of them (DI-15, EBMR-IAM-110)', () => {
  it('[DI-15] esig.us_certification_mode refuses any value but BLOCK or FLAG, naming the list (EBMR-IAM-110): another word, the lower-case or mixed-case spelling, both at once, a blank; nothing is recorded or audited and the mode in force stays', async () => {
    const key = 'esig.us_certification_mode';
    const kept = await inForce(key);
    expect(kept).toBe('BLOCK');
    const before = await trail();
    for (const value of ['WARN', 'block', 'Flag', 'BLOCK,FLAG', '{BLOCK}', 'BLOCK FLAG', '', '  ']) {
      await refusedWith(setAs(key, value), `EBMR-IAM-110 ${key} takes one of {BLOCK,FLAG}`);
      expect([value, await inForce(key)]).toEqual([value, kept]);
    }
    expect(await trail()).toEqual(before);
  });

  it('[DI-15] each listed value is recorded as given, after the trim: FLAG (the catalog position), then BLOCK (the outline default) again', async () => {
    const key = 'esig.us_certification_mode';
    const before = await trail();
    await setAs(key, 'FLAG', 'DI-15 test: the expert chose the catalog position');
    expect(await lastRow(key)).toEqual({
      key,
      value: 'FLAG',
      set_by_person: adm.admin.personId,
      set_by_account: adm.admin.accountId,
      reason: 'DI-15 test: the expert chose the catalog position',
    });
    expect(await inForce(key)).toBe('FLAG');
    await setAs(key, '  BLOCK ', 'DI-15 test: back to the outline default');
    expect(await lastRow(key)).toMatchObject({ key, value: 'BLOCK', reason: 'DI-15 test: back to the outline default' });
    expect(await inForce(key)).toBe('BLOCK');
    expect(await trail()).toEqual({ values: before.values + 2, events: before.events + 2 });
  });
});
