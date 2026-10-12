/**
 * After release over HTTP (Phase 4 slice 5a; contract ns/release.ts `suspended`, `afterRelease`, RELEASE_ACT RECONFIRM,
 * RECALL, REJECT_AFTER_RELEASE and DISPOSAL; recipe-core 0840, site services 0880): a deviation linked to a released lot
 * suspends it in the linking transaction (the views show the cause, the AP's open task and the ERP stock block), and the
 * AP recalls it through the ceremony, the lot register moving with it; the rules themselves are proven in recipe-core's
 * after-release tests.
 *
 * Fixture, not proof: the manufacturer release is arranged as its act leaves it (its decision row and the lot's transition in
 * one transaction), as in qp-shipping-routes.test.ts. The signed acts need the ceremony mapping of release_suspension and disposal
 * (tab.kernel_signing_meanings, re-created once by slice 5b in tablets 1199): they run once that mapping is installed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type ReleaseActInput, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { refusalOf, valueOf } from '../esig/support.ts';
import { actorOf, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let ap: TestBrowser;
let lotId: string;
let mapped = false;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  ap = await w.gmp.asPersona('qcuAuthoriser');
  const batchId = await w.issued(issuer);
  const number = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId])).rows[0]!.n;
  const stores = await actorOf(w.gmp, 'stores');
  lotId = await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId, batchNumber: number, edition: 'TABLETS', siteCode: 'SITE-1', productCode: w.content.header.product.code, productName: 'After-release product',
                       strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
  const apActor = await actorOf(w.gmp, 'qcuAuthoriser');
  await withCommand(w.gmp.db.admin, { ...apActor, correlationId: randomUUID() }, async (c) => {
    await c.query('alter table recipe.manufacturer_release_decision disable trigger zzzn_notify_departments');
    await c.query(`insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
             values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{"items": []}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`, [lotId, apActor.personId, apActor.accountId]);
    // The lot register moves as the act moves it (material_lot v3 needs a continuous history for the later recall).
    await c.query("select site.lot_transition(l, 'MANUFACTURER_RELEASE', s.version, null, null) from site.material_lot l join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id where l.id = $1", [lotId]);
    await c.query('alter table recipe.manufacturer_release_decision enable trigger zzzn_notify_departments');
  });
  mapped = (await w.gmp.db.admin.query<{ m: boolean }>("select 'RECALLED' = any (tab.kernel_signing_meanings('release_suspension')) as m")).rows[0]!.m;
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const view = async () => valueOf(await ap.call(routes.release.afterRelease, { params: { lotId } }));
const recall = (input: ReleaseActInput): SignableAction => ({ kind: 'RELEASE_ACT', act: 'RECALL', lotId, input });

describe('after release over HTTP (slice 5a; L-19, IN-29)', () => {
  it('[L-19][IN-29] a deviation linked after the release suspends the lot at once; the views show the cause, the AP\'s task, the ERP block and the gates', async () => {
    let v = await view();
    expect(v.manufacturerState).toBe('RELEASED');
    expect(v.causes).toEqual([]);
    expect(v.markets.map((m) => [m.market, m.state, m.gates.recall.ready, m.gates.reconfirm.ready])).toEqual([['IN', 'RELEASED', true, false]]);
    expect(v.markets[0]!.signable.recall).toBe(`${lotId}/IN/RECALL/1`);
    expect(v.disposalGate.ready).toBe(false);

    const operator = await actorOf(w.gmp, 'qaInvestigator');
    await withCommand(w.gmp.db.app, { ...operator, correlationId: randomUUID() }, async (c) => {
      const d = (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title: 'Complaint after release', classification: 'MAJOR', riskRationale: 'Market complaint on appearance' }),
      ])).rows[0]!.r;
      await c.query("select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lotId]);
    });
    v = await view();
    expect(v.manufacturerState).toBe('RELEASE_SUSPENDED');
    expect(v.causes.map((c) => [c.market, c.causeKind, c.via.kind, c.priorState, c.covered])).toEqual([['IN', 'DEVIATION', 'LOT', 'RELEASED', false]]);
    expect(v.causes[0]!.problem).toMatch(/a cause is resolved once its deviation is closed/);
    expect(v.markets[0]).toMatchObject({ state: 'RELEASE_SUSPENDED', priorState: 'RELEASED' });
    expect(v.markets[0]!.gates.reconfirm.ready).toBe(false);
    expect(v.tasks.map((t) => [t.kind, t.ownerRole, t.status])).toEqual([['RECALL_ASSESSMENT', 'AUTHORISED_PERSON', 'OPEN']]);
    expect(v.stockBlocks.map((b) => [b.kind, b.deliveredAt])).toEqual([['BLOCK', null]]);
    const queue = valueOf(await ap.call(routes.release.suspended, {}));
    expect(queue.lots.find((l) => l.lotId === lotId)).toMatchObject({ manufacturerState: 'RELEASE_SUSPENDED', suspendedMarkets: ['IN'], openTask: true });
    expect(refusalOf(await ap.call(routes.release.afterRelease, { params: { lotId: randomUUID() } }))?.code).toBe('EBMR-REL-010');
  });

  it('[L-19][IN-05] the AP recalls the suspended lot through the ceremony (with a reason); a recall without one signs nothing; the lot register moves with it', async (ctx) => {
    if (!mapped) {
      // The ceremony mapping of release_suspension arrives with slice 5b's single re-creation (tablets 1199).
      ctx.skip();
      return;
    }
    const without = await signAction(w.gmp, ap, 'qcuAuthoriser', recall({ market: 'IN' }));
    expect(refusalOf(without)?.code).toBe('EBMR-API-ACT-INPUT');
    const r = await signAction(w.gmp, ap, 'qcuAuthoriser', recall({ market: 'IN', reason: { code: 'COMPLAINT', text: 'Complaint cluster: tablets crumbling in the blister' } }));
    expect(r.ok ? null : refusalOf(r)).toBeNull();
    const v = await view();
    expect(v.manufacturerState).toBe('RECALLED');
    expect(v.decisions.map((d) => [d.market, d.act, d.toState])).toEqual([['IN', 'RECALL', 'RECALLED']]);
    expect(v.tasks[0]!.status).toBe('CLOSED');
    expect(v.disposalGate.ready).toBe(true);
    const st = (await w.gmp.db.admin.query<{ s: string }>("select state as s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]!.s;
    expect(st).toBe('RECALLED');
  });
});
