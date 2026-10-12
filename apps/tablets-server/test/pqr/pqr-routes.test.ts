/**
 * The PQR routes and sign-off over HTTP (Phase 4 slice 6c; contract ns/pqr.ts; recipe-core 0910, tablets 1200; IN-01,
 * PR-58): QA runs the extract of a product and period, the extract and the list show it with its hash, reconciliation
 * and whether it reproduces; the AP signs it off through the ceremony (PQR_SIGN_OFF on pqr_extract, the slice 6 meaning
 * mapping); QA cannot; a register that diverges from the records fails the run with the database's refusal. The batch is a
 * real GMP batch, issued (the engine paths are proven elsewhere).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { refusalOf, valueOf } from '../esig/support.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { describeAction, signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let qa: TestBrowser;
let ap: TestBrowser;
let batchId: string;
let product: string;
let from: string;
let to: string;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  [qa, ap] = await Promise.all([w.gmp.asPersona('qaInvestigator'), w.gmp.asPersona('qcuAuthoriser')]);
  batchId = await w.issued(issuer);
  product = w.content.header.product.code;
  const { rows } = await w.gmp.db.admin.query<{ f: string; t: string }>('select (current_date - 3)::text as f, (current_date + 3)::text as t');
  from = rows[0]!.f;
  to = rows[0]!.t;
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.why.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? refusalOf(r)?.code ?? 'refused'));

describe('PQR routes over HTTP (IN-01, PR-58)', () => {
  it('[IN-01][PR-58] QA runs the extract; it lists the issued batch, reconciles, reproduces and re-runs to the same hash; the AP signs it off through the ceremony, QA cannot', async () => {
    const body = { productCode: product, periodFrom: from, periodTo: to };
    const x = valueOf(await qa.call(routes.pqr.run, { body }));
    expect(x).toMatchObject({ productCode: product, periodFrom: from, periodTo: to, queryVersion: 1, reproduces: true, queryProblem: null, signOff: null,
                              reconciliation: { ok: true, problems: [], batches: { extract: 1, register: 1 } }, ranBy: { legalName: 'Divya Menon', role: 'QA_REVIEWER' } });
    expect(x.batches.map((b) => b.batchId)).toEqual([batchId]);
    expect(x.counts).toMatchObject({ batches: 1, deviations: 0 });
    const again = valueOf(await qa.call(routes.pqr.run, { body }));
    expect(again.resultSha256).toBe(x.resultSha256);
    expect(again.extractId).not.toBe(x.extractId);
    expect(valueOf(await qa.call(routes.pqr.extracts, { query: { productCode: product } })).extracts.map((e) => e.extractId)).toEqual([again.extractId, x.extractId]);
    expect(refusalOf(await qa.call(routes.pqr.extract, { params: { extractId: randomUUID() } })).status).toBe(404);

    const act: SignableAction = { kind: 'PQR_SIGN_OFF', extractId: x.extractId };
    expect(await describeAction(ap, act)).toMatchObject({ aggregateType: 'pqr_extract', aggregateId: x.extractId, meaning: 'PQR_SIGNED_OFF', expectedState: 'EXTRACTED' });
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', act))).not.toBe('ok');
    expect(codeOf(await signAction(w.gmp, ap, 'qcuAuthoriser', act))).toBe('ok');
    const signed = valueOf(await qa.call(routes.pqr.extract, { params: { extractId: x.extractId } }));
    expect(signed.signOff).toMatchObject({ signedBy: { legalName: 'Shalini Kapoor', role: 'AUTHORISED_PERSON' } });
    // Signed once: a second sign-off signs nothing.
    expect(codeOf(await signAction(w.gmp, ap, 'qcuAuthoriser', act))).not.toBe('ok');
  });

  it('[IN-01][PR-58] a deviation register that diverges from the records fails the run (422, EBMR-PQR-006); the earlier extract still reproduces (the records did not change)', async () => {
    const body = { productCode: product, periodFrom: from, periodTo: to };
    const before = valueOf(await qa.call(routes.pqr.run, { body }));
    const n = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId])).rows[0]!.n;
    // TEST FIXTURE: a link names the batch's number with another batch id (written as the owner, triggers off).
    const c = await w.gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      const d = randomUUID();
      await c.query("insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id) values ($1, 'DEV-SITE-1-2026-99999', 'SITE-1', 2026, 99999, 'DEVIATION', 'Diverging link', 'MINOR', 'Test fixture rationale', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [d]);
      await c.query("insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account) values ($1, 'CONTAINER', gen_random_uuid(), 'C-1', gen_random_uuid(), $2, 'TABLETS', gen_random_uuid(), gen_random_uuid())", [d, n]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const refused = refusalOf(await qa.call(routes.pqr.run, { body }));
    expect(refused.status).toBe(422);
    expect(`${refused.code} ${refused.why}`).toMatch(/EBMR-PQR-006/);
    expect(valueOf(await qa.call(routes.pqr.extract, { params: { extractId: before.extractId } })).reproduces).toBe(true);
  });
});
