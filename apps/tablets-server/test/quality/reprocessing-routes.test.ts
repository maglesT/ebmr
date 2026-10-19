/**
 * Reprocessing proposals and the reprocessing plan over HTTP (Phase 7 slice 7g, WP4; decision 0025; recipe-core 0621,
 * 0624; PR-47, IN-19): the planner asks for a whole-batch reprocessing on a REPROCESSING master, the quality unit's
 * representative asks for the authorisation of a reprocessing or recovery step, and a reprocessing batch is planned only
 * with the quality unit's authorised request. Every rule and right is the database's; these tests prove the routes
 * reach them.
 *
 * TEST FIXTURE (arranged as the superuser with triggers off, never used to prove a control): the REPROCESSING master
 * family, as packages/site-services/test/quality/reprocessing.test.ts arranges it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { refusalOf, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { BATCH_SIZE, LINE, SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

const Q = routes.quality;
let w: GmpBatchWorld;
let issuer: TestBrowser;
let stores: TestBrowser;
let qcu: TestBrowser;
let parent: string;
let family: string;

/** The database's refusal as the server answers it: its code, then why. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''}`;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  [issuer, stores, qcu] = await Promise.all([w.gmp.asPersona('issuer'), w.gmp.asPersona('stores'), w.gmp.asPersona('qcuAuthoriser')]);
  parent = await w.issued(issuer);
  family = randomUUID();
  const c = await w.gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const product = w.content.header.product;
    await c.query(
      `insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
       values ($1, $2, 'Reprocessing master', 'tablets', 'REPROCESSING', $3, $4, $5, 'Tablet', $6::jsonb, gen_random_uuid(), gen_random_uuid())`,
      [family, `FAM-RPR-${randomUUID().slice(0, 6).toUpperCase()}`, product.code, product.name, product.strength, JSON.stringify([{ id: BATCH_SIZE, quantity: { value: '100', unit: 'kg' } }])],
    );
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('whole-batch reprocessing (PR-47)', () => {
  it('[PR-47][IN-19] the planner asks for a whole-batch reprocessing on a REPROCESSING master; it is listed not authorised; a reprocessing batch is not planned on it until the quality unit authorises it; a person without the right and a PROCESSING master are refused', async () => {
    const body = { familyId: family, site: SITE, parentBatchIds: [parent], investigationRef: 'DEV-2026-0007', riskEvaluationId: randomUUID() };
    expect(refusalOf(await stores.call(Q.proposeReprocessingRequest, { body }))?.code).toBe('EBMR-IAM-040');
    expect(refused(await issuer.call(Q.proposeReprocessingRequest, { body: { ...body, familyId: w.familyId } }))).toMatch(/EBMR-RPR-050/);
    const { requestId } = valueOf(await issuer.call(Q.proposeReprocessingRequest, { body }));
    expect(valueOf(await issuer.call(Q.reprocessingRequests)).requests.find((r) => r.requestId === requestId)).toMatchObject({ familyId: family, investigationRef: 'DEV-2026-0007', parents: [{ batchId: parent }], authorisedBy: null });
    // Starting the reprocessing without the quality unit's authorisation is blocked: the plan is refused, nothing is planned.
    const plan = { familyId: family, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE, reprocessingRequest: requestId };
    expect(refused(await issuer.call(routes.execution.planBatch, { body: plan }))).toMatch(/not authorised the reprocessing.*EBMR-RPR-052|EBMR-RPR-052.*not authorised the reprocessing/s);
    // Nor without a request at all: the master is planned only through its request.
    const { reprocessingRequest: _r, ...withoutRequest } = plan;
    void _r;
    expect((await issuer.call(routes.execution.planBatch, { body: withoutRequest })).ok).toBe(false);
  }, 180_000);

  it('[IN-19] the quality unit asks for the authorisation of a step only on a reprocessing or recovery step of the batch\'s MBR; a person without REPROCESSING.AUTHORISE is refused', async () => {
    const body = { batchId: parent, step: 'p-weigh', investigationRef: 'DEV-2026-0007', riskEvaluationRef: 'RA-2026-031' };
    expect(refusalOf(await issuer.call(Q.proposeReprocessingAuthorisation, { body }))?.code).toBe('EBMR-IAM-040');
    expect(refused(await qcu.call(Q.proposeReprocessingAuthorisation, { body }))).toMatch(/EBMR-RPR-020/);
    expect(refused(await qcu.call(Q.proposeReprocessingAuthorisation, { body: { ...body, batchId: randomUUID() } }))).toMatch(/EBMR-RPR-020/);
    expect(valueOf(await qcu.call(Q.reprocessingAuthorisations, { query: { batchId: parent } })).authorisations).toEqual([]);
  }, 120_000);
});
