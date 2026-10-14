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
  it('[INV-42][IN-05][PR-45] nothing ships without a current manufacturer release: a lot in quarantine, then held after its release, is refused; a released lot ships', async () => {
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
    // A market the interlock does not know, and no lot at all.
    expect(await problems({ lotId: lot, market: 'XX' as 'IN' })).toEqual(['XX is not a market (IN, US or EU)']);
    expect(await problems({ lotId: lot, market: null as unknown as 'IN' })).toEqual(['NULL is not a market (IN, US or EU)']);
    const none = randomUUID();
    expect(await problems({ lotId: none, market: 'IN' })).toEqual([`${none} is no finished lot`]);
    // The release model's reads are named; any other is refused.
    expect(await refusal(db.admin.query("select site.release_model_text('grel_evaluate', $1, null)", [lot]))).toMatch(/EBMR-SHP-001 grel_evaluate is not a release-model read/);
  });

  it('[INV-42] only a link made after the release counts, and only a link of this lot: an open deviation and an incident linked before the release, and a deviation on another lot, stop nothing', async () => {
    const lot = await finishedLot(['IN']);
    const neighbour = await finishedLot(['IN']);
    const dev = await w.sql<{ deviationId: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Found before the release', classification: 'MINOR', riskRationale: 'assessed by QA before the release' }),
    ]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [dev.deviationId, lot]);
    await withCommand(db.app, { ...w.cast.qa, correlationId: randomUUID() }, (c) =>
      raiseIncident(c, { source: 'OTHER', type: 'MARKET_COMPLAINT', severity: 'MAJOR', title: 'Raised before the release', links: [{ aggregateType: 'material_lot', aggregateId: lot }] }));
    await released(lot);
    await released(neighbour);
    const other = await w.sql<{ deviationId: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Found on the neighbouring lot', classification: 'MAJOR', riskRationale: 'market complaint on appearance' }),
    ]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [other.deviationId, neighbour]);
    expect(await problems({ lotId: lot, market: 'IN' })).toEqual([]);
    expect((await problems({ lotId: neighbour, market: 'IN' })).join(' ')).toMatch(/was linked after the release and is OPEN/);
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
    // Slice 5a (L-19): the link after the release suspended the lot; it ships again only once the AP re-confirmed it
    // (recipe-core 0840; the signed re-confirmation is proven in recipe-core's after-release tests).
    expect((await problems({ lotId: lot, market: 'IN' })).join(' ')).toMatch(/RELEASE_SUSPENDED/);
    await fixture(
      `insert into recipe.after_release_decision (lot_id, market, seq, act, to_state, text, epoch, checklist, suspension_ids, signature_id, content_hash, person_id, account_id, role_code, correlation_id)
       select $1, 'IN', 1, 'RECONFIRM', 'RELEASED', 'fixture', repeat('0', 64), '{}', array_agg(s.id), gen_random_uuid(), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid()
         from recipe.release_suspension s where s.lot_id = $1 and s.market = 'IN'`,
      [lot, w.cast.qa.personId, w.cast.qa.accountId],
    );
    expect(await problems({ lotId: lot, market: 'IN' })).toEqual([]);
    await ship({ lotId: lot, market: 'IN' });
  });

  it('[INV-42] a link after the release to a batch of the lot\'s evidence stops the shipment, whether it names the batch or one of its containers; a link to another batch does not', async () => {
    const [byContainer, byBatch] = [await finishedLot(['IN']), await finishedLot(['IN'])];
    await released(byContainer);
    await released(byBatch);
    const batchOf = async (lotId: string): Promise<string> => (await db.admin.query<{ b: string[] }>('select recipe.release_batches($1) as b', [lotId])).rows[0]!.b[0]!;
    const open = async (title: string): Promise<string> =>
      (await w.sql<{ deviationId: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title, classification: 'MAJOR', riskRationale: 'found after the release' }),
      ])).deviationId;
    // TEST FIXTURE: the links as site.link_deviation records them (proven in the deviation tests), for batches this file has no records of.
    const link = (deviationId: string, kind: 'BATCH' | 'CONTAINER', subjectId: string, batchId: string) =>
      fixture(`insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account)
               values ($1, $2, $3, 'REF-1', $4, 'B-LINKED', 'TABLETS', $5, $5)`, [deviationId, kind, subjectId, batchId, w.cast.operator.personId]);
    const elsewhere = randomUUID();
    await link(await open('Finding on another batch'), 'BATCH', elsewhere, elsewhere);
    expect(await problems({ lotId: byContainer, market: 'IN' })).toEqual([]);
    expect(await problems({ lotId: byBatch, market: 'IN' })).toEqual([]);
    await link(await open('Finding on a container of the batch'), 'CONTAINER', randomUUID(), await batchOf(byContainer));
    expect((await problems({ lotId: byContainer, market: 'IN' })).join(' ')).toMatch(/was linked after the release and is OPEN: an open post-release link/);
    const b = await batchOf(byBatch);
    await link(await open('Finding on the batch'), 'BATCH', b, b);
    expect((await problems({ lotId: byBatch, market: 'IN' })).join(' ')).toMatch(/was linked after the release and is OPEN: an open post-release link/);
  });

  it('[INV-42][PR-49] a deviation linked after the release and closed stops the shipment only with a CONFIRMED impact on this lot\'s own link (D-2a-9); cancelled, of no impact, or confirmed for another lot, it does not', async () => {
    const [lot, neighbour] = [await finishedLot(['IN']), await finishedLot(['IN'])];
    await released(lot);
    await released(neighbour);
    const dev = await w.sql<{ deviationId: string; ref: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Complaint after release on two lots', classification: 'MAJOR', riskRationale: 'market complaint on appearance' }),
    ]);
    const other = await w.sql<{ deviationId: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Another complaint', classification: 'MAJOR', riskRationale: 'market complaint on taste' }),
    ]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [dev.deviationId, lot]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [dev.deviationId, neighbour]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [other.deviationId, lot]);
    // TEST FIXTURE, rolled back: the deviation's state as its closure leaves it (site.deviation_state stood in) and the impacts
    // its assessment records (proven in the deviation tests); the interlock itself runs as it is.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      const state = async (st: string) => {
        await c.query('set local role ebmr_owner');
        await c.query(`create or replace function site.deviation_state(p_id uuid) returns text language sql stable as $$ select '${st}'::text $$`);
        await c.query('reset role');
      };
      const impact = async (d: string, l: string, kind: string) => {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(`insert into site.deviation_impact (deviation_id, seq, link_id, market, impact, rationale, recorded_by_person, recorded_by_account)
                       select $1, (select coalesce(max(seq), 0) + 1 from site.deviation_impact), k.id, 'IN', $3, 'assessed for the test', $4, $4
                         from site.deviation_link k where k.deviation_id = $1 and k.subject_id = $2`, [d, l, kind, w.cast.qa.personId]);
        await c.query("set local session_replication_role = 'origin'");
      };
      const confirmed = async (): Promise<boolean> =>
        (await c.query<{ p: string[] }>("select site.shipment_problems($1, 'IN', 'CUST-01', false, 1, 'units') as p", [lot])).rows[0]!.p.some((x) => x.includes(`deviation ${dev.ref}, linked after the release, was closed with a CONFIRMED impact`));
      const open = async (): Promise<boolean> =>
        (await c.query<{ p: string[] }>("select site.shipment_problems($1, 'IN', 'CUST-01', false, 1, 'units') as p", [lot])).rows[0]!.p.some((x) => /was linked after the release and is/.test(x));
      await state('CLOSED');
      expect([await open(), await confirmed()]).toEqual([false, false]);
      await impact(dev.deviationId, lot, 'NONE');
      expect(await confirmed()).toBe(false);
      await impact(dev.deviationId, neighbour, 'CONFIRMED');
      await impact(other.deviationId, lot, 'CONFIRMED');
      // The same deviation, linked also to another batch and confirmed there.
      const elsewhere = randomUUID();
      await c.query("set local session_replication_role = 'replica'");
      await c.query(`insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account)
                     values ($1, 'BATCH', $2, 'B-ELSEWHERE', $2, 'B-ELSEWHERE', 'TABLETS', $3, $3)`, [dev.deviationId, elsewhere, w.cast.operator.personId]);
      await c.query("set local session_replication_role = 'origin'");
      await impact(dev.deviationId, elsewhere, 'CONFIRMED');
      expect(await confirmed()).toBe(false);
      await state('CANCELLED');
      await impact(dev.deviationId, lot, 'CONFIRMED');
      expect([await open(), await confirmed()]).toEqual([false, false]);
      await state('CLOSED');
      expect(await confirmed()).toBe(true);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('[DI-41][INV-42] the QP package of a finished lot names the chains it may copy and is served only while the manufacturer release is RELEASED and the EU market is in the set and not removed, ineligible or suspended', async () => {
    type Subject = { exists: boolean; open?: boolean; problem?: string | null; chains?: string[] };
    const subject = async (id: string): Promise<Subject> => (await db.admin.query<{ s: Subject }>('select site.qp_package_subject($1) as s', [id])).rows[0]!.s;
    expect(await subject('not-a-lot')).toEqual({ exists: false });
    expect(await subject(randomUUID())).toEqual({ exists: false });
    const eu = await finishedLot(['IN', 'EU']);
    const number = (await db.admin.query<{ n: string; b: string }>('select batch_number as n, batch_id::text as b from site.finished_lot where lot_id = $1', [eu])).rows[0]!;
    const dev = await w.sql<{ deviationId: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Finding in the record', classification: 'MINOR', riskRationale: 'documentation finding' }),
    ]);
    await w.sql(w.cast.operator, "select site.link_deviation($1, 'LOT', $2) as r", [dev.deviationId, eu]);
    // Before the manufacturer release: closed, with the chains it will copy.
    const s = await subject(eu);
    expect(s).toMatchObject({ exists: true, open: false });
    expect(s.problem).toMatch(new RegExp(`^the manufacturer release of lot ${number.n} is (NOT_READY|READY)$`));
    expect([...s.chains!].sort()).toEqual([`batch:${number.b}`, `batch_review:${number.b}`, `deviation:${dev.deviationId}`, `manufacturer_release:${eu}`].sort());
    await released(eu);
    await disposition(eu, 'EU', 'AWAITING_QP_CERTIFICATION');
    expect(await subject(eu)).toMatchObject({ exists: true, open: true, problem: null });
    for (const st of ['REMOVED', 'INELIGIBLE', 'RELEASE_SUSPENDED']) {
      await disposition(eu, 'EU', st);
      expect(await subject(eu)).toMatchObject({ open: false, problem: `the EU market of lot ${number.n} is ${st}` });
    }
    // A lot without the EU market is not served.
    const india = await finishedLot(['IN']);
    await released(india);
    const n2 = (await db.admin.query<{ n: string }>('select batch_number as n from site.finished_lot where lot_id = $1', [india])).rows[0]!.n;
    expect(await subject(india)).toMatchObject({ exists: true, open: false, problem: `the EU market of lot ${n2} is not in its market set` });
    // A lot for the EU alone is served as the EU lot above.
    const euOnly = await finishedLot(['EU']);
    await released(euOnly);
    await disposition(euOnly, 'EU', 'CERTIFIED');
    expect(await subject(euOnly)).toMatchObject({ exists: true, open: true, problem: null });
  });

  it('[INV-42][PR-56] a US consignee receives the lot only after the US disposition RELEASED, and only for a market in the lot\'s set', async () => {
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

  it('[INV-42][DI-39][PR-56] an EU lot ships only to the importer the technical agreement names, as quarantined goods until the QP certified it', async () => {
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
    expect((await problems({ lotId: lot, market: 'IN', quantity: '0' })).join(' ')).toMatch(/a shipment is a positive quantity in the lot's unit units/);
    expect((await problems({ lotId: lot, market: 'IN', quantity: '-1' })).join(' ')).toMatch(/a shipment is a positive quantity/);
    expect(await problems({ lotId: lot, market: 'IN', quantity: '100' })).toEqual([]);
    expect(await refusal(ship({ lotId: lot, market: 'IN', quantity: '1', shipmentNo: 'SH-DUP-1' }))).toMatch(/EBMR-SHP-003/);
    expect(await refusal(w.sql(w.cast.erp, 'select site.erp_record_shipment($1::jsonb) as r', [JSON.stringify({ ...body({ lotId: lot, market: 'IN' }), quantity: 5 })]))).toMatch(/EBMR-SHP-001/);
    // Each member of the message is checked on its own: one wrong member is enough.
    const one = (k: string, v: unknown) => refusal(w.sql(w.cast.erp, 'select site.erp_record_shipment($1::jsonb) as r', [JSON.stringify({ ...body({ lotId: lot, market: 'IN', quantity: '1' }), [k]: v })]));
    for (const [k, v] of [['shipmentNo', 'sh lower'], ['lotId', 'not-a-lot'], ['market', 'JP'], ['consigneeCode', 'x'], ['consigneeName', '   '], ['quantity', '1.5e3'],
                          ['unit', 'two words'], ['quarantine', 'yes'], ['erpReference', '  ']] as [string, unknown][]) {
      expect(await one(k, v), k).toMatch(/EBMR-SHP-001/);
    }
    expect(await refusal(w.sql(w.cast.erp, "select site.erp_record_shipment('[]'::jsonb) as r"))).toMatch(/EBMR-SHP-001/);
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
