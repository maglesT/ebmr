/**
 * The ERP shipping interlock in the database (Phase 4 slice 4b; site services 0870; INV-42, IN-05 (a), DI-39). The ERP
 * stub records shipments as the application role through site.erp_record_shipment; every rule is also tried around
 * (the application role writing the table, the superuser writing it with the triggers on, a person instead of the ERP,
 * a state claimed on the row).
 *
 * Fixtures, not proofs: the finished lot is posted as the edition's definer posts it; the manufacturer release is
 * arranged as the release act leaves it (its decision row, the lot RELEASED) with the triggers off, because the release
 * act itself is proven in recipe-core's release tests; the US and EU dispositions come from a per-file stand-in of
 * recipe.disposition_state reading a fixture table (4a proves the dispositions; this file proves what the interlock
 * does with each state). The interlock, the post-release links, the importer and the quarantine rule run for real.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../../kernel/src/db/command.ts';
import { raiseIncident } from '../../../kernel/src/records/incidents.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, unique } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  await db.admin.query(`
    create schema stub_ship authorization ebmr_owner;
    create table stub_ship.disposition (lot_id uuid not null, market text not null, state text not null, primary key (lot_id, market));
    alter table stub_ship.disposition owner to ebmr_owner;
    create or replace function recipe.disposition_state(p_lot uuid, p_market text) returns text
    language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
    begin
      if p_market = 'IN' then
        return recipe.manufacturer_release_state(p_lot);
      end if;
      if p_market is null or p_market not in ('US', 'EU') or not (p_market = any (coalesce(recipe.market_set('LOT', p_lot), '{}'))) then
        return null;
      end if;
      return coalesce((select d.state from stub_ship.disposition d where d.lot_id = p_lot and d.market = p_market), 'NOT_READY');
    end
    $$;
  `);
}, 300_000);
afterAll(async () => {
  await db.drop();
});

async function fixture(sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** A finished lot in quarantine, as the edition's definer posts it. */
async function finishedLot(markets: string[], productCode = unique('FP')): Promise<string> {
  return withCommand(db.admin, { ...w.cast.warehouse, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: randomUUID(), batchNumber: unique('B'), edition: 'TABLETS', siteCode: 'SITE-1', productCode, productName: `Product ${productCode}`,
                       strength: '500 mg', markets, quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]?.id ?? '',
  );
}

/** The state the AP's manufacturer release leaves (recipe-core 0781): its decision row and the lot RELEASED. */
async function released(lotId: string): Promise<void> {
  await fixture(
    `insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
     values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`,
    [lotId, w.cast.qa.personId, w.cast.qa.accountId],
  );
  await lotState(lotId, 'RELEASED');
}
const lotState = (lotId: string, state: string) =>
  fixture("update platform.aggregate_state set state = $2 where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId, state]);
const disposition = (lotId: string, market: string, state: string) =>
  fixture('insert into stub_ship.disposition (lot_id, market, state) values ($1, $2, $3) on conflict (lot_id, market) do update set state = excluded.state', [lotId, market, state]);

async function importerFor(productCode: string): Promise<string> {
  const code = unique('IMP');
  await fixture(
    `with i as (insert into recipe.eu_importer (code, name, technical_agreement_ref, mia_number, public_key, signature_id, person_id, account_id)
                values ($1, 'Importer GmbH', 'TA-2026-01', 'MIA-DE-001', decode(repeat('ab', 32), 'hex'), gen_random_uuid(), $3, $4) returning id)
     insert into recipe.eu_importer_product (product_code, importer_id) select $2, i.id from i`,
    [code, productCode, w.cast.qa.personId, w.cast.qa.accountId],
  );
  return code;
}

interface Ship {
  lotId: string;
  market: 'IN' | 'US' | 'EU';
  consigneeCode?: string;
  quarantine?: boolean;
  quantity?: string;
  unit?: string;
  shipmentNo?: string;
}
const body = (s: Ship) => ({
  shipmentNo: s.shipmentNo ?? unique('SH'), lotId: s.lotId, market: s.market, consigneeCode: s.consigneeCode ?? 'CUST-01', consigneeName: 'Consignee',
  quantity: s.quantity ?? '100', unit: s.unit ?? 'units', quarantine: s.quarantine ?? false, erpReference: unique('DN'),
});
const ship = (s: Ship, by = w.cast.erp) => w.sql<string>(by, 'select site.erp_record_shipment($1::jsonb) as r', [JSON.stringify(body(s))]);
const problems = (s: Ship) =>
  w.sql<string[]>(w.cast.erp, 'select site.shipment_problems($1, $2, $3, $4, $5::numeric, $6) as r', [
    s.lotId, s.market, s.consigneeCode ?? 'CUST-01', s.quarantine ?? false, s.quantity ?? '100', s.unit ?? 'units',
  ]);

describe('ERP shipping interlock (INV-42, IN-05 (a))', () => {
  it('[INV-42][IN-05] nothing ships without a current manufacturer release: a lot in quarantine, then held after its release, is refused; a released lot ships', async () => {
    const lot = await finishedLot(['IN']);
    expect((await problems({ lotId: lot, market: 'IN' })).join(' ')).toMatch(/no current manufacturer release \(release (NOT_READY|READY), lot QUARANTINE\)/);
    expect(await refusal(ship({ lotId: lot, market: 'IN' }))).toMatch(/EBMR-SHP-002 .*no current manufacturer release/);
    await released(lot);
    expect(await problems({ lotId: lot, market: 'IN' })).toEqual([]);
    const id = await ship({ lotId: lot, market: 'IN' });
    const { rows } = await db.app.query('select market, manufacturer_state, disposition_state, quarantine from site.erp_shipment where id = $1', [id]);
    expect(rows[0]).toEqual({ market: 'IN', manufacturer_state: 'RELEASED', disposition_state: 'RELEASED', quarantine: false });
    // The release is no longer current (the stock blocked): nothing more ships.
    await lotState(lot, 'ON_HOLD');
    expect(await refusal(ship({ lotId: lot, market: 'IN' }))).toMatch(/EBMR-SHP-002 .*no current manufacturer release \(release RELEASED, lot ON_HOLD\)/);
  });

  it('[INV-42] a lot with an open post-release link does not ship until the link is resolved', async () => {
    const lot = await finishedLot(['IN']);
    await released(lot);
    const dev = await w.sql<{ deviationId: string; ref: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Complaint after release', classification: 'MAJOR', riskRationale: 'market complaint on appearance' }),
    ]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [dev.deviationId, lot]);
    expect(await refusal(ship({ lotId: lot, market: 'IN' }))).toMatch(new RegExp(`EBMR-SHP-002 .*deviation ${dev.ref} was linked after the release and is OPEN: an open post-release link`));
    await w.sql(w.cast.qa, 'select site.cancel_deviation($1, $2) as r', [dev.deviationId, 'raised against the wrong lot']);
    expect(await problems({ lotId: lot, market: 'IN' })).toEqual([]);
    await ship({ lotId: lot, market: 'IN' });
  });

  it('[INV-42] a US consignee receives the lot only after the US disposition RELEASED, and only for a market in the lot\'s set', async () => {
    const lot = await finishedLot(['IN', 'US']);
    await released(lot);
    expect(await refusal(ship({ lotId: lot, market: 'US' }))).toMatch(/EBMR-SHP-002 .*US disposition of lot .* is NOT_READY/);
    await disposition(lot, 'US', 'REJECTED');
    expect(await refusal(ship({ lotId: lot, market: 'US' }))).toMatch(/US disposition .* is REJECTED/);
    await disposition(lot, 'US', 'RELEASED');
    await ship({ lotId: lot, market: 'US' });
    expect(await refusal(ship({ lotId: lot, market: 'EU', quarantine: true }))).toMatch(/market EU is not in the market set/);
    await disposition(lot, 'US', 'RELEASE_SUSPENDED');
    expect(await refusal(ship({ lotId: lot, market: 'US' }))).toMatch(/US disposition .* is RELEASE_SUSPENDED/);
  });

  it('[INV-42][DI-39] an EU lot ships only to the importer the technical agreement names, as quarantined goods until the QP certified it', async () => {
    const product = unique('EUP');
    const lot = await finishedLot(['IN', 'EU'], product);
    await released(lot);
    expect(await refusal(ship({ lotId: lot, market: 'EU', consigneeCode: 'ANY-01', quarantine: true }))).toMatch(/no EU importer is named for product/);
    const importer = await importerFor(product);
    expect(await refusal(ship({ lotId: lot, market: 'EU', consigneeCode: importer, quarantine: true }))).toMatch(/EU disposition of lot .* is NOT_READY/);
    await disposition(lot, 'EU', 'AWAITING_QP_CERTIFICATION');
    expect(await refusal(ship({ lotId: lot, market: 'EU', consigneeCode: importer, quarantine: false }))).toMatch(/only as quarantined goods/);
    expect(await refusal(ship({ lotId: lot, market: 'EU', consigneeCode: 'OTHER-01', quarantine: true }))).toMatch(new RegExp(`consignee OTHER-01 is not the EU importer ${importer}`));
    const id = await ship({ lotId: lot, market: 'EU', consigneeCode: importer, quarantine: true });
    const { rows } = await db.app.query<{ eu_importer_id: string | null; disposition_state: string }>('select eu_importer_id, disposition_state from site.erp_shipment where id = $1', [id]);
    expect(rows[0]?.disposition_state).toBe('AWAITING_QP_CERTIFICATION');
    expect(rows[0]?.eu_importer_id).toBeTruthy();
    await disposition(lot, 'EU', 'REJECTED_BY_QP');
    expect(await refusal(ship({ lotId: lot, market: 'EU', consigneeCode: importer, quarantine: true }))).toMatch(/EU disposition .* is REJECTED_BY_QP/);
    await disposition(lot, 'EU', 'CERTIFIED');
    await ship({ lotId: lot, market: 'EU', consigneeCode: importer, quarantine: false });
    expect(await refusal(ship({ lotId: lot, market: 'EU', consigneeCode: 'OTHER-01', quarantine: false }))).toMatch(/is not the EU importer/);
  });

  it('[INV-42][IN-05] the database refuses every way around the interlock: direct writes, the superuser\'s write, a person instead of the ERP, a claimed state, too much or a wrong unit', async () => {
    const lot = await finishedLot(['IN']);
    // The application role never writes the table.
    expect(await refusal(db.app.query(
      `insert into site.erp_shipment (shipment_no, lot_id, market, consignee_code, consignee_name, quantity, unit, quarantine, manufacturer_state, disposition_state, erp_reference, recorded_by_person, recorded_by_account, correlation_id)
       values ('SH-X', $1, 'IN', 'CUST-01', 'C', 1, 'units', false, 'RELEASED', 'RELEASED', 'R', $2, $2, $2)`, [lot, randomUUID()]))).toMatch(/permission denied/);
    // Even a writer with every table right (the superuser, triggers on) meets the interlock, whatever state the row claims.
    const direct = () => withCommand(db.admin, { ...w.cast.erp, correlationId: randomUUID() }, (c) => c.query(
      `insert into site.erp_shipment (shipment_no, lot_id, market, consignee_code, consignee_name, quantity, unit, quarantine, manufacturer_state, disposition_state, erp_reference, recorded_by_person, recorded_by_account, correlation_id)
       values ($3, $1, 'IN', 'CUST-01', 'C', 1, 'units', false, 'RELEASED', 'RELEASED', 'R', $2, $2, $2) returning manufacturer_state`, [lot, randomUUID(), unique('SH')]));
    expect(await refusal(direct())).toMatch(/EBMR-SHP-002 .*no current manufacturer release/);
    // Only the ERP interface records a shipment.
    await released(lot);
    expect(await refusal(ship({ lotId: lot, market: 'IN' }, w.cast.warehouse))).toMatch(/EBMR-IAM-040/);
    expect(await refusal(ship({ lotId: lot, market: 'IN' }, w.cast.qa))).toMatch(/EBMR-IAM-040/);
    // Quantity and unit: what is left of the lot, in its unit; a number is never re-used.
    expect(await refusal(ship({ lotId: lot, market: 'IN', unit: 'kg' }))).toMatch(/positive quantity in the lot's unit units/);
    await ship({ lotId: lot, market: 'IN', quantity: '900', shipmentNo: 'SH-DUP-1' });
    expect(await refusal(ship({ lotId: lot, market: 'IN', quantity: '100.5' }))).toMatch(/has 100 units left to ship, not 100.5/);
    expect(await refusal(ship({ lotId: lot, market: 'IN', quantity: '1', shipmentNo: 'SH-DUP-1' }))).toMatch(/EBMR-SHP-003/);
    expect(await refusal(w.sql(w.cast.erp, 'select site.erp_record_shipment($1::jsonb) as r', [JSON.stringify({ ...body({ lotId: lot, market: 'IN' }), quantity: 5 })]))).toMatch(/EBMR-SHP-001/);
    // The shipment rows are insert-only.
    expect(await refusal(db.app.query("update site.erp_shipment set market = 'US' where lot_id = $1", [lot]))).toMatch(/permission denied/);
  });

  it('[INV-42] the interlock takes the release acts\' locks: an incident linked to the lot after its release, committing while the ERP ships, is seen and refuses the shipment', async () => {
    const lot = await finishedLot(['IN']);
    await released(lot);
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...w.cast.qa, correlationId: randomUUID() }))]);
      await raiseIncident(c, { source: 'OTHER', type: 'MARKET_COMPLAINT', severity: 'MAJOR', title: 'Complaint on the released lot', links: [{ aggregateType: 'material_lot', aggregateId: lot }] });
      // The shipment starts while the incident is not committed: it waits on the lot's blocker epoch.
      let settled = false;
      const shipping = refusal(ship({ lotId: lot, market: 'IN' })).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(settled).toBe(false);
      await c.query('commit');
      expect(await shipping).toMatch(/EBMR-SHP-002 .*incident .* was opened after the release: an open post-release link/);
    } finally {
      c.release();
    }
    const { rows } = await db.app.query<{ n: number }>('select count(*)::int as n from site.erp_shipment where lot_id = $1', [lot]);
    expect(rows[0]?.n).toBe(0);
  });
});
