/**
 * The material rules of slice 6b (builder B): the penicillin facility rule (recipe-core 0973, PR-27) on the receipt of
 * a component and on the start of a product, and reagent and buffer lots with an expiry at an in-process control (site
 * services 0940, recipe-core 0974; PR-29). As the application role through the real commands, with bypass attempts and
 * a success after each refusal.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { QualityWorld, seedQualityCast, unique } from '../../../site-services/test/quality/support.ts';
import { PlantWorld, seedPlantCast, sleep } from '../plant/support.ts';
import { batchWithSteps, occupy } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;
let q: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  q = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const steward = <T>(sql: string, params: unknown[]) => w.run(w.cast.steward, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
const receive = (materialCode: string) =>
  q.sql(q.cast.warehouse, 'select site.receive_lot($1::jsonb) as r', [JSON.stringify({ lotCode: unique('L'), materialCode, quantity: '1', expiresAt: '2030-01-01T00:00:00Z' })]);

describe('the penicillin facility (PR-27)', () => {
  it('[PR-27] a penicillin component in a non-penicillin facility is blocked', async () => {
    const amox = unique('AMOX');
    await q.material(amox, 'API');
    await expectRefused(w.run(w.cast.operator, (c) => c.query("select plant.classify_beta_lactam('MATERIAL', $1, true, 'x')", [amox])), 'EBMR-IAM-040');
    await expectRefused(steward("select plant.classify_beta_lactam('SUBSTANCE', $1, true, 'x') as r", [amox]), 'EBMR-PLANT-172');
    expect(await steward<number>("select plant.classify_beta_lactam('MATERIAL', $1, true, 'Amoxicillin trihydrate: a penicillin') as r", [amox])).toBe(1);
    // SITE-1 has no facility rule: it is not a penicillin facility (fail safe). The receipt is refused.
    await expect(receive(amox)).rejects.toThrow(/EBMR-PLANT-170 material .* is beta-lactam \(penicillin\) and site SITE-1 is not a penicillin facility/);
    // Bypass: even the owner writing the lot row directly is refused; the application cannot write it at all.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role ebmr_owner');
      await expect(c.query(
        `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                        received_by_person, received_by_account, correlation_id)
         values (gen_random_uuid(), 'SITE-1', $1, $2, 'Amoxicillin', 'API', 1, 'kg', '2030-01-01T00:00:00Z', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [unique('L'), amox],
      )).rejects.toThrow(/EBMR-PLANT-170/);
    } finally {
      await c.query('rollback');
      c.release();
    }
    await expect(db.app.query("insert into plant.facility_rule (site_code, version, penicillin_facility, justification, recorded_by_person, recorded_by_account, correlation_id) values ('SITE-1', 99, true, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())")).rejects.toThrow(/permission denied/);
    // A non-penicillin material is received as before.
    const lactose = unique('LAC');
    await q.material(lactose, 'EXCIPIENT');
    await expect(receive(lactose)).resolves.toBeDefined();
    // A beta-lactam product does not start in a room of the site either (the product classified; the start is the act).
    const product = await w.product();
    await steward("select plant.classify_beta_lactam('PRODUCT', $1, true, 'Amoxicillin capsules') as r", [product]);
    const room = await w.room();
    await expect(occupy(w, room.code, 'PEN-1', product)).rejects.toThrow(new RegExp(`EBMR-PLANT-170 product ${product} is beta-lactam`));
    // Success: the site is declared a penicillin facility (dedicated, separate air handling); receipt and start pass.
    await expectRefused(steward("select plant.set_facility_rule('SITE-1', true, ' ') as r", []), 'EBMR-PLANT-171');
    expect(await steward<number>("select plant.set_facility_rule('SITE-1', true, 'Dedicated penicillin facility, separate AHU and personnel') as r", [])).toBe(1);
    await expect(receive(amox)).resolves.toBeDefined();
    const b = await w.batch('PEN-1', product);
    await w.startIn(room.code, { batch: 'PEN-1', product });
    expect((await db.app.query('select batch_id from plant.area_occupancy_status where area_id = $1 and ended_at is null', [room.id])).rows).toEqual([{ batch_id: b.id }]);
    // Back to non-penicillin (the rule's next version): refused again.
    await steward("select plant.set_facility_rule('SITE-1', false, 'Penicillin manufacture moved to the other site') as r", []);
    await expect(receive(amox)).rejects.toThrow(/EBMR-PLANT-170/);
  });
});

describe('reagent and buffer lots at an in-process control (PR-29)', () => {
  const lot = (over: Record<string, unknown> = {}) => ({
    lotCode: `BUF-${randomBytes(3).toString('hex').toUpperCase()}`, kind: 'BUFFER', reagentCode: 'PH-BUF-7', name: 'pH 7.00 buffer', nominal: 'pH 7.00',
    preparedAt: new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString(), ...over,
  });
  const record = (body: Record<string, unknown>, actor = q.cast.analyst) => q.sql<string>(actor, 'select site.record_reagent_lot($1::jsonb) as r', [JSON.stringify(body)]);
  const use = (batch: string, lotCode: string, step = 'p-ipc') => w.run(w.cast.operator, (c) => c.query('select plant.record_reagent_use($1, $2, $3, $4)', [batch, step, lotCode, 'pH meter calibration']));
  const dbInIso = async (seconds: number) => (await db.app.query<{ t: string }>("select to_char((clock_timestamp() + make_interval(secs => $1)) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t", [seconds])).rows[0]?.t ?? '';

  it('[PR-29] an expired pH buffer is blocked', async () => {
    const product = await w.product();
    const batch = await batchWithSteps(db, product, ['p-ipc']);
    // Only QC records a lot; it states its kind and expiry; the expiry follows the preparation.
    await expectRefused(record(lot({ expiresAt: await dbInIso(60) }), q.cast.operator), 'EBMR-IAM-040');
    await expectRefused(record(lot({ kind: 'SOLVENT', expiresAt: await dbInIso(60) })), 'EBMR-SITE-950');
    await expectRefused(record(lot({ preparedAt: await dbInIso(60), expiresAt: await dbInIso(120) })), 'EBMR-SITE-951');
    const fresh = lot({ expiresAt: await dbInIso(3600) });
    await record(fresh);
    await expectRefused(record(fresh), 'EBMR-SITE-952');
    const short = lot({ expiresAt: await dbInIso(2) });
    await record(short);
    // In date: used at the IPC step and recorded with the step.
    await use(batch, short.lotCode);
    await sleep(db, 2.2);
    // Expired: refused at the step, with the lot, its name and its expiry.
    await expectRefused(use(batch, short.lotCode), 'EBMR-PLANT-191', /EBMR-SITE-955 buffer lot BUF-.* \(pH 7\.00 buffer\) expired at .*an expired reagent or buffer is not used \(PR-29\)/);
    // Unknown, withdrawn, a step the batch does not have, an integration identity: refused.
    await expectRefused(use(batch, 'BUF-NONE'), 'EBMR-PLANT-191', /EBMR-SITE-953/);
    await expectRefused(use(batch, fresh.lotCode, 'p-nowhere'), 'EBMR-PLANT-190');
    await expectRefused(w.run(w.cast.feed, (c) => c.query('select plant.record_reagent_use($1, $2, $3, $4)', [batch, 'p-ipc', fresh.lotCode, 'x'])), 'EBMR-IAM-040');
    // Bypass: the application writes no use and changes no lot (its expiry least of all).
    await expect(db.app.query("insert into plant.reagent_use (batch_id, step, reagent_lot_id, purpose, person_id, account_id, correlation_id) select $1, 'p-ipc', id, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from site.reagent_lot limit 1", [batch])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update site.reagent_lot set expires_at = expires_at + interval '1 year'")).rejects.toThrow(/permission denied/);
    // Success: the fresh lot is used; withdrawn early, it is refused too.
    await use(batch, fresh.lotCode);
    expect((await db.app.query<{ n: string }>('select count(*)::text as n from plant.reagent_use where batch_id = $1', [batch])).rows[0]?.n).toBe('2');
    await q.sql(q.cast.analyst, 'select site.withdraw_reagent_lot($1, $2) as r', [fresh.lotCode, 'Contaminated: bottle left open']);
    await expectRefused(q.sql(q.cast.analyst, 'select site.withdraw_reagent_lot($1, $2) as r', [fresh.lotCode, 'again']), 'EBMR-SITE-954');
    await expectRefused(use(batch, fresh.lotCode), 'EBMR-PLANT-191', /EBMR-SITE-954 .* was withdrawn: Contaminated/);
  });
});
