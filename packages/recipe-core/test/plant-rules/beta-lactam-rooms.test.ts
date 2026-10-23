/**
 * Rooms and lines dedicated to beta-lactam products (recipe-core 1600; Phase 7 slice 7n, requirement R7; PR-27). QA
 * records a BETA_LACTAM dedication of a room and a second QA person approves it (0912). At a penicillin facility a
 * beta-lactam batch is cleared for and started only in a dedicated room (EBMR-PLANT-177), and any other batch is refused
 * in one (EBMR-PLANT-178); both at the clearance and at the start of the room's use, whoever writes the row. As the
 * application role through the real commands and real e-signatures; a direct insert as the owner is refused too. A
 * unit's use, which needs no room occupancy, is judged by the room the unit stands in (D-7n-10).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { ensureFixtureChangeRecord } from '../../../kernel/test/support/change-record.ts';
import * as plant from '../../src/plant/index.ts';
import { PlantWorld, seedPlantCast, tag } from '../plant/support.ts';
import { occupy } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;
let qa: SeededActor;
let qa2: SeededActor;

const messageOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a refusal');
};
const scalar = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.app.query<{ r: T }>(sql, params)).rows[0]?.r as T;

/** SITE-1 a penicillin facility: the steward proposes it and QA approves it (1210). */
async function penicillinSite(): Promise<void> {
  const version = await w.run(w.cast.steward, async (c) => (await c.query<{ r: number }>("select plant.set_facility_rule('SITE-1', true, 'Dedicated beta-lactam suite with its own air handling') as r")).rows[0]?.r);
  const id = await scalar<string>("select id as r from plant.facility_rule where site_code = 'SITE-1' and version = $1", [version]);
  const sig = await w.sign(qa, 'facility_rule', id, 'QA_APPROVED', 'PROPOSED');
  await w.run(qa, (c) => c.query('select plant.approve_facility_rule($1, $2)', [id, sig]));
}

/** A product classified beta-lactam by the steward (a tightening: in force at once). */
async function betaProduct(): Promise<string> {
  const product = await w.product();
  await w.run(w.cast.steward, (c) => c.query("select plant.classify_beta_lactam('PRODUCT', $1, true, 'A cephalosporin') as r", [product]));
  return product;
}

/** The QA MBR approver records the room's BETA_LACTAM dedication (or its withdrawal); a QA reviewer approves it unless `approve` is false. */
async function dedicate(area: string, dedicated = true, approve = true): Promise<string> {
  const id = await w.run(qa2, async (c) =>
    (await c.query<{ r: string }>('select plant.record_area_dedication($1::jsonb) as r', [JSON.stringify({ areaCode: area, hazardClass: 'BETA_LACTAM', dedicated, breathingAir: 'NOT_USED', justification: 'Beta-lactam suite: own air handling, pressure cascade, airlocks' })])).rows[0]?.r ?? '');
  if (approve) {
    const sig = await w.sign(qa, 'area_dedication', id, 'AREA_DEDICATION_APPROVED', 'RECORDED');
    await w.run(qa, (c) => c.query('select plant.approve_area_dedication($1, $2)', [id, sig]));
  }
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  w = new PlantWorld(db, await seedPlantCast(db));
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Quentin QA' });
  qa2 = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Qamar QA' });
  await penicillinSite();
}, 300_000);
afterAll(async () => {
  await db.drop();
});

describe('beta-lactam work stays in its dedicated suite (PR-27, R7)', () => {
  it('[PR-27] a beta-lactam batch is refused a room not dedicated to beta-lactam products, and runs in one whose dedication a second QA person approved', async () => {
    const product = await betaProduct();
    const plain = await w.room();
    expect(await messageOf(occupy(w, plain.code, 'BL-A', product))).toMatch(new RegExp(`EBMR-PLANT-177 batch TEST-BL-A-\\w+ of ${product} is beta-lactam and ${plain.code} is not a room or line dedicated to beta-lactam`));
    // A dedication not yet approved by a second person does not count.
    const suite = await w.room();
    await dedicate(suite.code, true, false);
    expect(await messageOf(occupy(w, suite.code, 'BL-A', product))).toMatch(/EBMR-PLANT-177/);
    await dedicate(suite.code);
    expect(await occupy(w, suite.code, 'BL-A', product)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await scalar<string | null>('select plant.beta_lactam_room_problem($1, $2) as r', [suite.id, (await w.batch('BL-A', product)).id])).toBeNull();
  });

  it('[PR-27] a batch that is not beta-lactam is refused a room or line dedicated to beta-lactam products, at the clearance and at the start of its use', async () => {
    const other = await w.product();
    const suite = await w.room();
    await dedicate(suite.code);
    await w.clean('AREA', suite.code, 'MAJOR');
    expect(await messageOf(w.recordClearance(suite.code, 'PRODUCT_CHANGE', { batch: 'NBL-A', product: other })))
      .toMatch(new RegExp(`EBMR-PLANT-178 ${suite.code} is dedicated to beta-lactam products and batch TEST-NBL-A-\\w+ of ${other} is not beta-lactam`));
    const line = await w.room({ kind: 'LINE' });
    await dedicate(line.code);
    expect(await messageOf(occupy(w, line.code, 'NBL-B', other, true))).toMatch(/EBMR-PLANT-178/);
    // A withdrawn dedication: the room serves other products again (a withdrawal counts at once, 0912).
    await dedicate(suite.code, false, false);
    expect(await occupy(w, suite.code, 'NBL-A', other)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[PR-27] the occupancy guard holds for a row written past the command: a direct insert as the owner is refused', async () => {
    const other = await w.product();
    const plainRoom = await w.room();
    const clearance = await (async () => {
      await w.clean('AREA', plainRoom.code, 'MAJOR');
      return w.clear(plainRoom.code, 'PRODUCT_CHANGE', { batch: 'NBL-C', product: other });
    })();
    await dedicate(plainRoom.code);
    const b = await w.batch('NBL-C', other);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role ebmr_owner');
      const err = await messageOf(c.query(
        `insert into plant.area_occupancy (area_id, exclusive, batch_id, batch_ref, product_code, stage, clearance_id, started_by)
         values ($1, true, $2, $3, $4, 'COMPRESSION', $5, $6)`,
        [plainRoom.id, b.id, b.number, other, clearance, randomUUID()],
      ));
      expect(err).toMatch(/EBMR-PLANT-178/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('[PR-27] a dedication names BETA_LACTAM among the classes a room or line is dedicated to; a product hazard class never is', async () => {
    const room = await w.room();
    expect(await dedicate(room.code)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await scalar<boolean>("select plant.area_dedicated($1, 'BETA_LACTAM') as r", [room.code])).toBe(true);
    const product = await w.product();
    expect(await messageOf(w.run(qa2, (c) => c.query('select plant.record_product_hazard($1::jsonb)', [JSON.stringify({ productCode: product, hazardClass: 'BETA_LACTAM', riskAssessmentRef: 'RA-1' })])))).toMatch(/EBMR-IND-035/);
  });
  it('[PR-27] a unit\'s use is judged by the room it stands in: a beta-lactam batch is refused a unit outside the suite, any other batch a unit in it; a unit with no room is not checked', async () => {
    const beta = await betaProduct();
    const other = await w.product();
    const suite = await w.room();
    await dedicate(suite.code);
    const plainRoom = await w.room();
    const classCode = (await w.press()).classCode;
    const unitIn = async (area: string | null): Promise<string> => {
      const code = `EQ-${tag()}`;
      await w.run(w.cast.steward, (c) => plant.defineEquipment(c, { code, name: `Unit ${code}`, classCode, ...(area ? { areaCode: area } : {}) }));
      await w.run(w.cast.steward, (c) => plant.recordEquipmentEvent(c, code, 'QUALIFIED', 'IQ/OQ/PQ approved', `QUAL-${code}`));
      await w.clean('EQUIPMENT', code, 'MAJOR');
      return code;
    };
    const outside = await unitIn(plainRoom.code);
    expect(await messageOf(w.startUse(outside, 'BLU-A', beta))).toMatch(new RegExp(`EBMR-PLANT-177 .* ${plainRoom.code} is not a room or line dedicated to beta-lactam products.*\\(unit ${outside} stands there\\)`));
    const inside = await unitIn(suite.code);
    expect(await messageOf(w.startUse(inside, 'NBLU-A', other))).toMatch(new RegExp(`EBMR-PLANT-178 ${suite.code} is dedicated to beta-lactam products.*\\(unit ${inside} stands there\\)`));
    expect(await w.startUse(inside, 'BLU-A', beta)).toMatch(/^[0-9a-f-]{36}$/);
    const loose = await unitIn(null);
    expect(await w.startUse(loose, 'NBLU-B', other)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[PR-27] the classification is read live: a batch issued before its product is classified beta-lactam is refused the suite before, and accepted after', async () => {
    const product = await w.product();
    const suite = await w.room();
    await dedicate(suite.code);
    await w.batch('LIVE-A', product);
    expect(await messageOf(occupy(w, suite.code, 'LIVE-A', product))).toMatch(/EBMR-PLANT-178/);
    await w.run(w.cast.steward, (c) => c.query("select plant.classify_beta_lactam('PRODUCT', $1, true, 'Reclassified: a cephalosporin') as r", [product]));
    expect(await occupy(w, suite.code, 'LIVE-A', product)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[PR-27] a later dedication not yet approved leaves the earlier approved one in force', async () => {
    const beta = await betaProduct();
    const other = await w.product();
    const suite = await w.room();
    await dedicate(suite.code);
    await dedicate(suite.code, true, false);
    expect(await scalar<boolean>("select plant.area_dedicated($1, 'BETA_LACTAM') as r", [suite.code])).toBe(true);
    expect(await messageOf(occupy(w, suite.code, 'LATE-N', other))).toMatch(/EBMR-PLANT-178/);
    expect(await occupy(w, suite.code, 'LATE-B', beta)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
