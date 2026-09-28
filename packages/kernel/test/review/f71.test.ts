/**
 * Review reproducer F71: continuity.reserve_counter_ceiling (packages/kernel/sql/0600_continuity_core.sql:358)
 * checks CONTINUITY.COUNTER_RESERVE in iam.actor_location_scope() (the session's site/room), not in the
 * scope of the counter being reserved. A batch-number counter 'site.batch_number:<rule>' belongs to a
 * named site's numbering rule, so a BATCH_ISSUER whose grant covers only SITE-1 (session at SITE-1)
 * passes the check for a counter of a SITE-2 rule and can write a ceiling reservation with a fabricated
 * external floor and receipt into SITE-2's number-protection records.
 *
 * Scenario:
 *   1. a MASTER_DATA_STEWARD defines a PROCESSING numbering rule for SITE-2 (counter site.batch_number:<rule>);
 *   2. an unrestricted BATCH_ISSUER reserves the first block (floor 0, ceiling 50): positive control that
 *      the call is well formed and the counter is reservable by someone whose grant covers SITE-2;
 *   3. a BATCH_ISSUER whose grant is limited to SITE-1 (session at SITE-1) calls
 *      reserve_counter_ceiling(<key>, 9999, 10000, 'forged receipt').
 *
 * Safe behaviour asserted: step 3 is refused for lack of CONTINUITY.COUNTER_RESERVE (no grant covers
 * SITE-2), and SITE-2's counter, ceiling reservations, sequence bumps and LEDGER_AHEAD alarms are unchanged.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { seedActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

const OTHER_SITE = 'SITE-2';
const RULE = `F71-${randomUUID().slice(0, 8).toUpperCase()}`;
const KEY = `site.batch_number:${RULE}`;

let db: TestDatabase;
let steward: ActorContext;
let issuer: ActorContext;
let site1Issuer: ActorContext;

const again = (ctx: ActorContext): ActorContext => ({ ...ctx, correlationId: randomUUID() });

async function reserve(ctx: ActorContext, floor: number, ceiling: number, receipt: string): Promise<string> {
  return withCommand(db.app, again(ctx), async (c) => {
    const { rows } = await c.query<{ ceiling: string }>(
      'select continuity.reserve_counter_ceiling($1, $2, $3, $4)::text as ceiling',
      [KEY, floor, ceiling, receipt],
    );
    const r = rows[0];
    if (!r) throw new Error('no row');
    return r.ceiling;
  });
}

async function snapshot(): Promise<Record<string, unknown>> {
  const counter = await db.app.query(
    'select last_value::text, reserved_ceiling::text from continuity.counter where sequence_key = $1',
    [KEY],
  );
  const reservations = await db.app.query(
    'select previous_ceiling::text, new_ceiling::text, external_floor::text, ledger_receipt from continuity.ceiling_reservation where sequence_key = $1 order by new_ceiling',
    [KEY],
  );
  const bumps = await db.app.query(
    'select reason, value_before::text, value_after::text from continuity.sequence_bump where sequence_key = $1',
    [KEY],
  );
  const alarms = await db.app.query(
    "select alarm_code from continuity.open_alarm where alarm_code = 'LEDGER_AHEAD' and details ->> 'sequence_key' = $1",
    [KEY],
  );
  return { counter: counter.rows, reservations: reservations.rows, bumps: bumps.rows, alarms: alarms.rows };
}

beforeAll(async () => {
  db = await createTestDatabase();
  steward = await seededTestActor(db, { roleCode: 'MASTER_DATA_STEWARD' });
  issuer = await seededTestActor(db, { roleCode: 'BATCH_ISSUER' });
  // Grant limited to SITE-1; the seeded devices (and therefore the session) are at SITE-1.
  const { seed: _seed, ...ctx } = await seedActor(db, { roleCode: 'BATCH_ISSUER', scope: { site: 'SITE-1' }, acknowledgeEsig: false });
  void _seed;
  site1Issuer = ctx;
  await withCommand(db.app, again(steward), (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({
        rule_code: RULE,
        site_code: OTHER_SITE,
        batch_kind: 'PROCESSING',
        format: 'S2{YY}{SEQ:4}',
        site_zone: 'Asia/Kolkata',
        effective_from: null,
        reason: 'SOP-QA-017',
        block_size: 50,
      }),
    ]),
  );
});

afterAll(async () => {
  await db.drop();
});

describe('F71 counter ceiling reservation is authorised at the actor location, not the counter site', () => {
  it('[DI-17][INV-27] a BATCH_ISSUER limited to SITE-1 cannot reserve a ceiling on a SITE-2 batch-number counter', async () => {
    // The counter belongs to the SITE-2 rule.
    const rule = await db.app.query<{ site_code: string; counter_key: string }>(
      'select site_code, counter_key from site.batch_number_rule where rule_code = $1',
      [RULE],
    );
    expect(rule.rows).toEqual([{ site_code: OTHER_SITE, counter_key: KEY }]);

    // Positive control: an issuer whose grant covers SITE-2 (unrestricted) reserves the first block.
    expect(await reserve(issuer, 0, 50, 'ledger-receipt-1')).toBe('50');
    const before = await snapshot();
    expect(before).toEqual({
      counter: [{ last_value: '0', reserved_ceiling: '50' }],
      reservations: [{ previous_ceiling: '0', new_ceiling: '50', external_floor: '0', ledger_receipt: 'ledger-receipt-1' }],
      bumps: [],
      alarms: [],
    });

    // Sanity: the SITE-1-limited issuer's grant does not cover SITE-2 (the owning module refuses it a
    // SITE-2 allocation, which is checked in the rule's site scope).
    await expect(
      withCommand(db.app, again(site1Issuer), (c) =>
        c.query('select * from site.allocate_batch_number($1::jsonb)', [
          JSON.stringify({
            site_code: OTHER_SITE,
            product_code: 'PY',
            product_name: 'Product PY',
            edition: 'TABLETS',
            batch_kind: 'PROCESSING',
            batch_size: '1000',
            batch_size_unit: '{tbl}',
          }),
        ]),
      ),
    ).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.ALLOCATE/);
    expect(await snapshot()).toEqual(before);

    // The SITE-1-limited issuer tries to write a forged reservation into SITE-2's counter.
    let outcome: string;
    try {
      outcome = `ALLOWED: returned ${await reserve(site1Issuer, 9999, 10000, 'forged receipt')}`;
    } catch (error) {
      outcome = String((error as Error).message);
    }
    const after = await snapshot();

    expect({ outcome, stateUnchanged: after }).toEqual({
      outcome: expect.stringMatching(/EBMR-IAM-040 .*CONTINUITY\.COUNTER_RESERVE/),
      stateUnchanged: before,
    });
  });
});
