/**
 * Storing a batch's retention over HTTP (Phase 4 slice 6b, archive syncRetention; Phase 6 mutation triage T13). The
 * kernel stores a schedule with the inputs it is given and links two schedules when asked (kernel 0420, 1172); which
 * batch records depend on which is decided only in the route, from the batch's lots: a processing record supports the
 * packaging records packed from it, so its retention must follow theirs (DI-47, dependency inheritance). The other
 * archive routes are proved in archive-routes.test.ts, whose world has no approved batch-record type on purpose.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { valueOf } from '../esig/support.ts';
import { actorOf, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';

let w: GmpBatchWorld;
let qa: TestBrowser;
let processing: string;
let packaging: string;
let processing2: string;
let packaging2: string;

/** Fixture, not proof: rows written with the triggers off for this one transaction. */
async function fixture(sql: string, params: unknown[]): Promise<void> {
  const client = await w.gmp.db.admin.connect();
  try {
    await client.query('begin');
    await client.query("set local session_replication_role = 'replica'");
    await client.query(sql, params);
    await client.query('commit');
  } finally {
    client.release();
  }
}

/** Two issued batches, the second registered as a packaging order of the first (fixture), and the packaging batch's lot. */
async function packedPair(issuer: TestBrowser): Promise<[string, string]> {
  const proc = await w.issued(issuer);
  const pack = await w.issued(issuer);
  await fixture(
    `update site.batch_number_allocation a set batch_kind = 'PACKAGING', parent_allocation_id = (select l.allocation_id from recipe.batch_allocation_link l where l.batch_id = $1)
      where a.id = (select l.allocation_id from recipe.batch_allocation_link l where l.batch_id = $2)`,
    [proc, pack],
  );
  const batchNumber = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [pack])).rows[0]!.n;
  // The lot expires at the end of its expiry date in the site's zone, as the edition posts it (tablets 1201).
  const stores = await actorOf(w.gmp, 'stores');
  await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, (c) =>
    c.query('select site.create_finished_lot($1::jsonb)', [
      JSON.stringify({ batchId: pack, batchNumber, edition: 'TABLETS', siteCode: 'SITE-1', productCode: w.content.header.product.code, productName: 'Retention product',
                       strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59+05:30' }),
    ]),
  );
  return [proc, pack];
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  qa = await w.gmp.asPersona('qaInvestigator');
  // Fixture: an approved record type with the batch-record retention key (its define-and-approve workflow is proved in
  // the kernel's records tests).
  const person = randomUUID();
  await fixture(
    `insert into records.record_type (code, version, title, description, official_record, data_class, gmp_criticality, official_medium, original_and_copies,
                                      storage_location, owning_module, owner_role, retention_key, review_rule, feeds_acceptance_limit, defined_by_person)
     values ('T13_BATCH_RECORD', 1, 'batch record', 'test record type', true, 'RAW', 'HIGH', 'ELECTRONIC', 'the electronic record is the original',
             'eBMR edition database', 'test', 'QA', 'BATCH_RECORD', 'QA review', true, $1)`,
    [person],
  );
  await fixture('insert into records.record_type_approval (code, version, approved_by_person, approval_signature_id) values ($1, 1, $2, $3)', ['T13_BATCH_RECORD', person, randomUUID()]);
  [processing, packaging] = await packedPair(issuer);
  [processing2, packaging2] = await packedPair(issuer);
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const sync = async (batchId: string) => valueOf(await qa.call(routes.archive.syncRetention, { params: { batchId }, body: { reason: 'retention of the batch record' } }));
const links = async () =>
  (await w.gmp.db.admin.query<{ s: string; d: string; k: string }>('select supporting_record_key as s, dependant_record_key as d, link_kind as k from records.retention_dependency order by recorded_at, id')).rows;

describe('storing a batch\'s retention (archive syncRetention; T13)', () => {
  it('[DI-47][IN-08] QA stores each batch\'s retention from its record, a second sync updates it, and the processing record follows the packaging record packed from it, whichever is stored first', async () => {
    expect(await w.gmp.db.admin.query<{ b: string[] }>("select recipe.release_batches(lot_id) as b from site.finished_lot where batch_id = $1", [packaging]).then((r) => r.rows[0]?.b)).toEqual([packaging, processing]);
    const first = await sync(processing);
    expect([first.scheduled, first.drift]).toEqual([true, []]);
    // The packaging record is not stored yet: nothing to link.
    expect(await links()).toEqual([]);
    const pack = await sync(packaging);
    expect([pack.scheduled, pack.drift, pack.inputs.expiryDate]).toEqual([true, [], '2029-06-30']);
    expect(await links()).toEqual([{ s: `batch:${processing}`, d: `batch:${packaging}`, k: 'BULK_PACKED_INTO' }]);
    // The processing record's retention is now governed by, or held open for, the packaging record.
    const again = await sync(processing);
    expect([again.scheduled, again.drift]).toEqual([true, []]);
    expect([...again.governedBy, ...again.openBecause].some((x) => x.includes(`batch:${packaging}`))).toBe(true);
    expect(await links()).toHaveLength(1);
    const stored = (await w.gmp.db.admin.query<{ n: number }>("select count(*)::int as n from records.retention_schedule where record_key in ($1, $2)", [`batch:${processing}`, `batch:${packaging}`])).rows[0]!.n;
    expect(stored).toBe(2);
    // The other order: the packaging record stored first, then the processing record it was packed from.
    await sync(packaging2);
    expect(await links()).toHaveLength(1);
    await sync(processing2);
    expect((await links())[1]).toEqual({ s: `batch:${processing2}`, d: `batch:${packaging2}`, k: 'BULK_PACKED_INTO' });
  });

  it('[DI-41][DI-47][DI-17] a batch whose retention is stored still opens in the archive and is exported with its stored retention, read without the investigation-revealing kernel reader', async () => {
    const view = valueOf(await qa.call(routes.archive.batch, { params: { batchId: packaging } }));
    expect([view.retention.scheduled, view.retention.status, view.retention.drift]).toEqual([true, 'DATED', []]);
    expect(view.retention.retainUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.retention.governingRules.length).toBeGreaterThan(0);
    const exp = valueOf(await qa.call(routes.archive.assembleExport, { params: { batchId: processing } }));
    expect(exp.state).toBe('ASSEMBLED');
    // F34 (tablets 0460) stands: the application role still may not run the kernel's reader that names blocking investigations.
    const denied = await w.gmp.db.app.query("select records.retention_of('batch', $1)", [processing]).then(() => 'ran', (e: Error) => e.message);
    expect(denied).toMatch(/permission denied/);
  });

  it('[AS-24][DI-47] a lot with a retest date makes its batch retest-labelled: OPEN until it ships, then the latest shipment date of its lots reaches the stored retention inputs', async () => {
    const [, pack] = await packedPair(await w.gmp.asPersona('issuer'));
    const lot = (await w.gmp.db.admin.query<{ id: string }>('select lot_id as id from site.finished_lot where batch_id = $1', [pack])).rows[0]!.id;
    await fixture("update site.material_lot set retest_at = '2027-06-30T12:00:00Z' where id = $1", [lot]);
    const unshipped = await sync(pack);
    expect(unshipped.status).toBe('OPEN');
    expect(unshipped.openBecause).toContain(`batch:${pack}: MISSING_INPUT:DISTRIBUTION`);
    const ship = (no: string, shippedAt: string | null, recordedAt: string) =>
      fixture(
        `insert into site.erp_shipment (shipment_no, lot_id, market, consignee_code, consignee_name, quantity, unit, quarantine, manufacturer_state, disposition_state,
                                        erp_reference, recorded_by_person, recorded_by_account, correlation_id, shipped_at, recorded_at)
         values ($1, $2, 'IN', 'C-1', 'Consignee', 10, 'units', false, 'RELEASED', 'RELEASED', 'ERP-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $3, $4)`,
        [no, lot, shippedAt, recordedAt],
      );
    await ship(`SH-${pack.slice(0, 8).toUpperCase()}-1`, '2026-08-01T12:00:00Z', '2026-08-02T12:00:00Z');
    // A stub-route shipment without a shipping date counts at its recording time.
    await ship(`SH-${pack.slice(0, 8).toUpperCase()}-2`, null, '2026-09-15T12:00:00Z');
    const shipped = await sync(pack);
    expect(shipped.drift).toEqual([]);
    const stored = (await w.gmp.db.admin.query<{ i: Record<string, unknown> }>(
      'select inputs as i from records.retention_input where record_key = $1 order by input_version desc limit 1', [`batch:${pack}`])).rows[0]!.i;
    expect([stored['retestLabelled'], stored['distributionDate']]).toEqual([true, '2026-09-15']);
    const own = (await w.gmp.db.admin.query<{ e: { ruleId: string; date: string | null }[] }>(
      "select records.evaluate_retention(inputs || '{\"retentionKey\": \"BATCH_RECORD\"}') -> 'evaluated' as e from records.retention_input where record_key = $1 order by input_version desc limit 1",
      [`batch:${pack}`])).rows[0]!.e;
    expect(own.find((x) => x.ruleId === 'IN_SCHEDULE_M_RETEST_DISTRIBUTION')?.date).toBe('2029-09-15');
  });
});
