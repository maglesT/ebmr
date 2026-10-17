/**
 * Kill tests of the SQL mutation group "plant-rules" on the kernel side (kernel 1190; Phase 6 exit, decision 0019): an
 * area authorisation read at an instant counts from the very microsecond it was recorded and from the first microsecond
 * of its validity, and stops at the very microsecond its validity ends or it is withdrawn. Each instant is read back
 * from the register itself, so the boundary is hit exactly.
 *
 * Controls: PR-15 (work in a controlled area needs the person's authorisation), INV-26 (a qualification is read with the
 * register's rules at an instant).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedActor, withReason, type SeededActor } from '../identity/seed.ts';

let db: TestDatabase;
let tc: SeededActor;
let op: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', acknowledgeEsig: false });
  op = await seedActor(db, { legalName: 'Bina Boundary', acknowledgeEsig: false });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const asTc = <T>(sql: string, params: unknown[]) => withCommand(db.app, withReason(tc), async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
const authorised = async (area: string, at: string) =>
  (await db.app.query<{ r: boolean }>('select iam.person_area_authorised($1, $2, $3::timestamptz) as r', [op.personId, area, at])).rows[0]!.r;
const instant = async (column: string, id: string) =>
  (await db.admin.query<{ t: string }>(`select ${column}::text as t from iam.person_qualification where id = $1`, [id])).rows[0]!.t;

describe('an area authorisation at the edges of its window (kernel 1190)', () => {
  it('[PR-15][INV-26] it counts from the microsecond it was recorded and the first microsecond of its validity, and not at the microsecond it ends or is withdrawn', async () => {
    const area = `PB-${randomBytes(2).toString('hex').toUpperCase()}`;
    const code = await asTc<string>('select iam.create_area_authorisation_type($1, $2) as r', [area, 'Boundary suite']);
    // Valid from the past, open-ended: it counts from its recording.
    const open = await asTc<string>("select iam.record_qualification($1, $2, '2026-01-01T00:00:00Z', null) as r", [op.personId, code]);
    const recorded = await instant('recorded_at', open);
    expect(await authorised(area, recorded)).toBe(true);
    // Withdrawn: it stops at the withdrawal's own microsecond.
    await asTc('select iam.withdraw_qualification($1, $2) as r', [open, 'Moved to packaging']);
    const withdrawn = await instant('withdrawn_at', open);
    expect(await authorised(area, withdrawn)).toBe(false);
    // A window in the future: from its first microsecond, not at its end.
    const window = await asTc<string>("select iam.record_qualification($1, $2, clock_timestamp() + interval '1 day', clock_timestamp() + interval '2 days') as r", [op.personId, code]);
    const from = await instant('valid_from', window);
    const to = await instant('valid_to', window);
    expect(await authorised(area, from)).toBe(true);
    expect(await authorised(area, to)).toBe(false);
  });
});
