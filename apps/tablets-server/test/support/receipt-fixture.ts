/**
 * TEST FIXTURE (arranged as the superuser with triggers off, like the lots it completes): the complete receipt record a
 * purchased lot needs before it is issued (site services 0910; PR-17): the fixture manufacturer approved for the
 * material at the site, the lot's receipt record and the examination of its one container. The receipt rules
 * themselves are proven in packages/site-services/test/erp-wms.
 */
import type pg from 'pg';

export const FIXTURE_MANUFACTURER = 'MFR-FX';

/** Inside an `arrange` transaction (session_replication_role = replica). */
export async function arrangeCompleteReceipt(c: pg.PoolClient, lot: { id: string; site: string; material: string; quantity?: string; unit?: string }): Promise<void> {
  const { rows } = await c.query<{ id: string }>(
    `insert into site.approved_manufacturer (site_code, material_code, manufacturer_code, manufacturer_name, basis, proposed_by_person, proposed_by_account)
     select $1, $2, $3, 'Fixture manufacturer', 'TEST FIXTURE: approved for the test', gen_random_uuid(), gen_random_uuid()
      where not site.manufacturer_approved($1, $2, $3)
     returning id`,
    [lot.site, lot.material, FIXTURE_MANUFACTURER],
  );
  if (rows[0]) {
    await c.query(
      'insert into site.approved_manufacturer_approval (approved_manufacturer_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())',
      [rows[0].id],
    );
  }
  await c.query(
    `insert into site.lot_receipt (lot_id, site_code, delivery_id, supplier_code, supplier_lot, manufacturer_code, containers, received_value, received_unit,
                                   manufacturer_approved, source, recorded_by_person, recorded_by_account, correlation_id)
     values ($1::uuid, $2, 'DEL-' || left($1::uuid::text, 8), 'SUP-FX', 'SB-' || left($1::uuid::text, 8), $3, 1, $4, $5, true, 'MANUAL', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [lot.id, lot.site, FIXTURE_MANUFACTURER, lot.quantity ?? '100', lot.unit ?? 'kg'],
  );
  await c.query(
    "insert into site.lot_receipt_examination (lot_id, containers_examined, outcome, examined_by_person, examined_by_account) values ($1, 1, 'ACCEPTABLE', gen_random_uuid(), gen_random_uuid())",
    [lot.id],
  );
}
