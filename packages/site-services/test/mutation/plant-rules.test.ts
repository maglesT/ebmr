/**
 * Kill tests of the SQL mutation group "plant-rules" on the site-services side (site services 0940; Phase 6 exit,
 * decision 0019): a reagent or buffer lot is recorded whole or refused, one malformed field at a time; it is withdrawn
 * only when it exists and with a reason; and it may be used from the microsecond it was recorded until the microsecond
 * it expires, which is no longer in date.
 *
 * Controls: PR-29 (an expired or withdrawn reagent or buffer is not used at an in-process control).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { QualityWorld, seedQualityCast } from '../quality/support.ts';

let db: TestDatabase;
let q: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  q = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const lotCode = () => `BUF-${randomBytes(3).toString('hex').toUpperCase()}`;
const lot = (over: Record<string, unknown> = {}) => ({
  lotCode: lotCode(), kind: 'BUFFER', reagentCode: 'PH-BUF-7', name: 'pH 7.00 buffer', nominal: 'pH 7.00', preparedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ...over,
});
const record = (body: unknown) => q.sql<string>(q.cast.analyst, 'select site.record_reagent_lot($1::jsonb) as r', [JSON.stringify(body)]);
const withdraw = (code: string | null, reason: string | null) => q.sql(q.cast.analyst, 'select site.withdraw_reagent_lot($1, $2) as r', [code, reason]);
const problem = async (code: string, at: string) => (await db.app.query<{ p: string | null }>('select site.reagent_lot_problem($1, $2::timestamptz) as p', [code, at])).rows[0]!.p;

describe('reagent and buffer lots (site services 0940)', () => {
  it('[PR-29] a lot is an object of the known fields, refused for each malformed field on its own, and expires after it was prepared', async () => {
    await expectRefused(record([lot()]), 'EBMR-SITE-950', /a reagent lot is an object/);
    await expectRefused(record({ ...lot(), extra: 'x' }), 'EBMR-SITE-950', /a reagent lot has no field extra/);
    const form = /a reagent lot names its lot code, kind/;
    for (const over of [
      { lotCode: 'lower' }, { kind: 'SOLVENT' }, { reagentCode: 'lower' }, { name: '  ' }, { nominal: 7 }, { preparedAt: '' }, { expiresAt: '' },
    ]) {
      await expectRefused(record(lot(over)), 'EBMR-SITE-950', form);
    }
    await expectRefused(record(lot({ expiresAt: '2026-01-01T00:00:00Z' })), 'EBMR-SITE-951');
    expect(await record(lot({ nominal: null }))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[PR-29] a lot is withdrawn only when it exists and with a reason', async () => {
    await expectRefused(withdraw(lotCode(), 'Contaminated'), 'EBMR-SITE-953', /there is no reagent lot/);
    const l = lot();
    await record(l);
    await expectRefused(withdraw(l.lotCode, '  '), 'EBMR-SITE-950', /withdrawn with the reason/);
    await withdraw(l.lotCode, 'Contaminated: bottle left open');
  });

  it('[PR-29] a lot may be used from the microsecond it was recorded, and not at the microsecond it expires', async () => {
    const l = lot({ expiresAt: '2098-06-01T00:00:00.000001Z' });
    await record(l);
    const recorded = (await db.admin.query<{ t: string; e: string }>('select recorded_at::text as t, expires_at::text as e from site.reagent_lot where lot_code = $1', [l.lotCode])).rows[0]!;
    expect(await problem(l.lotCode, recorded.t)).toBeNull();
    expect(await problem(l.lotCode, recorded.e)).toMatch(/^EBMR-SITE-955 /);
  });
});
