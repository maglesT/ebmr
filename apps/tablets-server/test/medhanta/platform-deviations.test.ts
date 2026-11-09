/**
 * MEDHANTA slice 2 (owner ruling, 9 November 2026; replaces declutter residual D4-R5): deviations through the Deviations
 * product. With a Deviations link (DEVIATIONS_DATABASE_URL; a stand-in Deviations database, test/support/fake-deviations.ts)
 * a batch's deviation is linked by its Deviations number only, the release checklist and the review read each number's
 * status from report.deviation_v1, and Batchwright's own deviation management answers 410 DISCONNECTED (owner
 * 'Deviations') for a batch deviation only; lot and laboratory records stay local. Without the link nothing changes: the batch-only deviation screens of G2 stay connected.
 *
 * Controls: PR-49 (a deviation linked to the batch blocks its release until resolved; 21 CFR 211.192), IN-05 (release
 * decided on resolved deviations), DI-17 (only the functions this installation offers are served), platform rule PL-08
 * (a linked read through a versioned view; connection off refuses, never serves a stale or assumed answer).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATCH_DEVIATION_ROUTES_WHEN_LINKED, routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, personaIn, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { FakeDeviations } from '../support/fake-deviations.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

const dv = new FakeDeviations();
let linked: TestServer;
let solo: TestServer;
let qa: TestBrowser;
let qaSolo: TestBrowser;

const tag = (): string => randomUUID().slice(0, 6).toUpperCase();

/** A planned GMP batch at SITE-1 with its register allocation (as site-services' QualityWorld.gmpBatch arranges it). */
async function gmpBatch(server: TestServer): Promise<{ id: string; number: string }> {
  const id = randomUUID();
  const number = `B${tag()}`;
  const who = randomUUID();
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                                 created_by_person, created_by_account)
                  values (gen_random_uuid(), $2, 'Fixture family', 'tablets', 'PROCESSING', 'PARA-500', 'Paracetamol tablets', '500 mg', $2,
                          '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $4, $4) returning id),
            b as (insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
                  select $1, $3, f.id, array['IN'], 'SITE-1', 'LINE-1', 'BS-1', $4, $4 from f returning id),
            a as (insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
                                                            batch_size, batch_size_unit, source, external_reference, allocated_by_person_id,
                                                            allocated_by_account_id, correlation_id)
                  values (gen_random_uuid(), $3, 'SITE-1', 'Asia/Kolkata', 'PARA-500', 'Paracetamol tablets', 'TABLETS', 'PROCESSING', 100, 'kg', 'EXTERNAL', 'fixture', $4, $4, $4) returning id)
       insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
       select b.id, a.id, $3, $4, $4, $4 from b, a`,
      [id, `FAM-${tag()}`, number, who],
    );
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
  return { id, number };
}

beforeAll(async () => {
  await dv.create();
  [linked, solo] = await Promise.all([startSigningServer('GMP', { env: { DEVIATIONS_DATABASE_URL: dv.url } }), startSigningServer('GMP')]);
  [qa, qaSolo] = await Promise.all([linked.asPersona('qaInvestigator'), solo.asPersona('qaInvestigator')]);
}, 300_000);
afterAll(async () => {
  await Promise.all([linked?.close(), solo?.close()]);
  await dv.drop();
});

const raiseBody = { kind: 'DEVIATION' as const, title: 'Granule moisture above the limit at drying end', classification: 'MAJOR' as const, riskRationale: 'Moisture outside the validated range' };

/** A received lot at SITE-1 (set-up; what site.link_deviation reads for a LOT subject). */
async function lot(server: TestServer): Promise<string> {
  const id = randomUUID();
  const who = randomUUID();
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'MCC-101', 'Microcrystalline cellulose', 'EXCIPIENT', 25, 'kg', '2030-01-01T00:00:00Z', $3, $3, $3)`,
      [id, `L${tag()}`, who],
    );
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
  return id;
}

const due = '2030-01-31';
const classify = (owner: string) => ({ classification: 'MINOR' as const, riskRationale: 'Corrected before any material was handled', ownerPersonId: owner, dueDate: due });
const finding = { assignableCause: true, cause: 'Balance calibration overdue at the time of test', rootCauseCategory: 'LABORATORY_ERROR' as const };

describe('with the link, batch deviations are managed in Deviations; lot and laboratory records stay here (DI-17, lead ruling)', () => {
  it('[DI-17][PR-49] a DEVIATION record is not linked to a batch or container, and one linked to a batch is not investigated, its detail not served: 410 "Batch deviations are managed in Deviations; link its number"', async () => {
    expect(Object.keys(BATCH_DEVIATION_ROUTES_WHEN_LINKED).sort()).toEqual([
      'quality.deviationDetail', 'quality.linkDeviation', 'quality.recordDeviationClosureBasis', 'quality.recordDeviationImpact', 'quality.recordFinding', 'quality.startInvestigation',
    ]);
    expect(new Set(Object.values(BATCH_DEVIATION_ROUTES_WHEN_LINKED))).toEqual(new Set(['Deviations']));
    expect(valueOf(await qa.call(routes.meta.get)).deviationsLinked).toBe(true);
    expect(valueOf(await qaSolo.call(routes.meta.get)).deviationsLinked).toBe(false);
    const owner = personaIn(linked, 'qaInvestigator').personId;
    const b = await gmpBatch(linked);

    const d = valueOf(await qa.call(routes.quality.raiseDeviation, { body: raiseBody }));
    const refusedLink = refusalOf(await qa.call(routes.quality.linkDeviation, { params: { deviationId: d.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.id } }));
    expect([refusedLink.status, refusedLink.code, refusedLink.whatHappened]).toEqual([410, 'DISCONNECTED', 'Batch deviations are managed in Deviations; link its number.']);
    expect((await linked.db.admin.query('select count(*)::int as n from site.deviation_link where deviation_id = $1', [d.deviationId])).rows[0]).toEqual({ n: 0 });

    // A record linked to the batch before the link was configured (set-up through the database's own command).
    const actor = await actorOfBrowser(linked, qa, 'qaInvestigator');
    await withCommand(linked.db.app, actor, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [d.deviationId, b.id]));
    const id = { deviationId: d.deviationId };
    for (const r of [
      await qa.call(routes.quality.startInvestigation, { params: id, body: classify(owner) }),
      await qa.call(routes.quality.recordFinding, { params: id, body: finding }),
      await qa.call(routes.quality.deviationDetail, { params: id }),
      await qa.call(routes.quality.recordDeviationImpact, { params: id, body: { linkId: randomUUID(), market: 'IN', impact: 'NONE', rationale: 'Assessed against the batch record' } }),
      await signAction(linked, qa, 'qaInvestigator', { kind: 'QUALITY_ACT', act: 'DEVIATION_CONCLUDE', subjectId: d.deviationId, input: {} }),
    ]) {
      const x = refusalOf(r);
      expect([x.status, x.code, x.whatHappened]).toEqual([410, 'DISCONNECTED', 'Batch deviations are managed in Deviations; link its number.']);
    }
    expect((await linked.db.admin.query("select count(*)::int as n from esig.signature where aggregate_type = 'deviation' and aggregate_id = $1", [d.deviationId])).rows[0]).toEqual({ n: 0 });
  });

  it('[DI-17][IN-20] a lot\'s OOS record, and an OOS record of a batch result, are raised, linked, investigated and their finding recorded as before', async () => {
    const owner = personaIn(linked, 'qaInvestigator').personId;
    const qa1 = await linked.asPersona('qaApprover2');
    const l = await lot(linked);
    const b = await gmpBatch(linked);
    // A DEVIATION of a lot only, an OOS of a lot and an OOS linked to a batch: none is a batch deviation.
    const cases: [string, 'DEVIATION' | 'OOS', 'LOT' | 'BATCH', string][] = [['lot deviation', 'DEVIATION', 'LOT', l], ['lot OOS', 'OOS', 'LOT', l], ['batch OOS', 'OOS', 'BATCH', b.id]];
    for (const [what, kind, subjectKind, subjectId] of cases) {
      const d = valueOf(await qa.call(routes.quality.raiseDeviation, { body: { ...raiseBody, kind, title: `Assay out of specification (${what})` } }));
      const id = { deviationId: d.deviationId };
      valueOf(await qa.call(routes.quality.linkDeviation, { params: id, body: { subjectKind, subjectId } }));
      valueOf(await qa1.call(routes.quality.startInvestigation, { params: id, body: classify(owner) }));
      valueOf(await qa.call(routes.quality.recordFinding, { params: id, body: finding }));
      expect(valueOf(await qa.call(routes.quality.deviationDetail, { params: id })).links.map((k) => k.subjectKind), what).toEqual([subjectKind]);
    }
  });

  it('[DI-17] without the link the batch-only deviation screens\' routes are served for a batch, and the number routes are not', async () => {
    const b = await gmpBatch(solo);
    const d = valueOf(await qaSolo.call(routes.quality.raiseDeviation, { body: raiseBody }));
    valueOf(await qaSolo.call(routes.quality.linkDeviation, { params: { deviationId: d.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.id } }));
    expect(valueOf(await qaSolo.call(routes.quality.deviationDetail, { params: { deviationId: d.deviationId } })).ref).toBe(d.ref);
    for (const r of [await qaSolo.call(routes.quality.deviationNumbers, { params: { batchId: b.id } }), await qaSolo.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: 'DEV-1' } })]) {
      expect([refusalOf(r).status, refusalOf(r).code]).toEqual([410, 'DISCONNECTED']);
    }
    const release = valueOf(await qaSolo.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: b.id } }));
    expect(release.linked).toBeUndefined();
    expect(release.items.map((i) => [i.ref, i.blocking])).toEqual([[d.ref, true]]);
  });
});

describe('a batch\'s deviation is its Deviations number, and its status is Deviations\' (PR-49, IN-05)', () => {
  it('[PR-49][IN-05] linking stores only the number; the review list and the release checklist block while it is open and not once it is closed or rejected; an unknown number is not linked', async () => {
    const b = await gmpBatch(linked);
    const [open, rejected] = [`DEV-${tag()}`, `DEV-${tag()}`];
    await dv.put(open, 'investigation', b.number);
    await dv.put(rejected, 'approval', b.number);

    const unknown = refusalOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: `DEV-${tag()}` } }));
    expect([unknown.status, unknown.code]).toEqual([422, 'EBMR-DV-002']);
    expect(valueOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: open } })).deviations).toMatchObject([
      { number: open, batchId: b.id, batchNumber: b.number, status: 'investigation', classification: 'major', blocking: true },
    ]);
    valueOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: rejected } }));
    const dup = refusalOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: open } }));
    expect(dup.code).toBe('EBMR-DV-003');
    // Only the number is stored: no local deviation record, no copy of Deviations' fields.
    expect((await linked.db.admin.query('select number, batch_number from dv.batch_number_link where batch_id = $1 order by linked_at', [b.id])).rows).toEqual([
      { number: open, batch_number: b.number },
      { number: rejected, batch_number: b.number },
    ]);
    expect((await linked.db.admin.query('select count(*)::int as n from site.deviation_link where batch_id = $1', [b.id])).rows[0]).toEqual({ n: 0 });

    const checklist = async () => valueOf(await qa.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: b.id } }));
    let c = await checklist();
    expect(c.linked?.map((l) => [l.number, l.status, l.blocking])).toEqual([[open, 'investigation', true], [rejected, 'approval', true]]);
    expect(c.problem).toBe(`deviation ${open} linked to batch ${b.number} is investigation in the Deviations product; release waits until it is closed or rejected`);

    await dv.put(open, 'closed');
    await dv.put(rejected, 'rejected');
    c = await checklist();
    expect(c.linked?.map((l) => [l.number, l.status, l.blocking])).toEqual([[open, 'closed', false], [rejected, 'rejected', false]]);
    expect(c.problem).toBeNull();
    expect(valueOf(await qa.call(routes.quality.deviationNumbers, { params: { batchId: b.id } })).deviations.every((d) => !d.blocking)).toBe(true);

    // A reopen in Deviations (closed_at cleared, back to investigation) blocks again at once: nothing is cached.
    await dv.put(open, 'investigation');
    expect((await checklist()).problem).toMatch(/is investigation in the Deviations product/);
  });

  it('[PR-49][PL-08] an unreadable view refuses the checklist, the review list and a new link with DEVIATIONS_OFF; nothing is shown as resolved', async () => {
    const b = await gmpBatch(linked);
    const n = `DEV-${tag()}`;
    await dv.put(n, 'closed', b.number);
    valueOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: n } }));
    await dv.cut();
    try {
      for (const r of [
        await qa.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: b.id } }),
        await qa.call(routes.quality.deviationNumbers, { params: { batchId: b.id } }),
        await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: `DEV-${tag()}` } }),
      ]) {
        const x = refusalOf(r);
        expect([x.status, x.code, x.whatHappened]).toEqual([503, 'DEVIATIONS_OFF', 'Connection to Deviations is off. Release is blocked. Ask your administrator.']);
      }
    } finally {
      await dv.restore();
    }
    expect(valueOf(await qa.call(routes.quality.deviationNumbers, { params: { batchId: b.id } })).deviations).toMatchObject([{ number: n, status: 'closed', blocking: false }]);
  });

  it('[PR-49] an exception or a review disposition may name a number linked to the batch; invalidation and reprocessing name a local OOS or investigation record', async () => {
    const b = await gmpBatch(linked);
    const n = `DEV-${tag()}`;
    await dv.put(n, 'investigation', b.number);
    valueOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: n } }));
    const problem = async (ref: string, use: string, batch = b.id) =>
      (await linked.db.app.query<{ p: string | null }>('select site.deviation_ref_problem($1, $2, $3) as p', [ref, use, batch])).rows[0]?.p ?? null;
    expect(await problem(n, 'LINK')).toBeNull();
    expect(await problem(n, 'DISPOSITION')).toBeNull();
    expect(await problem(n, 'REPROCESSING')).toMatch(/is a Deviations number of a batch deviation; invalidating a result and reprocessing name the OOS or investigation record/);
    expect(await problem(n, 'LINK', (await gmpBatch(linked)).id)).toMatch(/is not a deviation-lite record of this installation/);
    // The link table is insert-only.
    await expect(linked.db.app.query('delete from dv.batch_number_link where number = $1', [n])).rejects.toThrow(/permission denied/);
    await expect(linked.db.admin.query('delete from dv.batch_number_link where number = $1', [n])).rejects.toThrow(/EBMR-IAM-006/);
  });
});
