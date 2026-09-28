/**
 * Review reproducer F27: the "retroactive" test for rule-table loosenings uses the time zone the
 * client declares in its actor context.
 *
 *   - market.publish_rule_table (0340) computes today as
 *       (clock_timestamp() at time zone coalesce(v_ctx ->> 'site_zone', 'UTC'))::date
 *     and a loosening counts as retroactive (refused for an UPDATE, EBMR-MKT-031) only when its
 *     segment starts on or before that date.
 *   - kernel.begin_command (0010) and kernel.validate_actor_context (0190) check only that
 *     site_zone is non-empty; nothing compares it with the configured site zone
 *     (iam.policy_text('site.zone')), unlike esig (EBMR-ESIG-035).
 *   - PostgreSQL accepts POSIX zone strings such as 'X+167' (167 hours behind UTC), which moves
 *     "today" back by about seven days.
 *
 * Safe behaviour asserted: a kernel v2 UPDATE that loosens the India HARD self-inspection interval
 * (B-08, 12 months) to 36 months from five site days ago is refused when the steward's command
 * declares site_zone 'X+167', exactly as it is when the command declares the configured site zone.
 * Whether the refusal comes from the publish gate (EBMR-MKT-031) or from a zone check on the
 * command does not matter; accepting it does.
 *
 * Positive control, run first: the same document under the configured site zone is refused with
 * EBMR-MKT-031, so the document is otherwise valid and the loosening is in force in site time.
 * Every attempt runs in its own transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { SEED_ZONE } from '../identity/seed.ts';
import { MARKET_ROLES, publishSeedTables, seedDocument } from '../market/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
});

afterAll(async () => {
  await db.drop();
});

type Attempt =
  | { accepted: true; result: Record<string, unknown>; resolvedValue: unknown }
  | { accepted: false; error: string };

const PUBLISH = 'select market.publish_rule_table($1::jsonb, $2::jsonb) as r';

/**
 * begin_command + publish as the application role, then roll back. A refusal at begin_command (a
 * zone check) or at the publish gate is returned as a refusal. When the publish is accepted, the
 * new version's resolution of the key for India at `asOf` is read in the same transaction.
 */
async function attemptPublish(ctx: ActorContext, doc: unknown, asOf: string): Promise<Attempt> {
  const client = await db.app.connect();
  try {
    await client.query('begin');
    try {
      await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      const { rows } = await client.query<{ r: Record<string, unknown> }>(PUBLISH, [JSON.stringify(doc), '{}']);
      const result = rows[0]?.r ?? {};
      const { rows: res } = await client.query<{ r: { value: unknown } }>(
        "select market.resolve($1::uuid, 'kernel.selfInspection.maxIntervalMonths', array['IN'], '{}'::jsonb, $2::date) as r",
        [result['versionId'], asOf],
      );
      return { accepted: true, result, resolvedValue: res[0]?.r.value };
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const code = (a: Attempt): string => (a.accepted ? 'ACCEPTED' : (/EBMR-[A-Z]+-\d+/.exec(a.error)?.[0] ?? a.error));

describe('F27: the retroactive-loosening test must use the site date, not a zone the client declares', () => {
  it('[IN-52] an UPDATE loosening a value in force since five site days ago is refused whatever site_zone the command declares', async () => {
    // --- Dates, computed by the database (no JavaScript clock).
    const { rows: d } = await db.admin.query<{ zone: string; today: string; from: string; as_of: string; skewed_today: string }>(
      `select z.zone,
              to_char(t.today, 'YYYY-MM-DD') as today,
              to_char(t.today - 5, 'YYYY-MM-DD') as "from",
              to_char(t.today - 3, 'YYYY-MM-DD') as as_of,
              to_char((clock_timestamp() at time zone 'X+167')::date, 'YYYY-MM-DD') as skewed_today
         from (select iam.policy_text('site.zone') as zone) z,
              lateral (select (clock_timestamp() at time zone z.zone)::date as today) t`,
    );
    const dates = d[0];
    expect(dates?.zone, 'configured site zone').toBe(SEED_ZONE);
    if (!dates) throw new Error('no dates');
    // The declared zone moves "today" back by more than five days.
    expect(dates.skewed_today < dates.from, `X+167 date ${dates.skewed_today} is before ${dates.from}`).toBe(true);

    // --- kernel v2 (UPDATE): B-08.IN.selfInspection (12 months, HARD, since 2023-12-28) ends five
    // site days ago and a 36-month India row takes over from that day. India coverage stays whole.
    const v2 = JSON.parse(JSON.stringify(seedDocument('kernel'))) as {
      version: number;
      change: Record<string, unknown>;
      rows: Record<string, unknown>[];
    };
    v2.version = 2;
    v2.change = { kind: 'UPDATE', description: 'self-inspection interval re-read' };
    const idx = v2.rows.findIndex((r) => r['ref'] === 'B-08.IN.selfInspection');
    expect(idx, 'seed row B-08.IN.selfInspection').toBeGreaterThanOrEqual(0);
    const b08 = v2.rows[idx] ?? {};
    expect([b08['value'], b08['floor'], b08['effectiveFrom']]).toEqual(['12', 'HARD', '2023-12-28']);
    expect(b08['effectiveTo'], 'seed row is open-ended').toBeUndefined();
    v2.rows[idx] = { ...b08, effectiveTo: dates.from };
    v2.rows.push({ ...b08, ref: 'B-08.IN.selfInspection.2', value: '36', effectiveFrom: dates.from });

    // --- Actors: the same master-data steward identity, declaring two zones.
    const steward = await seededTestActor(db, { roleCode: MARKET_ROLES.publisher }); // MASTER_DATA_STEWARD
    expect(steward.siteZone).toBe(SEED_ZONE);
    const skewed: ActorContext = { ...steward, siteZone: 'X+167' };

    // --- Positive control: in site time the loosening is already in force, so the UPDATE is refused.
    const control = await attemptPublish(steward, v2, dates.as_of);
    expect(code(control), `control: kernel v2 as an UPDATE under ${SEED_ZONE}`).toBe('EBMR-MKT-031');

    // --- Attack: the same document, the same steward, declaring site_zone 'X+167'.
    const attack = await attemptPublish(skewed, v2, dates.as_of);
    const detail = attack.accepted
      ? `accepted: loosening ${JSON.stringify(attack.result['loosening'])}; India resolves to ${JSON.stringify(attack.resolvedValue)} months on ${dates.as_of} (HARD value 12)`
      : attack.error;
    expect(code(attack), `attack: kernel v2 as an UPDATE under X+167 -> ${detail}`).not.toBe('ACCEPTED');
  });
});
