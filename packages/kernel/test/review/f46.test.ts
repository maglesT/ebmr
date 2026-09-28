/**
 * Review reproducer F46: platform.stub_step_entry_time_model (kernel 0530, line 273; the only
 * definition, never replaced later) sets
 *     new.site_zone := v_ctx ->> 'site_zone'
 * and derives site_utc_offset from it, after checking only that the name is a valid IANA zone.
 * kernel.validate_actor_context (0010 shape check, replaced in 0190) only requires that site_zone is
 * present; it never compares it with the site's configured zone iam.policy_text('site.zone')
 * (0100, default 'Asia/Kolkata'). esig.sign does compare them (0230, EBMR-ESIG-035); the time model
 * does not. So the zone stored with a GMP entry - which fixes the stored UTC offset, the displayed
 * local time and the site-local calendar day - is chosen by the caller.
 *
 * DI-27 (behaviour: "Timestamps are stored in UTC with the site time zone and offset, and displayed
 * as site-local time with the offset"; "Client-device clocks and user-typed times are never used as
 * the time of an action") requires the stored zone to be the site's zone, not a client-declared one.
 *
 * Steps (all as ebmr_app, through kernel.begin_command, exactly as the product would):
 *   1. Positive control: the site's configured zone iam.policy_text('site.zone') is Asia/Kolkata.
 *   2. Positive control: an operator whose context declares Asia/Kolkata records an entry; it stores
 *      Asia/Kolkata with offset +05:30.
 *   3. An operator (same seeded identity kind, same site) whose command context declares
 *      site_zone 'America/Los_Angeles' records an entry on the same step.
 *      Safe behaviour asserted: either the command is refused, or the stored entry carries the site
 *      zone (Asia/Kolkata) and its offset (+05:30), so the site-local calendar day computed from the
 *      stored zone is the site's own day.
 *
 * With the defect, step 3 stores site_zone America/Los_Angeles with offset -07:00 (PDT), and
 * platform.site_calendar_day(recorded_at, site_zone) is the Los Angeles day, not the site's day.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { SEED_ZONE } from '../identity/seed.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

interface EntryRow {
  site_zone: string;
  site_utc_offset: string;
  recorded_at: string;
  stored_day: string;
  site_day: string;
}

async function newStep(): Promise<string> {
  return withCommand(db.app, await seededTestActor(db), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "insert into platform.stub_step (batch_id, planned_end_at) values ($1, clock_timestamp() + interval '8 hours') returning id",
      [randomUUID()],
    );
    return rows[0]?.id ?? '';
  });
}

async function addEntry(stepId: string, itemNo: number, ctx: ActorContext): Promise<EntryRow> {
  return withCommand(db.app, ctx, async (c) => {
    const { rows } = await c.query<EntryRow>(
      `with e as (
         insert into platform.stub_step_entry (step_id, item_no, value, unit) values ($1, $2, '12.503', 'kg')
         returning site_zone, site_utc_offset, recorded_at)
       select e.site_zone, e.site_utc_offset::text, e.recorded_at::text,
              platform.site_calendar_day(e.recorded_at, e.site_zone)::text as stored_day,
              platform.site_calendar_day(e.recorded_at, iam.policy_text('site.zone'))::text as site_day
         from e`,
      [stepId, itemNo],
    );
    const row = rows[0];
    if (!row) throw new Error('no row');
    return row;
  });
}

describe('F46: the site zone stored with a GMP entry (DI-27)', () => {
  it('an entry does not store a caller-declared foreign zone and offset: it is refused or stored with the site zone', async () => {
    // 1. Positive control: the site's configured zone.
    const { rows: policy } = await db.app.query<{ z: string }>("select iam.policy_text('site.zone') as z");
    expect(policy[0]?.z).toBe('Asia/Kolkata');
    expect(SEED_ZONE).toBe('Asia/Kolkata');

    const stepId = await newStep();

    // 2. Positive control: the site zone is stored with its offset.
    const local = await addEntry(stepId, 1, await seededTestActor(db, { siteZone: 'Asia/Kolkata' }));
    expect(local.site_zone).toBe('Asia/Kolkata');
    expect(local.site_utc_offset).toBe('05:30:00');
    expect(local.stored_day).toBe(local.site_day);

    // 3. Same site, a command context that declares a foreign zone.
    const foreign = { ...(await seededTestActor(db)), siteZone: 'America/Los_Angeles' };
    let outcome: string;
    let stored: EntryRow | undefined;
    try {
      stored = await addEntry(stepId, 2, foreign);
      outcome = 'stored';
    } catch (error) {
      outcome = `refused: ${(error as Error).message}`;
    }

    if (outcome === 'stored') {
      // Accepted: then the stored zone, offset and site-local day must be the site's own.
      expect({ site_zone: stored?.site_zone, site_utc_offset: stored?.site_utc_offset, day_matches_site: stored?.stored_day === stored?.site_day }).toEqual({
        site_zone: 'Asia/Kolkata',
        site_utc_offset: '05:30:00',
        day_matches_site: true,
      });
    } else {
      expect(outcome).toMatch(/^refused: .*EBMR-/);
    }
  });
});
