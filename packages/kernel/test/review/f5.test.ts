/**
 * Review reproducer F5: the site zone and the printed name in an audit entry must be the server's,
 * not whatever the client put in the actor context.
 *
 * kernel.append_audit_event (0010) copies 'site_zone' and actor 'legal_name' straight from the
 * validated context. kernel.begin_command only requires site_zone to be non-empty, and the live
 * kernel.validate_actor_context (0190) never compares it with iam.policy_text('site.zone'); it checks
 * legal_name only when the context carries one. DI-22 / INV-07 require every entry to hold the
 * server time with the site zone (UTC plus site offset) and the printed full name at the time.
 *
 * Safe behaviour asserted here, for a real seeded operator on a PERSONAL device:
 *   - baseline: a correct context is accepted and its entry carries the policy zone and the name;
 *   - (A) a context declaring a zone other than the site policy zone is either refused, or the entry
 *     it writes still carries the site policy zone;
 *   - (B) a context that omits legal_name is either refused, or the entry it writes still carries the
 *     person's legal name (filled by the server).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

const FOREIGN_ZONE = 'Pacific/Kiritimati';

const codeOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.match(/EBMR-[A-Z]+-\d+/)?.[0] ?? `UNEXPECTED: ${m}`;
};

interface Entry {
  site_zone: string | null;
  legal_name: string | null;
  person_id: string | null;
  local_in_entry_zone: string;
  local_in_site_zone: string;
}

type Outcome = { refused: string } | { entry: Entry };

async function insertUnder(ctx: ActorContext): Promise<Outcome> {
  const batch = randomUUID();
  try {
    await withCommand(db.app, ctx, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 7.25)', [batch]));
  } catch (e) {
    return { refused: codeOf(e) };
  }
  const { rows } = await db.admin.query<Entry>(
    `select e.payload ->> 'site_zone' as site_zone,
            e.payload -> 'actor' ->> 'legal_name' as legal_name,
            e.payload -> 'actor' ->> 'person_id' as person_id,
            to_char(e.recorded_at at time zone (e.payload ->> 'site_zone'), 'YYYY-MM-DD HH24:MI') as local_in_entry_zone,
            to_char(e.recorded_at at time zone iam.policy_text('site.zone'), 'YYYY-MM-DD HH24:MI') as local_in_site_zone
       from kernel.audit_event e
      where e.chain_key = $1 and e.action = 'INSERT'`,
    [`batch:${batch}`],
  );
  expect(rows).toHaveLength(1);
  return { entry: rows[0] as Entry };
}

describe('F5: audit entries carry the server site zone and the printed name, not client-supplied values', () => {
  it('[DI-22][INV-07] an audit entry never carries a site zone other than the site policy zone, nor a missing printed name', async () => {
    const operator = await seededTestActor(db, { legalName: 'Review Operator F5' });
    const { rows: pol } = await db.admin.query<{ zone: string }>("select iam.policy_text('site.zone') as zone");
    const siteZone = pol[0]?.zone ?? '';
    const { rows: per } = await db.admin.query<{ legal_name: string }>('select legal_name from iam.person where id = $1', [operator.personId]);
    const personName = per[0]?.legal_name ?? '';

    // Preconditions: the seeded operator declares the site's own zone and name; the foreign zone differs.
    expect(siteZone).toBe('Asia/Kolkata');
    expect(operator.siteZone).toBe(siteZone);
    expect(personName).toBe('Review Operator F5');
    expect(operator.legalName).toBe(personName);
    expect(FOREIGN_ZONE).not.toBe(siteZone);

    // Baseline: the correct context is accepted and its entry is right (proves the harness works, so a
    // refusal below is caused by the altered field, not by the setup).
    const baseline = await insertUnder({ ...operator, correlationId: randomUUID() });
    expect(baseline).toMatchObject({ entry: { site_zone: siteZone, legal_name: personName, person_id: operator.personId } });

    // (A) The client declares a foreign zone (legal name still correct).
    const a = await insertUnder({ ...operator, siteZone: FOREIGN_ZONE, correlationId: randomUUID() });

    // (B) The client omits the printed name (zone correct).
    const { legalName: _omit, ...noName } = operator;
    void _omit;
    const b = await insertUnder({ ...noName, correlationId: randomUUID() });

    const zoneSafe = 'refused' in a ? /^EBMR-/.test(a.refused) : a.entry.site_zone === siteZone;
    const nameSafe = 'refused' in b ? /^EBMR-/.test(b.refused) : b.entry.legal_name === personName;

    expect(
      { zoneSafe, nameSafe },
      'an audited GMP write under a client-chosen zone or without a printed name must be refused or corrected by the server; ' +
        `site policy zone ${siteZone}, person name ${personName}; observed (A) foreign zone: ${JSON.stringify(a)}; (B) no name: ${JSON.stringify(b)}`,
    ).toEqual({ zoneSafe: true, nameSafe: true });
  });
});
