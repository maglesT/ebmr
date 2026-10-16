/**
 * Area authorisation per person (kernel 1190; PR-15, INV-26; D-P6b-5): a qualification of the type AREA.<area>,
 * recorded by a training coordinator, read at an instant with the register's rules (recorded by then, valid then, not
 * withdrawn by then, from a source fresh then). The step signature in a controlled area reads it (recipe-core 0974).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asTimeTraveller, dbNow, expectRefused } from './helpers.ts';
import { seedActor, withReason, type SeededActor } from './seed.ts';

let db: TestDatabase;
let tc: SeededActor;
let op: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', acknowledgeEsig: false });
  op = await seedActor(db, { legalName: 'Asha Operator', acknowledgeEsig: false });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const asTc = <T>(work: Parameters<typeof withCommand<T>>[2]) => withCommand(db.app, withReason(tc), work);
const problem = async (area: string, at?: string) =>
  (await db.app.query<{ p: string | null }>('select iam.area_authorisation_problem($1, $2, coalesce($3::timestamptz, clock_timestamp())) as p', [op.personId, area, at ?? null])).rows[0]?.p ?? null;

describe('area authorisation (kernel 1190)', () => {
  it('[PR-15][INV-26] an area authorisation counts from its recording, while valid and until withdrawn; a person never records their own', async () => {
    const area = `PS-${randomBytes(2).toString('hex').toUpperCase()}`;
    await expectRefused(asTc((c) => c.query('select iam.create_area_authorisation_type($1, $2)', ['bad code!', 'x'])), 'EBMR-IAM-200');
    const code = await asTc(async (c) => (await c.query<{ r: string }>('select iam.create_area_authorisation_type($1, $2) as r', [area.toLowerCase(), 'Potent suite'])).rows[0]?.r);
    expect(code).toBe(`AREA.${area}`);
    expect(await problem(area)).toMatch(new RegExp(`^EBMR-IAM-202 Asha Operator holds no current authorisation AREA\\.${area} for the controlled area ${area}`));
    const before = await dbNow(db);
    // Bypass: the person cannot record their own authorisation, nor write the register directly.
    await expectRefused(withCommand(db.app, withReason(op), (c) => c.query("select iam.record_qualification($1, $2, '2026-01-01T00:00:00Z', null)", [op.personId, code])), 'EBMR-IAM-040');
    await expect(db.app.query("insert into iam.person_qualification (person_id, qualification_code, source_code, valid_from, recorded_by_person, recorded_by_account) values ($1, $2, 'INTERNAL', '2026-01-01', gen_random_uuid(), gen_random_uuid())", [op.personId, code])).rejects.toThrow(/permission denied/);
    const id = await asTc(async (c) => (await c.query<{ r: string }>("select iam.record_qualification($1, $2, '2026-01-01T00:00:00Z', null) as r", [op.personId, code])).rows[0]?.r);
    expect(await problem(area)).toBeNull();
    // Recorded late, it does not authorise an earlier instant (valid_from back-dated or not).
    expect(await problem(area, before)).toMatch(/^EBMR-IAM-202 /);
    // A record valid only in the future does not count now.
    const other = `PS-${randomBytes(2).toString('hex').toUpperCase()}`;
    const code2 = await asTc(async (c) => (await c.query<{ r: string }>('select iam.create_area_authorisation_type($1, $2) as r', [other, 'Other suite'])).rows[0]?.r);
    await asTc((c) => c.query("select iam.record_qualification($1, $2, clock_timestamp() + interval '1 day', null)", [op.personId, code2]));
    expect(await problem(other)).toMatch(/^EBMR-IAM-202 /);
    // Withdrawn, it stops counting from the withdrawal.
    const beforeWithdrawal = await dbNow(db);
    await asTc((c) => c.query('select iam.withdraw_qualification($1, $2)', [id, 'Moved to packaging']));
    expect(await problem(area)).toMatch(/^EBMR-IAM-202 /);
    expect(await problem(area, beforeWithdrawal)).toBeNull();
  });

  it('[PR-15][INV-26] an authorisation mirrored from the LMS counts only while the mirror is fresh', async () => {
    const area = `PS-${randomBytes(2).toString('hex').toUpperCase()}`;
    const code = await asTc(async (c) => (await c.query<{ r: string }>('select iam.create_area_authorisation_type($1, $2) as r', [area, 'Mirrored suite'])).rows[0]?.r);
    await asTc((c) => c.query("select iam.record_qualification($1, $2, '2026-01-01T00:00:00Z', null, 'LMS', 'LMS-9') as r", [op.personId, code]));
    await asTc((c) => c.query("select iam.record_mirror_heartbeat('LMS')"));
    expect(await problem(area)).toBeNull();
    await asTimeTraveller(db, "update iam.mirror_heartbeat set last_synced_at = clock_timestamp() - interval '30 days' where source_code = 'LMS'");
    expect(await problem(area)).toMatch(/^EBMR-IAM-202 /);
  });
});
