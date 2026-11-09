/**
 * MEDHANTA slice 2 (owner ruling, 9 November 2026; replaces declutter residual D4-R5): deviations through the Deviations
 * product. With a Deviations link (EBMR_DEVIATIONS_URL; a stand-in Deviations database, test/support/fake-deviations.ts)
 * a batch's deviation is linked by its Deviations number only, the release checklist and the review read each number's
 * status from report.deviation_v1, and Batchwright's own deviation management answers 410 DISCONNECTED (owner
 * 'Deviations'). Without the link nothing changes: the batch-only deviation screens of G2 stay connected.
 *
 * Controls: PR-49 (a deviation linked to the batch blocks its release until resolved; 21 CFR 211.192), IN-05 (release
 * decided on resolved deviations), DI-17 (only the functions this installation offers are served), platform rule PL-08
 * (a linked read through a versioned view; connection off refuses, never serves a stale or assumed answer).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVIATION_ACTS_WHEN_LINKED, DISCONNECTED_WHEN_LINKED, routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
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
  [linked, solo] = await Promise.all([startSigningServer('GMP', { env: { EBMR_DEVIATIONS_URL: dv.url } }), startSigningServer('GMP')]);
  [qa, qaSolo] = await Promise.all([linked.asPersona('qaInvestigator'), solo.asPersona('qaInvestigator')]);
}, 300_000);
afterAll(async () => {
  await Promise.all([linked?.close(), solo?.close()]);
  await dv.drop();
});

const raiseBody = { kind: 'DEVIATION' as const, title: 'Granule moisture above the limit at drying end', classification: 'MAJOR' as const, riskRationale: 'Moisture outside the validated range' };

describe('deviation management belongs to Deviations where the link is configured (DI-17)', () => {
  it('[DI-17] with the link, raising, linking, investigating, the finding, the detail, the impact and the closure basis answer 410 DISCONNECTED (Deviations); without it they are served and the number routes are not', async () => {
    expect(Object.keys(DISCONNECTED_WHEN_LINKED).sort()).toEqual([
      'quality.deviationDetail', 'quality.linkDeviation', 'quality.raiseDeviation', 'quality.recordDeviationClosureBasis', 'quality.recordDeviationImpact', 'quality.recordFinding', 'quality.startInvestigation',
    ]);
    expect(new Set(Object.values(DISCONNECTED_WHEN_LINKED))).toEqual(new Set(['Deviations']));
    expect(valueOf(await qa.call(routes.meta.get)).deviationsLinked).toBe(true);
    expect(valueOf(await qaSolo.call(routes.meta.get)).deviationsLinked).toBe(false);

    const id = { deviationId: randomUUID() };
    const off = [
      await qa.call(routes.quality.raiseDeviation, { body: raiseBody }),
      await qa.call(routes.quality.linkDeviation, { params: id, body: { subjectKind: 'BATCH', subjectId: randomUUID() } }),
      await qa.call(routes.quality.startInvestigation, { params: id, body: { classification: 'MINOR', riskRationale: 'Corrected before any material was handled', ownerPersonId: randomUUID(), dueDate: '2030-01-31' } }),
      await qa.call(routes.quality.recordFinding, { params: id, body: { assignableCause: true, cause: 'Booth readiness checked late', rootCauseCategory: 'METHOD' } }),
      await qa.call(routes.quality.deviationDetail, { params: id }),
    ];
    for (const r of off) expect([refusalOf(r).status, refusalOf(r).code]).toEqual([410, 'DISCONNECTED']);

    // Standalone: the batch-only deviation screens' routes are served, and the number routes are not.
    const raised = valueOf(await qaSolo.call(routes.quality.raiseDeviation, { body: raiseBody }));
    expect(valueOf(await qaSolo.call(routes.quality.deviationDetail, { params: { deviationId: raised.deviationId } })).ref).toBe(raised.ref);
    const b = await gmpBatch(solo);
    for (const r of [await qaSolo.call(routes.quality.deviationNumbers, { params: { batchId: b.id } }), await qaSolo.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: 'DEV-1' } })]) {
      expect([refusalOf(r).status, refusalOf(r).code]).toEqual([410, 'DISCONNECTED']);
    }
    const release = valueOf(await qaSolo.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: b.id } }));
    expect(release).toEqual({ items: [], problem: null });
  });

  it('[DI-17] with the link, the impact sign-off, the conclusion and the closure of a local record are not signed (410 DISCONNECTED)', async () => {
    expect([...DEVIATION_ACTS_WHEN_LINKED].sort()).toEqual(['DEVIATION_CLOSE', 'DEVIATION_CONCLUDE', 'DEVIATION_IMPACT_ASSESS']);
    // A record made before the link (the command, as the database takes it), so the act has a record to sign.
    const actor = await actorOfBrowser(linked, qa, 'qaInvestigator');
    const deviationId = await withCommand(linked.db.app, actor, async (c) =>
      (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [JSON.stringify(raiseBody)])).rows[0]?.r.deviationId ?? '');
    for (const act of DEVIATION_ACTS_WHEN_LINKED) {
      const r = refusalOf(await signAction(linked, qa, 'qaInvestigator', { kind: 'QUALITY_ACT', act: act as 'DEVIATION_CLOSE', subjectId: deviationId, input: {} }));
      expect([r.status, r.code]).toEqual([410, 'DISCONNECTED']);
    }
    expect((await linked.db.admin.query("select count(*)::int as n from esig.signature where aggregate_type = 'deviation' and aggregate_id = $1", [deviationId])).rows[0]).toEqual({ n: 0 });
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

  it('[PR-49] an exception or a review disposition may name a number linked to the batch; invalidation and reprocessing still need a record concluded here (DV-R1)', async () => {
    const b = await gmpBatch(linked);
    const n = `DEV-${tag()}`;
    await dv.put(n, 'investigation', b.number);
    valueOf(await qa.call(routes.quality.linkDeviationNumber, { params: { batchId: b.id }, body: { number: n } }));
    const problem = async (ref: string, use: string, batch = b.id) =>
      (await linked.db.app.query<{ p: string | null }>('select site.deviation_ref_problem($1, $2, $3) as p', [ref, use, batch])).rows[0]?.p ?? null;
    expect(await problem(n, 'LINK')).toBeNull();
    expect(await problem(n, 'DISPOSITION')).toBeNull();
    expect(await problem(n, 'REPROCESSING')).toMatch(/is a Deviations number; .* \(DV-R1\)/);
    expect(await problem(n, 'LINK', (await gmpBatch(linked)).id)).toMatch(/is not a deviation-lite record of this installation/);
    // The link table is insert-only.
    await expect(linked.db.app.query('delete from dv.batch_number_link where number = $1', [n])).rejects.toThrow(/permission denied/);
    await expect(linked.db.admin.query('delete from dv.batch_number_link where number = $1', [n])).rejects.toThrow(/EBMR-IAM-006/);
  });
});
