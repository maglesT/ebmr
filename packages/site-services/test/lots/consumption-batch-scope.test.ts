/**
 * The dispensing consumption is authorised in the batch's product scope (Phase 6 exit review 6jc-R16, the rest;
 * recipe-core 1217, site services 1103; IN-04, DI-21, DI-17, INV-13).
 *
 * Before: recipe.consume_lot (recipe-core 0700) checked DISPENSE.EXECUTE at the actor's location only and
 * site.consume_reservation (site services 0712) again in the lot's site only. Neither names the batch's product, so a
 * requirement limited to any product applied to every consumption (iam.requirement_applies fails closed). Now the batch
 * side checks at the actor's location with the batch's product, and the site side in the lot's site with the batch's
 * product (site.subject_identity); a requirement limited to another product no longer applies.
 *
 * The batch is a fixture written by the superuser with triggers off (its planned batch, register allocation and family
 * name the product; its execution row is a running test run, so the batch-side entry check of a GMP batch does not
 * apply); the lot, the reservation and the consumption go through the real commands as the application role.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionRequirement, qualify, underRequirement, withStaleLms } from '../../../kernel/test/identity/requirements.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal, seedCast, unique, World, type Batch } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

/** A running batch of a new product, known to the site register (site.subject_identity names its site and product). */
async function productBatch(): Promise<Batch & { product: string }> {
  const id = randomUUID();
  const number = unique('B');
  const product = unique('P-');
  const who = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  await w.timeTravel(
    `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                               created_by_person, created_by_account)
                values (gen_random_uuid(), $2, 'Fixture family', 'tablets', 'PROCESSING', $3, 'Fixture tablets', '500 mg', 'TABLET',
                        '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $4, $4) returning id),
          b as (insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
                select $1, $5, f.id, array['IN'], 'SITE-1', 'LINE-1', 'BS-1', $4, $4 from f returning id),
          a as (insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
                                                          batch_size, batch_size_unit, source, external_reference, allocated_by_person_id,
                                                          allocated_by_account_id, correlation_id)
                values (gen_random_uuid(), $5, 'SITE-1', 'Asia/Kolkata', $3, 'Fixture tablets', 'TABLETS', 'PROCESSING', 100, 'kg', 'EXTERNAL', 'fixture',
                        $4, $4, $4) returning id),
          l as (insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
                select b.id, a.id, $5, $4, $4, $4 from b, a returning batch_id),
          p as (insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id,
                                                 version_number, revision, version_state, exporter, exported_at_us, source, imported_by_person,
                                                 imported_by_account, correlation_id)
                values ($6, $6 || '.json', '{}', '{}', $6, gen_random_uuid(), 'FAM', jsonb_build_object('code', $3::text, 'name', 'Fixture tablets'),
                        gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}', $4, $4, $4) returning package_hash),
          x as (insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint,
                                                    policy, policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us,
                                                    issued_by_person, issued_by_account, correlation_id)
                select $1, $5, p.package_hash, $6, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $6, '{}', $6, '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0,
                       $4, $4, $4 from p, l returning id)
     insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
     select x.id, jsonb_build_object('status', 'IN_PROGRESS'), 1, $6, 1, $6, 'IN_PROGRESS' from x`,
    [id, unique('FAM-'), product, who, number, hash],
  );
  const identity = (await db.admin.query<{ v: { productCode: string } }>("select site.subject_identity('BATCH', $1) as v", [id])).rows[0]!.v;
  expect(identity.productCode).toBe(product);
  return { id, number, markets: ['IN'], product };
}

/** A released lot reserved for a new product's running batch (set up before any requirement is in force). */
async function reserved(): Promise<{ batch: Batch & { product: string }; reservation: string; material: string }> {
  const batch = await productBatch();
  const lot = await w.releasedLot('API');
  return { batch, reservation: await w.reserve(lot.lotId, batch, '2'), material: lot.materialCode };
}

describe('the dispensing consumption in the batch\'s product scope (6jc-R16)', () => {
  it('[IN-04][DI-21][INV-13] a product-limited requirement no longer refuses the dispensing consumption on another product\'s batch', async () => {
    const { batch, reservation, material } = await reserved();
    const req = await permissionRequirement(db, 'DISPENSE.EXECUTE', `OTHER-${randomUUID().slice(0, 6)}`);
    await underRequirement(db, req, async () => {
      expect(await w.consume(batch, reservation, material, '1')).toMatchObject({ batch_id: batch.id, quantity_after: '9.000' });
    });
  });

  it('[IN-04][DI-21][INV-13] the dispensing consumption: this product\'s requirement still applies, and once qualified the dispenser consumes', async () => {
    const { batch, reservation, material } = await reserved();
    const req = await permissionRequirement(db, 'DISPENSE.EXECUTE', batch.product);
    await underRequirement(db, req, async () => {
      expect(await refusal(w.consume(batch, reservation, material, '1'))).toMatch(
        new RegExp(`^EBMR-IAM-040 .*DISPENSE\\.EXECUTE in scope .*"product": "${batch.product}".*MISSING_QUALIFICATION:${req.code}`),
      );
      await qualify(db, w.cast.dispenser.personId, req);
      expect(await w.consume(batch, reservation, material, '1')).toMatchObject({ batch_id: batch.id, quantity_after: '9.000' });
    });
  });

  it('[IN-04][DI-21][INV-13] the dispensing consumption: a requirement without a product limit still applies', async () => {
    const { batch, reservation, material } = await reserved();
    const req = await permissionRequirement(db, 'DISPENSE.EXECUTE');
    await underRequirement(db, req, async () => {
      expect(await refusal(w.consume(batch, reservation, material, '1'))).toMatch(new RegExp(`^EBMR-IAM-040 .*MISSING_QUALIFICATION:${req.code}`));
    });
  });

  it('[IN-04][DI-31][INV-13] the dispensing consumption: a stale qualification source is still refused', async () => {
    const { batch, reservation, material } = await reserved();
    const req = await permissionRequirement(db, 'DISPENSE.EXECUTE', batch.product);
    await underRequirement(db, req, async () => {
      await qualify(db, w.cast.dispenser.personId, req, 'LMS');
      const refused = await withStaleLms(db, () => refusal(w.consume(batch, reservation, material, '1')));
      expect(refused).toMatch(new RegExp(`^EBMR-IAM-040 .*STALE_QUALIFICATION_SOURCE:${req.code}`));
    });
  });

  it('[IN-04][DI-17][INV-13] both checks of the consumption name the batch\'s product: the batch side at the actor\'s location, the site side in the lot\'s site', async () => {
    const { batch, reservation, material } = await reserved();
    const req = await permissionRequirement(db, 'DISPENSE.EXECUTE', `OTHER-${randomUUID().slice(0, 6)}`);
    await underRequirement(db, req, async () => {
      expect(await w.consume(batch, reservation, material, '1')).toMatchObject({ batch_id: batch.id });
      const { rows } = await db.admin.query<{ scope: Record<string, string> }>(
        "select e.scope from iam.authority_evaluation e where e.permission_code = 'DISPENSE.EXECUTE' and e.person_id = $1 and e.allowed order by e.evaluated_at desc, e.id desc limit 2",
        [w.cast.dispenser.personId],
      );
      expect(rows.map((r) => r.scope['product'])).toEqual([batch.product, batch.product]);
      expect(rows.some((r) => r.scope['site'] === 'SITE-1' && Object.keys(r.scope).sort().join() === 'product,site')).toBe(true);
    });
  });
});
