/**
 * Whole-batch reprocessing (Phase 3 slice 5b; outline 5.2.9 case 1; recipe-core 0624 on site-services 0730 to 0733;
 * D-S5-5, D-S5-6; controls PR-47, IN-18, IN-19, INV-33): a batch of a REPROCESSING master is planned only through
 * recipe.prepare_reprocessing_issue, on the quality-control unit's signed authorisation of a request that cites a
 * QA-concluded deviation-lite investigation linked to every parent, a stored risk evaluation, and a product master that
 * permits reprocessing; the authoriser is never the person who plans the batch. Proven as the application role, with
 * its bypass attempts (direct writes, a planned batch of the master without parents).
 *
 * The parent GMP batches are arranged as fixtures by the superuser with triggers off (their issue is slice 2b's); every
 * rule under test runs as the application role.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  concludeDeviation,
  erpReceiveProduct,
  linkDeviation,
  raiseDeviation,
  recordDeviationFinding,
  registerEvidenceDocument,
  startDeviationInvestigation,
} from '../../src/index.ts';
import { createTestDatabase, signerActor, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, unique, type GmpBatch } from './support.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';

let db: TestDatabase;
let w: QualityWorld;
let issuer: SeededActor;
let qcu: SeededActor;
const PRODUCT = `RP${randomUUID().slice(0, 6).toUpperCase()}`;
const STRENGTH = '500 mg';
let family: string;
let processingFamily: string;
let parents: GmpBatch[];
let risk: string;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A GMP parent batch: 5a's planned batch with its allocation, issued (batch record and control recipe) as a fixture. */
async function parent(): Promise<GmpBatch> {
  const b = await w.gmpBatch('SITE-1', PRODUCT, STRENGTH);
  const cr = randomUUID();
  await w.fixture(
    `insert into recipe.control_recipe (id, batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
     values ($1, $2, gen_random_uuid(), gen_random_uuid(), repeat('a', 64), $3::jsonb, repeat('b', 64), gen_random_uuid(), gen_random_uuid())`,
    [cr, b.id, JSON.stringify({ mbr: { content: { header: { product: { code: PRODUCT, strength: STRENGTH } } } } })],
  );
  await w.fixture(
    `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                         market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                         control_recipe_id, issue_signature_id)
     values ($1, $2, repeat('a', 64), 'GMP', 'GMP_BATCH', '1', repeat('c', 64), '{}', repeat('d', 64), '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0,
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $3, gen_random_uuid())`,
    [b.id, b.number, cr],
  );
  return b;
}

/** A deviation-lite investigation linked to `batches`, investigated by qa and concluded by qa2. */
async function investigation(batches: GmpBatch[], conclude = true): Promise<string> {
  const d = await w.run(w.cast.operator, (c) => raiseDeviation(c, { kind: 'INVESTIGATION', title: 'Dissolution failure of the coated tablets', classification: 'MAJOR', riskRationale: 'Release specification failure' }));
  for (const b of batches) await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', b.id));
  if (conclude) {
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId));
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: true, cause: 'Coating too thick', rootCauseCategory: 'PROCESS' }));
    const sig = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'UNDER_INVESTIGATION');
    await w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, sig));
  }
  return d.ref;
}

async function request(fam: string, ps: GmpBatch[], ref: string, doc: string, by: SeededActor = issuer): Promise<string> {
  return (await w.sql<{ id: string }>(by, 'select recipe.propose_reprocessing_request($1, $2, $3::uuid[], $4, $5) as r', [fam, 'SITE-1', ps.map((p) => p.id), ref, doc])).id;
}
async function authorise(id: string, by: SeededActor = qcu): Promise<void> {
  const sig = await w.sign(by, { type: 'reprocessing_request', id }, 'REPROCESSING_AUTHORISED', 'PROPOSED');
  await w.sql(by, 'select recipe.authorise_reprocessing_request($1, $2) as r', [id, sig]);
}
const plan = (req: string, by: SeededActor = issuer): Promise<string> =>
  refusal(w.sql(by, 'select recipe.prepare_reprocessing_issue($1, $2::jsonb) as r', [randomUUID(), JSON.stringify({ familyId: family, markets: ['IN'], site: 'SITE-1', line: 'LINE-1', batchSize: 'BS-1', reprocessingRequest: req })]));

async function familyOf(kind: 'PROCESSING' | 'REPROCESSING'): Promise<string> {
  const id = randomUUID();
  await w.fixture(
    `insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
     values ($1, $2, 'Reprocessing master', 'tablets', $3, $4, 'Paracetamol tablets', $5, 'Coated tablet', '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', gen_random_uuid(), gen_random_uuid())`,
    [id, unique('FAM-'), kind, PRODUCT, STRENGTH],
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  issuer = await signerActor(db, 'BATCH_ISSUER');
  qcu = await signerActor(db, 'AUTHORISED_PERSON');
  family = await familyOf('REPROCESSING');
  processingFamily = await familyOf('PROCESSING');
  parents = [await parent(), await parent()];
  risk = await w.run(w.cast.qa, (c) => registerEvidenceDocument(c, { sha256: sha(`risk ${PRODUCT}`), mediaType: 'application/pdf', sizeBytes: '20480', storageKey: `evidence/${unique('D')}.pdf`, title: 'Risk evaluation of the reprocessing' }));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

describe('whole-batch reprocessing (recipe-core 0624)', () => {
  it('[INV-33][IN-18][IN-19][PR-47] a reworked batch is planned only on a QCU-authorised request: refused without the authorisation, a concluded investigation, a stored risk evaluation, the product\'s permission, or when authorised by the issuer; a request is used once', async () => {
    const ref = await investigation(parents);
    // Only a REPROCESSING master is reprocessed on.
    expect(await refusal(request(processingFamily, parents, ref, risk))).toMatch(/EBMR-RPR-050/);
    const req = await request(family, parents, ref, risk);
    // Not authorised yet.
    expect(await plan(req)).toMatch(/not authorised the reprocessing.*\[EBMR-RPR-052\]/);
    // A QA reviewer holds no REPROCESSING.AUTHORISE: the signature is refused.
    expect(await refusal(authorise(req, w.cast.qa))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    await authorise(req);
    expect(await refusal(authorise(req))).toMatch(/EBMR-(ESIG-042|RPR-051)/);
    // The product master: unknown, then received without the permission (D-S5-5 default false), then permitting.
    expect(await plan(req)).toMatch(/does not permit reprocessing.*\[EBMR-RPR-052\]/);
    const product = { productCode: PRODUCT, strength: STRENGTH, productName: 'Paracetamol tablets', betaLactam: false, shelfLifeMonths: 24, erpReference: unique('ERP-') };
    await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product));
    expect(await plan(req)).toMatch(/does not permit reprocessing.*\[EBMR-RPR-052\]/);
    await w.run(w.cast.erp, (c) => erpReceiveProduct(c, { ...product, reprocessingPermitted: true, erpReference: unique('ERP-') }));
    // Every check of the request passes: the plan reaches 5a's GMP issue (this fixture master has no effective version).
    expect(await plan(req)).toMatch(/EBMR-EXE-192/);
    // An investigation not concluded, or not linked to every parent.
    const open = await request(family, parents, await investigation(parents, false), risk);
    await authorise(open);
    expect(await plan(open)).toMatch(/does not stand for parent.*\[EBMR-RPR-052\]/);
    const partial = await request(family, parents, await investigation([parents[0] as GmpBatch]), risk);
    await authorise(partial);
    expect(await plan(partial)).toMatch(/not linked to batch.*\[EBMR-RPR-052\]/);
    // A risk evaluation that is no stored document.
    const noDoc = await request(family, parents, ref, randomUUID());
    await authorise(noDoc);
    expect(await plan(noDoc)).toMatch(/risk evaluation .*not a stored evidence document.*\[EBMR-RPR-052\]/);
    // Authorised by the person who plans the batch (an authorised person who also issues, arranged for this test).
    await w.fixture("insert into iam.role_permission (role_code, permission_code) values ('AUTHORISED_PERSON', 'BATCH.ISSUE') on conflict do nothing", []);
    const self = await request(family, parents, ref, risk, qcu);
    await authorise(self);
    expect(await plan(self, qcu)).toMatch(/authorised by the person who plans the batch.*\[EBMR-RPR-052\]/);
    await w.fixture("delete from iam.role_permission where role_code = 'AUTHORISED_PERSON' and permission_code = 'BATCH.ISSUE'", []);
  });

  it('[INV-33][IN-18] a planned batch of a reprocessing master without its parents is refused at commit; the registers are written only through their commands', async () => {
    // The superuser in a command of its own, past every command: the deferred check refuses the batch at commit.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object('person_id', gen_random_uuid(), 'account_id', gen_random_uuid(), 'role_code', 'BATCH_ISSUER',
                       'session_id', gen_random_uuid(), 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Bypass attempt',
                       'reason_code', 'TEST', 'reason_text', 'a reprocessing batch without parents'))`);
      await c.query(
        `insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
         values (gen_random_uuid(), $1, $2, '{IN}', 'SITE-1', 'LINE-1', 'BS-1', gen_random_uuid(), gen_random_uuid())`,
        [unique('RB'), family],
      );
      await expect(c.query('commit')).rejects.toThrow(/EBMR-RPR-053/);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    const p = parents[0] as GmpBatch;
    await expect(db.app.query("insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id) values ($1, $1, 'X', '{}', gen_random_uuid())", [p.id])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into recipe.reprocessing_request (family_id, site_code, parent_batch_ids, investigation_ref, risk_evaluation_id, proposed_by_person, proposed_by_account, correlation_id) values ($1, 'SITE-1', array[$2::uuid], 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [family, p.id])).rejects.toThrow(/permission denied/);
    await expect(db.app.query('insert into recipe.reprocessing_request_signature (request_id, signature_id, signer_person, recorded_by_account) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())')).rejects.toThrow(/permission denied/);
    // A whole-batch child is reprocessed material: its basis and chained-recovery flag are the database's.
    expect((await db.app.query<{ b: string | null }>('select recipe.batch_reprocessing_basis($1) as b', [p.id])).rows[0]?.b).toBeNull();
  });

  it('[PR-47][IN-19] G-24@1 SOURCE_ADDITION is refused on GMP: its facts are the caller\'s (D-S5-8); a batch of another installation is left to the sandbox rules', async () => {
    const node = { kind: 'phase', id: 'add', block: { type: 'G-24', version: '1' }, reprocessing: { case: 'RECOVERY' } };
    const content = { procedure: { kind: 'sequence', id: 'ops', children: [node] } };
    const state = (entries: object) => ({ entries, steps: { 'add@': { step: 'add' } } });
    const after = state({ 'EN-1': { id: 'EN-1', kind: 'SOURCE_ADDITION', stepKey: 'add@' } });
    const problem = async (batch: string, c: object = content) =>
      (await db.admin.query<{ p: string | null }>('select recipe.g24_v1_gmp_problem($1, $2, $3, $4) as p', [batch, c, state({}), after])).rows[0]?.p ?? null;
    const gmp = parents[0] as GmpBatch;
    expect(await problem(gmp.id)).toMatch(/adds material at G-24@1 step add@, whose source facts are the caller's/);
    expect(await problem(gmp.id, { procedure: { kind: 'sequence', id: 'ops', children: [{ ...node, block: { type: 'G-24', version: '2' } }] } })).toBeNull();
    expect(await problem(randomUUID())).toBeNull();
    // The application role cannot call the check or bypass its trigger (it writes no execution row directly).
    await expect(db.app.query('select recipe.g24_v1_gmp_problem($1, $2, $3, $4)', [gmp.id, content, state({}), after])).rejects.toThrow(/permission denied/);
  });
});

