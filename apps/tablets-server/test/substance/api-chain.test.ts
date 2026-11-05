/**
 * API plan A1a (docs/build-plan/api/handover-a0.md): one API batch through the whole chain, over the routes, by the
 * seed's personas with real signatures. A master pair of the API edition (`substance`) built from library blocks: a
 * processing master (a reaction step from the library, then QA's release for packing H-PACK in a stage of its own, as
 * the designer's blank start writes it) and its packaging master (the library pack block API-PACK: drums, labels, label
 * reconciliation and the examination of the packed containers). QA approves both blocks, the masters are approved and
 * authorised; a batch is planned from an ERP order, issued, run, its output put into a bulk container and released for
 * packing; a packaging order of it takes the bulk, packs it into two drums and the stores post the finished lot; QC tests
 * and samples it, QA reviews both records, and the release gate G-REL is green for India with the API edition's own
 * items (editions/substance/sql 5000); the authorised person releases the lot (release unchanged, EBMR-REL-010).
 *
 * Arranged outside the routes: the plant-free shape of the masters (the room clearance and balance status steps the
 * designer writes need a cleaned, qualified plant; the screen-level acceptance A1b runs them), the ERP order (the ERP's
 * own service, as the ERP import does), and the batch-number rules (the steward's database act).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes, type ContainerView, type SignableAction, type SignatureCredentials } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { library } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { API_PACK } from '../../../../packages/recipe-core/src/library/seed/substance.ts';
import { personaIn, startSigningServer, tapFor, valueOf } from '../esig/support.ts';
import { RunDriver, type ExecServer } from '../execution/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, credentialsOf } from '../support/signed-acts.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `APIA1A-${TAG}`, name: 'Demosubstance A1a', strength: '500 mg' };
const REASON = 'API edition A1a chain';

/** A test reaction block of the API edition (catalogue v1 brings the real ones in A1b). */
const REACT: library.BlockDefinition = {
  code: `API-REACT-T${TAG}`,
  version: 1,
  title: 'Reaction (test block)',
  category: 'PROCESS',
  edition: 'substance',
  sections: [{ id: 'run', title: 'Reaction', fields: [
    { id: 'temp', label: 'Reaction temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'temp', critical: true },
    { id: 'complete', label: 'Reaction complete by the in-process check', type: 'YES_NO', expected: true },
  ] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }],
};
const range = (unit: string, low: string, high: string) => ({ unit, ranges: [{ tier: 'REGISTERED', low: { value: low, inclusive: true }, high: { value: high, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'REF-A1A' } }] });
/** The pack: 60 kg into two 30 kg drums. */
const PACK_USE = { ...API_PACK.exampleUse, limits: { ...API_PACK.exampleUse.limits, netMass: range('kg', '29.950', '30.050') }, targets: { ...API_PACK.exampleUse.targets, netMass: '30.000' }, counts: { containers: '2' } };

const phaseOf = (def: library.BlockDefinition, id: string, use: Json): Json => {
  const p = library.libraryPhase(def, id, 'HIGH') as unknown as Json;
  return { ...p, config: { ...(p['config'] as Json), ...use } };
};
const stage = (like: Json, id: string, name: string, children: Json[]): Json => ({ ...like, id, name, body: { kind: 'sequence', id: `seq-${id}`, children } });

/** dc-mini reshaped as an API master: the header of the API product, the stages given, no tablet calculations. */
function apiMaster(recordKind: 'PROCESSING' | 'PACKAGING', stages: (like: Json) => Json[], defs: library.BlockDefinition[]): flow.MbrContent {
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = `API-${recordKind === 'PROCESSING' ? 'PR' : 'PK'}-${TAG}`;
    header['edition'] = 'substance';
    header['recordKind'] = recordKind;
    header['title'] = `${PRODUCT.name} ${PRODUCT.strength}: ${recordKind === 'PROCESSING' ? 'synthesis' : 'packing into drums'}`;
    header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'API' };
    delete header['unitMassMg'];
    if (recordKind === 'PACKAGING') {
      header['packType'] = 'DRUM-30KG';
      // The packing materials the author adds to the blank packaging master: the drums (a primary pack of the API).
      m['bom'] = [{ id: 'BOM-DRUM', material: 'MAT-DRUM-30', role: 'PRIMARY_PACKAGING', quantity: { value: '2', unit: '1' } }];
      m['references'] = [
        ...(m['references'] as Json[]).filter((r) => r['kind'] !== 'MATERIAL'),
        { id: 'MAT-DRUM-30', kind: 'MATERIAL', code: 'MAT-DRUM-30', version: '1', hash: sha256Hex('MAT-DRUM-30 HDPE drum 30 kg with two liners'), title: 'HDPE drum 30 kg with two PE liners' },
      ];
    }
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    body['children'] = stages(like);
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    m['blockDefinitions'] = defs;
  });
}

const processing = apiMaster('PROCESSING', (like) => [
  stage(like, 'S-REACT', 'Reaction', [phaseOf(REACT, 'p-react', { limits: { temp: range('Cel', '55', '65') } })]),
  // As the designer's blank API start writes it (from-formula.ts): H-PACK in a last stage of its own.
  stage(like, 'S-RELEASE', 'Release for packing', [{ kind: 'holdPoint', id: 'H-PACK', name: 'Batch released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }]),
], [REACT]);
const packaging = apiMaster('PACKAGING', (like) => [stage(like, 'S-PACK', 'Packing', [phaseOf(API_PACK.definition, 'p-pack', PACK_USE)])], [API_PACK.definition]);

let gmp: ExecServer;
let world: World;
let proc: { familyId: string; versionId: string };
let pack: { familyId: string; versionId: string };
let batch: { batchId: string; batchNumber: string };
let order: { batchId: string; batchNumber: string };
let bulkLabel = '';
let lotId = '';

const password = (k: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(gmp, k).loginName, password: personaIn(gmp, k).password });

/** The signing ceremony of any act; a kiosk persona confirms the challenge with a fresh badge tap. */
async function sign(b: TestBrowser, key: string, action: SignableAction, meaning?: string): Promise<void> {
  const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
  const m = meaning ?? d.meaning ?? '';
  const preview = valueOf(await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: m } }));
  const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning: m, clientContentHash: sha256Hex(preview.canonicalText), action };
  vi.advanceTimersByTime(7_000);
  const attribution = b.terminal.includes('KIOSK') ? { attribution: await tapFor(b, personaIn(gmp, key), 'POST', '/api/esig/challenges', body) } : {};
  const challenge = valueOf(await b.call(routes.esig.createChallenge, { body, ...attribution }));
  const signBody = { challengeId: challenge.challengeId, credentials: credentialsOf(gmp, key), action };
  const r = await b.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } });
  if (!r.ok) throw new Error(`${key} ${action.kind} was refused: ${JSON.stringify(r.error.kind === 'REFUSAL' ? r.error.envelope.refusal : r.error)}`);
}

/** The issuer's ISSUED signature on a planned batch (the issue ceremony). */
async function issue(issuer: TestBrowser, batchId: string, why: { code: string; text: string }): Promise<void> {
  const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: batchId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId, reason: why, variants: {}, inputs: {} };
  const challenge = valueOf(await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: batchId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action } }));
  const body = { challengeId: challenge.challengeId, credentials: password('issuer'), action };
  valueOf(await issuer.call(routes.esig.sign, { body: { ...body, proof: await issuer.proof('POST', '/api/esig/sign', body) } }));
}

const driver = async (batchId: string): Promise<RunDriver> => {
  const d = new RunDriver(gmp, batchId, {
    operator1: await gmp.asPersona('operator1'), verifier1: await gmp.asPersona('verifier1'), supervisor1: await gmp.asPersona('supervisor1'), qa1: await gmp.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
};
const libraryEntry = (stepKey: string, entryKind: string, data: Json) => ({ type: 'RECORD_ENTRY', stepKey, entry: { kind: 'LIBRARY_ENTRY', entryKind, data } }) as never;
const status = async (batchId: string): Promise<string | undefined> =>
  (await gmp.db.admin.query<{ s: string }>('select status as s from recipe.execution_state where batch_id = $1', [batchId])).rows[0]?.s;

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-api-chain-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  // The API as a core product (platform fit: dosage form "API"), confirmed by QA; its shelf life dates the lot.
  const steward = await gmp.asPersona('steward');
  valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: 36, changeReason: REASON } }));
  await confirmErpPending(gmp);
  // API plan A3: the site's manufacturing licence endorsing the API (regulatory records it, QA approves it); its holder
  // name and address are the manufacturer's on the CoA.
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/A3/${TAG}`, holderName: 'Demo API Works Pvt Ltd', holderAddress: 'Plot 7, API Park, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: PRODUCT.code, strength: PRODUCT.strength }],
  } }));
  await sign(await gmp.asPersona('approver'), 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  // QA approves the two library blocks (drafted by the author).
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [REACT, API_PACK.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await sign(approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  world = await gmpLifecycleWorld(gmp);
  const stewardActor = await actorOf(gmp, 'steward');
  for (const [content, kind, format] of [[processing, 'PROCESSING', 'A{YY}{SEQ:5}'], [packaging, 'PACKAGING', '{PARENT}/P{SEQ:2}']] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented API)' });
    if (kind === 'PROCESSING') proc = v;
    else pack = v;
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `A1A-${kind.slice(0, 2)}-${TAG}`, site_code: SITE, product_code: PRODUCT.code, batch_kind: kind, format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`API A1a numbering (${kind.toLowerCase()})`),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('API plan A1a: one API batch from library blocks to a released lot, over the routes', () => {
  it('[PR-01][PR-05][PR-37] the API master pair is approved: an API packaging master completes with the library pack block (recipe.packaging_completion_block), a tablets one without TB-24 still does not', async () => {
    const problem = async (edition: string, content: flow.MbrContent) =>
      (await gmp.db.admin.query<{ p: string | null }>('select recipe.packaging_master_problem($1, $2::jsonb) as p', [edition, JSON.stringify(content)])).rows[0]?.p ?? null;
    expect(await problem('substance', packaging)).toBeNull();
    expect(await problem('substance', processing)).toMatch(/has no LIB-API-PACK step/);
    expect(await problem('tablets', packaging)).toMatch(/has no TB-24 step/);
    const { rows } = await gmp.db.admin.query<{ e: string; k: string }>('select edition as e, record_kind as k from recipe.mbr_family where id = any ($1) order by record_kind desc', [[proc.familyId, pack.familyId]]);
    expect(rows).toEqual([{ e: 'substance', k: 'PROCESSING' }, { e: 'substance', k: 'PACKAGING' }]);
    // recipe-core 1873: the block type of a library step is accepted; a malformed one is still refused.
    await expect(gmp.db.admin.query("insert into recipe.packaging_completion_block (edition, block_type) values ('substance', 'LIB-api-pack')")).rejects.toThrow(/packaging_completion_block_block_type_check/);
  });

  it('[INV-27][PR-37][IN-18] the processing batch is planned from its ERP order, issued, run from the master\'s library snapshot, its output closed into a verified bulk container and released for packing by QA (H-PACK)', async () => {
    const issuer = await gmp.asPersona('issuer');
    await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), processing, SIZE);
    const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: proc.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
    await issue(issuer, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
    batch = { batchId: planned.batchId, batchNumber: planned.batchNumber };
    const d = await driver(batch.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-react@' });
    await d.ok('operator1', libraryEntry('p-react@', 'run', { temp: '61.5', complete: true }));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-react@' });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-react@', meaning: 'VERIFIED' });
    // The isolated API into one bulk container: 60 kg typed, verified by a second person.
    const operator = d.browser('operator1');
    const tap = (path: string, body: Json) => { vi.advanceTimersByTime(7_000); return tapFor(operator, personaIn(gmp, 'operator1'), 'POST', path, body); };
    const openBody = { batchId: batch.batchId, stage: 'ISOLATION', unit: 'kg' as const };
    const c: ContainerView = valueOf(await operator.call(routes.containers.open, { body: openBody, attribution: await tap('/api/containers', openBody) }));
    const closeBody = { expectedVersion: c.version, typed: { net: '60.000' } };
    valueOf(await operator.call(routes.containers.close, { params: { containerId: c.containerId }, body: closeBody, attribution: await tap(`/api/containers/${c.containerId}/close`, closeBody) }));
    await sign(d.browser('verifier1'), 'verifier1', { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: c.containerId });
    bulkLabel = c.label;
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-REACT@' });
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Batch released for packing' });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-RELEASE@' });
    expect(await status(batch.batchId)).toBe('EXECUTION_COMPLETE');
    const entry = (await gmp.db.admin.query<{ e: Json }>("select e.value as e from recipe.execution_state s, jsonb_each(s.state -> 'entries') e where s.batch_id = $1 and e.value ->> 'stepKey' = 'p-react@'", [batch.batchId])).rows[0]?.e;
    expect((entry?.['data'] as Json | undefined)?.['temp']).toBe('61.5');
  });

  it('[INV-27][IN-18][PR-37][PR-45] the packaging order takes the released bulk, packs it into two labelled drums with the pack block (each drum a registered container with its net mass) and the stores post the finished lot in quarantine, in kg, for the API edition', async () => {
    const issuer = await gmp.asPersona('issuer');
    const orderNo = await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), packaging, SIZE);
    const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: pack.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE, erpOrder: orderNo, parentBatchId: batch.batchId } }));
    await issue(issuer, planned.batchId, { code: 'PACKING_PLAN', text: `Packaging order of batch ${batch.batchNumber}` });
    order = { batchId: planned.batchId, batchNumber: planned.batchNumber };
    expect(order.batchNumber).toBe(`${batch.batchNumber}/P01`);
    const d = await driver(order.batchId);
    const operator = d.browser('operator1');
    const bulkBody = { labels: [bulkLabel] };
    vi.advanceTimersByTime(7_000);
    valueOf(await operator.call(routes.batches.issueBulk, { params: { batchId: order.batchId }, body: bulkBody, attribution: await tapFor(operator, personaIn(gmp, 'operator1'), 'POST', `/api/batches/${order.batchId}/bulk`, bulkBody) }));
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-pack@' });
    for (const no of ['D-01', 'D-02']) await d.ok('operator1', libraryEntry('p-pack@', 'container', { container: `${order.batchNumber}-${no}`, netMass: '30.000', sealed: true, labelOk: true }));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-pack@' });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-pack@', meaning: 'VERIFIED' });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-PACK@' });
    expect(await status(order.batchId)).toBe('EXECUTION_COMPLETE');
    const stores = await gmp.asPersona('stores');
    const lot = valueOf(await stores.call(routes.specifications.postFinishedLot, { body: { batchId: order.batchId, quantity: '60', unit: 'kg' } }));
    lotId = (lot as unknown as { lotId: string }).lotId;
    const { rows } = await gmp.db.admin.query<{ edition: string; status: string; q: string; unit: string }>(
      'select f.edition, site.lot_state(l.id) as status, trim_scale(l.received_quantity)::text as q, l.unit from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = $1', [lotId]);
    expect(rows).toEqual([{ edition: 'SUBSTANCE', status: 'QUARANTINE', q: '60', unit: 'kg' }]);
  });

  it('[IN-05][INV-05][IN-17][PR-37] QC tests and samples the lot, QA reviews both records; G-REL for India is green with the API edition\'s items (the tablets items that apply to any packaging order), and the authorised person releases the lot', async () => {
    // QC: the API's specification, the lot's results approved by the head of QC, and the reserve samples.
    const [qc, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
    const tests = [{ testCode: 'ASSAY', methodReference: 'STP-A1A-AS-01', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', result: '99.6' }];
    const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
      materialCode: PRODUCT.code, title: 'API specification (invented)', monographReference: 'In-house monograph',
      tests: tests.map((t) => ({ testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, lowerLimit: t.lowerLimit, upperLimit: t.upperLimit, required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '0.1', sampleUnit: 'kg' })),
    } }));
    await sign(head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
    for (const t of tests) {
      const r = valueOf(await qc.call(routes.quality.recordLotResult, { params: { lotId }, body: { testCode: t.testCode, methodReference: t.methodReference, purpose: 'RELEASE', value: t.result, unit: t.unit } }));
      await sign(head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
    }
    valueOf(await qc.call(routes.samples.pull, { params: { lotId }, body: { kind: 'RESERVE', quantity: '0.2', container: 'Reserve sample jar', storageLocation: 'Reserve sample room RS-1' } }));
    // QA: production approval, the register items, the audit-trail review and the QA review of each record.
    for (const b of [batch, order]) {
      const [prod, qa, qa2] = await Promise.all([gmp.asPersona('head1'), gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2')]);
      await sign(prod, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: b.batchId, input: {} });
      const register = valueOf(await qa2.call(routes.review.register, { params: { batchId: b.batchId }, body: {} }));
      for (const item of register.items.filter((i) => i.reviewStatus === 'OPEN')) {
        if (item.critical) valueOf(await qa2.call(routes.review.openItem, { params: { batchId: b.batchId, exceptionId: item.exceptionId }, body: {} }));
        await sign(qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: b.batchId, input: { items: [item.exceptionId], disposition: 'ACCEPT', ...(item.critical ? { justification: 'Reviewed with its disposition: no impact on the batch' } : {}) } });
      }
      const report = valueOf(await qa.call(routes.review.auditTrail, { params: { batchId: b.batchId }, query: {} }));
      await sign(qa, 'qaInvestigator', { kind: 'REVIEW_ACT', act: 'AUDIT_TRAIL_REVIEW', batchId: b.batchId, input: { reviewId: report.reviewId } });
      const view = valueOf(await qa2.call(routes.review.batch, { params: { batchId: b.batchId } }));
      expect(view.gates.qaReview.problems, b.batchNumber).toEqual([]);
      await sign(qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: b.batchId, input: { expectedEpoch: view.epoch } });
    }
    const ap = await gmp.asPersona('qcuAuthoriser');
    const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(view.grel.items.filter((i) => i.status === 'RED').map((i) => `${i.id}: ${i.problem ?? ''}`)).toEqual([]);
    const edition = Object.fromEntries(view.grel.items.filter((i) => i.id.startsWith('E.')).map((i) => [i.id, `${i.group} ${i.status}`]));
    expect(edition).toEqual({
      'E.RECONCILIATION_PRINTED': '4 NA', 'E.RECONCILIATION_YIELD': '4 GREEN', 'E.PACK_EXAMINATION': '9 GREEN',
      'E.HELD_CONTAINERS': '10 GREEN', 'E.CONTAINER_RELEASE': '10 GREEN', 'E.RULE_SETS_VERIFIED': '10 NA', 'E.WHOLE_BATCH_PARENTS': '10 NA',
    });
    expect(view.state).toBe('READY');
    await sign(ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
    expect(valueOf(await ap.call(routes.release.lot, { params: { lotId } }))).toMatchObject({ state: 'RELEASED', lotStatus: 'RELEASED' });
  });
  it('[IN-17][PR-37][INV-05] the API edition\'s items fail closed: a record with no pack step examined no drum (RED), and a lot that is no API finished lot answers one RED item; the hook is registered for the API edition', async () => {
    const exam = (await gmp.db.admin.query<{ r: { status: string; problem: string | null } }>('select substance.grel_pack_examination($1) as r', [batch.batchId])).rows[0]?.r;
    expect(exam?.status).toBe('RED');
    expect(exam?.problem).toMatch(/ran no pack step/);
    const other = (await gmp.db.admin.query<{ r: { id: string; status: string }[] }>('select substance.grel_edition_items($1, $2) as r', [randomUUID(), 'IN'])).rows[0]!.r;
    expect(other.map((i) => [i.id, i.status])).toEqual([['E.EDITION', 'RED']]);
    // The hook is registered for the API edition, beside the tablets one.
    const hooks = (await gmp.db.admin.query<{ edition: string; function_name: string }>('select edition, function_name from recipe.grel_edition_hook order by edition')).rows;
    expect(hooks).toEqual(expect.arrayContaining([{ edition: 'SUBSTANCE', function_name: 'substance.grel_edition_items(uuid,text)' }]));
  });

  // API plan A3 (C3; AS-17 once its control file lands): the CoA of the released lot, from the records only.
  it('[IN-05][DI-35][DI-41] the CoA of the released API lot says the product, grade, lot, release, retest or expiry date, each test with its limits and approved result and the manufacturer from the licence; the authorised person prepares it as a true copy and signs it COA_APPROVED once', async () => {
    const ap = await gmp.asPersona('qcuAuthoriser');
    const view = valueOf(await ap.call(routes.release.coa, { params: { lotId } }));
    expect(view.problems).toEqual([]);
    expect(view.gaps).toEqual([expect.stringMatching(/telephone/)]);
    expect(view.current).toMatchObject({
      kind: 'CERTIFICATE_OF_ANALYSIS',
      manufacturer: { name: 'Demo API Works Pvt Ltd', address: 'Plot 7, API Park, Hyderabad 500078', telephone: null, licenceNumber: `MFG/A3/${TAG}`, siteCode: SITE },
      product: { code: PRODUCT.code, strength: PRODUCT.strength, grade: 'In-house monograph' },
      lot: { lotId, batchNumber: order.batchNumber, quantity: '60', unit: 'kg' },
      tests: [{ testCode: 'ASSAY', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', result: '99.6', purpose: 'RELEASE' }],
    });
    expect(view.current?.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(view.current?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(view.coas).toEqual([]);
    // Preparing needs the lot-release right: QC's analyst is refused and nothing is stored.
    const qc = await gmp.asPersona('qcAnalyst');
    expect((await qc.call(routes.release.prepareCoa, { params: { lotId }, body: {} })).ok).toBe(false);
    const prepared = valueOf(await ap.call(routes.release.prepareCoa, { params: { lotId }, body: {} }));
    expect(prepared.coas).toHaveLength(1);
    const coa = prepared.coas[0]!;
    expect(coa).toMatchObject({ state: 'PREPARED', intact: true, signedBy: null, document: view.current });
    // The same document again is the same CoA.
    expect(valueOf(await ap.call(routes.release.prepareCoa, { params: { lotId }, body: {} })).coas.map((c) => c.coaId)).toEqual([coa.coaId]);
    // QA's dated signature through the ceremony; a second one is refused.
    await sign(ap, 'qcuAuthoriser', { kind: 'COA_ACT', act: 'COA_SIGN', subjectId: coa.coaId });
    const signed = valueOf(await ap.call(routes.release.coa, { params: { lotId } })).coas[0]!;
    expect(signed).toMatchObject({ coaId: coa.coaId, state: 'SIGNED', intact: true, signedBy: { legalName: personaIn(gmp, 'qcuAuthoriser').legalName } });
    expect(signed.signedAt).not.toBeNull();
    await expect(sign(ap, 'qcuAuthoriser', { kind: 'COA_ACT', act: 'COA_SIGN', subjectId: coa.coaId })).rejects.toThrow(/EBMR-COA-004|SIGNED|PREPARED/);
    const sig = (await gmp.db.admin.query<{ m: string; t: string }>('select meaning_code as m, aggregate_type as t from esig.signature where id = $1', [signed.signatureId])).rows[0];
    expect(sig).toEqual({ m: 'COA_APPROVED', t: 'substance_coa' });
    // The true copy never changes: the tables are insert-only, and the application role cannot write them at all.
    await expect(gmp.db.admin.query("update substance.coa set document = document || '{\"x\": 1}'::jsonb where id = $1", [coa.coaId])).rejects.toThrow();
    await expect(gmp.db.app.query('delete from substance.coa_signature where coa_id = $1', [coa.coaId])).rejects.toThrow();
    // The tablets read class lists the CoA as a RECORD-class record (substance 5002).
    expect((await gmp.db.admin.query<{ c: string }>("select tab.aggregate_read_class('substance_coa') as c")).rows[0]?.c).toBe('RECORD');
  });

  it('[IN-05][DI-41] a CoA fails closed: a lot that is no API finished lot has no CoA and none is prepared for it', async () => {
    const other = (await gmp.db.admin.query<{ d: { document: unknown; problems: string[] } }>('select substance.coa_document($1) as d', [randomUUID()])).rows[0]!.d;
    expect(other).toMatchObject({ document: null, problems: [expect.stringMatching(/no finished lot of the API edition/)] });
    const ap = await gmp.asPersona('qcuAuthoriser');
    const r = await ap.call(routes.release.prepareCoa, { params: { lotId: randomUUID() }, body: {} });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'REFUSAL') expect(r.error.envelope.refusal.code).toBe('EBMR-COA-001');
  });
});
