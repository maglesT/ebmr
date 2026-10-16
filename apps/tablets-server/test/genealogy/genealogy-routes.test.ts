/**
 * The genealogy and recall routes over HTTP (Phase 6 slice 6d; contract ns/genealogy.ts and ns/recall.ts; recipe-core
 * 1010 to 1013, tablets 1280; PR-57, IN-07, IN-29, PR-50, PR-49): the trace both ways with its as-of point, the
 * complaint lookup by lot, batch or shipment number, the API supply-chain report, the deviation impact query, the
 * recurrence read of the certification screen, and the mock recall run by QA and signed off by the AP through the
 * ceremony (MOCK_RECALL_SIGN_OFF on mock_recall), never by QA.
 *
 * Fixtures, not proofs (written as the owner, triggers off; each event's own act is proven in its package): an API lot
 * consumed by a batch, its finished lot and one distribution record. The genealogy and the mock recall are the
 * database's (recipe-core tests prove them); this file proves the routes carry them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { describeAction, signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let qa: TestBrowser;
let ap: TestBrowser;
const tag = randomUUID().slice(0, 6).toUpperCase();
const ids = { api: randomUUID(), batch: randomUUID(), lot: randomUUID(), shipment: randomUUID() };
const codes = { api: `API-${tag}`, batch: `GN-${tag}`, shipment: `SH-${tag}` };

async function fixture(sql: string, params: unknown[]): Promise<void> {
  const c = await gmp.db.admin.connect();
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

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  [qa, ap] = await Promise.all([gmp.asPersona('qaInvestigator'), gmp.asPersona('qcuAuthoriser')]);
  const who = randomUUID();
  await fixture(
    `with a as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, supplier_lot, received_quantity, unit, expires_at,
                                               received_by_person, received_by_account, correlation_id)
                values ($1, 'SITE-1', $5, 'API-PCM', 'Paracetamol', 'API', 'SUP-1', 'SB-77', 100, 'kg', '2030-01-01T00:00:00Z', $8, $8, $8) returning id),
          f as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                               received_by_person, received_by_account, correlation_id)
                values ($3, 'SITE-1', $6, 'GN-500', 'Genealogy tablets 500 mg', 'FINISHED', 1000, 'units', '2029-01-01T00:00:00Z', $8, $8, $8) returning id),
          b as (insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
                values ($2, gen_random_uuid(), $6, $8, $8, $8) returning batch_id),
          c as (insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                                  market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                values ($1, gen_random_uuid(), $2, $6, 'TABLETS', 'API-PCM', 10, 'kg', 100, 90, '{IN}', 'INTERMEDIATE', $8, $8, 1) returning id),
          fl as (insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
                 values ($3, $2, $6, 'TABLETS', 'GN-500', '500 mg', '{IN}', $8, $8) returning lot_id)
     insert into site.erp_shipment (id, shipment_no, lot_id, market, consignee_code, consignee_name, consignee_address, quantity, unit, quarantine, manufacturer_state,
                                    disposition_state, erp_reference, shipped_at, lot_code, product_name, strength, recorded_by_person, recorded_by_account, correlation_id)
     values ($4, $7, $3, 'IN', 'CUST-1', 'Pune Distributors', '12 Station Road, Pune', 400, 'units', false, 'RELEASED', 'RELEASED', 'DN-1', now(), $6,
             'Genealogy tablets 500 mg', '500 mg', $8, $8, $8)`,
    [ids.api, ids.batch, ids.lot, ids.shipment, codes.api, codes.batch, codes.shipment, who],
  );
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.why.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? refusalOf(r)?.code ?? 'refused'));

describe('genealogy routes over HTTP (PR-57, IN-07)', () => {
  it('[PR-57][IN-07] the trace both ways, with node labels, depth and the as-of point; an unknown start is a 404', async () => {
    const fwd = valueOf(await qa.call(routes.genealogy.trace, { query: { kind: 'LOT', id: ids.api, direction: 'FORWARD' } }));
    expect(fwd.start).toMatchObject({ kind: 'LOT', id: ids.api, label: codes.api, code: 'API-PCM', subKind: 'API' });
    expect(fwd.edges.map((e) => [e.node.kind, e.parent?.kind ?? null, e.edgeKind, e.depth])).toEqual([
      ['LOT', null, null, 0], ['BATCH', 'LOT', 'CONSUMED', 1], ['LOT', 'BATCH', 'FINISHED', 2], ['SHIPMENT', 'LOT', 'SHIPPED', 3],
    ]);
    expect(fwd.nodes.find((n) => n.kind === 'SHIPMENT')).toMatchObject({ label: codes.shipment, state: 'CUST-1', subKind: 'IN' });
    expect(fwd.counts).toEqual({ lots: 2, batches: 1, containers: 0, shipments: 1 });
    const back = valueOf(await qa.call(routes.genealogy.trace, { query: { kind: 'SHIPMENT', id: ids.shipment, direction: 'BACKWARD', asOfUs: fwd.asOf.us } }));
    expect(back.nodes.map((n) => n.label).sort()).toEqual([codes.api, codes.batch, codes.batch, codes.shipment].sort());
    expect(back.asOf.us).toBe(fwd.asOf.us);
    expect(refusalOf(await qa.call(routes.genealogy.trace, { query: { kind: 'LOT', id: randomUUID(), direction: 'FORWARD' } })).status).toBe(404);
    expect(refusalOf(await qa.call(routes.genealogy.trace, { query: { kind: 'LOT', id: ids.api, direction: 'FORWARD', asOfUs: '1000000' } })).status).toBe(404);
  });

  it('[PR-57][IN-07] the complaint lookup by lot, batch or shipment number opens the lot, its deviations, shipments and genealogy; the supply-chain report names the API lot and its supplier', async () => {
    for (const code of [codes.batch, codes.shipment, codes.batch.toLowerCase()]) {
      const v = valueOf(await qa.call(routes.genealogy.lookup, { query: { code } }));
      expect(v.lot).toMatchObject({ id: ids.lot, label: codes.batch, subKind: 'FINISHED' });
      expect(v.shipments).toEqual([expect.objectContaining({ shipmentNo: codes.shipment, consigneeName: 'Pune Distributors', consigneeAddress: '12 Station Road, Pune', quantity: '400', complete: true })]);
      expect(v.upstreamLots.map((l) => l.id)).toEqual([ids.api]);
      expect(v.batches.map((b) => b.id)).toEqual([ids.batch]);
      expect(v.deviations).toEqual([]);
    }
    expect(refusalOf(await qa.call(routes.genealogy.lookup, { query: { code: 'NOTHING-HERE' } })).status).toBe(404);
    const sc = valueOf(await qa.call(routes.genealogy.supplyChain, { params: { lotId: ids.lot } }));
    expect(sc.lines).toEqual([expect.objectContaining({ lot: expect.objectContaining({ id: ids.api, subKind: 'API' }), depth: 2, supplier: 'SUP-1', supplierLot: 'SB-77', consumedBy: [codes.batch] })]);
  });

  it('[PR-49][PR-50] the recurrence read of a finished lot and the deviation impact query answer; neither exists for what is not there', async () => {
    expect(valueOf(await qa.call(routes.genealogy.recurrence, { params: { lotId: ids.lot } }))).toEqual({ lotId: ids.lot, threshold: 3, windowDays: 365, warning: false, items: [] });
    expect(refusalOf(await qa.call(routes.genealogy.recurrence, { params: { lotId: ids.api } })).status).toBe(404);
    expect(refusalOf(await qa.call(routes.genealogy.deviationImpact, { params: { deviationId: randomUUID() } })).status).toBe(404);
  });
});

describe('mock recall routes over HTTP (IN-29)', () => {
  it('[IN-29] QA runs a mock recall from a lot; it lists the consignee and the reconciliation, reproduces and is listed; the AP signs it off through the ceremony, QA cannot, and only once', async () => {
    const body = { subjectKind: 'LOT' as const, subjectId: ids.api, authorityInformed: false };
    const m = valueOf(await qa.call(routes.recall.run, { body }));
    expect(m).toMatchObject({ subjectKind: 'LOT', subjectRef: codes.api, queryVersion: 1, reproduces: true, authorityInformed: false, signOff: null, ranBy: { role: 'QA_REVIEWER' } });
    expect(m.batches.map((b) => b.batchId)).toEqual([ids.batch]);
    expect(m.lots.find((l) => l.lotId === ids.lot)).toMatchObject({ delivered: '400', returned: '0', outstanding: '400', unit: 'units' });
    expect(m.consignees).toEqual([expect.objectContaining({ consigneeCode: 'CUST-1', consigneeAddress: '12 Station Road, Pune', markets: ['IN'] })]);
    expect(m.counts).toEqual({ batches: 1, lots: 2, consignees: 1, shipments: 1, incompleteRecords: 0 });
    expect(valueOf(await qa.call(routes.recall.mockRecalls, {})).mockRecalls.map((x) => x.mockRecallId)).toContain(m.mockRecallId);
    expect(refusalOf(await qa.call(routes.recall.mockRecall, { params: { mockRecallId: randomUUID() } })).status).toBe(404);
    expect(refusalOf(await qa.call(routes.recall.run, { body: { ...body, authorityInformed: true } })).status).toBe(422);

    const act: SignableAction = { kind: 'MOCK_RECALL_SIGN_OFF', mockRecallId: m.mockRecallId };
    expect(await describeAction(ap, act)).toMatchObject({ aggregateType: 'mock_recall', aggregateId: m.mockRecallId, meaning: 'MOCK_RECALL_SIGNED_OFF', expectedState: 'RUN' });
    expect(codeOf(await signAction(gmp, qa, 'qaInvestigator', act))).not.toBe('ok');
    expect(codeOf(await signAction(gmp, ap, 'qcuAuthoriser', act))).toBe('ok');
    const signed = valueOf(await qa.call(routes.recall.mockRecall, { params: { mockRecallId: m.mockRecallId } }));
    expect(signed.signOff).toMatchObject({ signedBy: { role: 'AUTHORISED_PERSON' } });
    expect(codeOf(await signAction(gmp, ap, 'qcuAuthoriser', act))).not.toBe('ok');
  });
});
