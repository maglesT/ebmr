/**
 * API plan A2, change C1 (site-services 1732, substance 5001): a processing batch of the API edition posts its output as
 * an INTERMEDIATE lot in quarantine; QA releases it for further processing through the material-lot release
 * (RELEASE_FOR_FURTHER_PROCESSING over the proposal, MATERIAL_LOT_STATUS_DECIDED); the next step's batch reserves and
 * reserves it as any lot (site.reserve_lot).
 *
 * Step A makes intermediate A; QA releases it; step B reserves it and posts intermediate B. A quarantined intermediate is
 * refused at the reservation. Not yet here (next round): the consumption through the G-07 weighing (a qualified balance
 * and plant), the lot_consumption chain over three steps, and the final API batch C to a released API lot.
 *
 * Arranged outside the routes, as in api-chain.test.ts: the plant-free masters, the ERP orders and the numbering rules.
 * A bare recipe.consume_lot in the dispenser's command is refused: on GMP a consumption is the record's own entry.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { withCommand } from '@ebmr/kernel';
import { routes, type SignableAction, type SignatureCredentials } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { library } from '@ebmr/recipe-core/pure';
import { openServiceSession, terminalOf } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { actorOfBrowser, personaIn, refusalOf, startSigningServer, tapFor, valueOf } from '../esig/support.ts';
import { RunDriver, type ExecServer } from '../execution/support.ts';
import { intermediatePostOffered } from '../../src/features/execution/views.ts';
import type { TestBrowser } from '../support/harness.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, credentialsOf } from '../support/signed-acts.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const INT_A = { code: `INTA-${TAG}`, name: 'Demo intermediate A', strength: 'Step 1' };
const INT_B = { code: `INTB-${TAG}`, name: 'Demo intermediate B', strength: 'Step 2' };
const REASON = 'API edition A2 intermediates';

/** A test reaction block of the API edition (as api-chain.test.ts). */
const REACT: library.BlockDefinition = {
  code: `API-REACT-I${TAG}`,
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
const range = (unit: string, low: string, high: string) => ({ unit, ranges: [{ tier: 'REGISTERED', low: { value: low, inclusive: true }, high: { value: high, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'REF-A2' } }] });
const phaseOf = (def: library.BlockDefinition, id: string, use: Json): Json => {
  const p = library.libraryPhase(def, id, 'HIGH') as unknown as Json;
  return { ...p, config: { ...(p['config'] as Json), ...use } };
};

/** One synthesis step of product `p` (an intermediate), from `input` when given (its BOM line). */
function stepMaster(p: { code: string; name: string; strength: string }, input?: { code: string; name: string }): flow.MbrContent {
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = `API-${p.code}`;
    header['edition'] = 'substance';
    header['recordKind'] = 'PROCESSING';
    header['title'] = `${p.name}: synthesis step`;
    header['product'] = { code: p.code, name: p.name, strength: p.strength, dosageForm: 'API' };
    delete header['unitMassMg'];
    m['bom'] = input ? [{ id: 'BOM-IN', material: input.code, role: 'ACTIVE', quantity: { value: '50', unit: 'kg' } }] : [];
    m['references'] = [
      ...(m['references'] as Json[]).filter((r) => r['kind'] !== 'MATERIAL'),
      ...(input ? [{ id: input.code, kind: 'MATERIAL', code: input.code, version: '1', hash: sha256Hex(`${input.code} ${input.name}`), title: input.name }] : []),
    ];
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    body['children'] = [{ ...like, id: 'S-REACT', name: 'Reaction', body: { kind: 'sequence', id: 'seq-S-REACT', children: [phaseOf(REACT, 'p-react', { limits: { temp: range('Cel', '55', '65') } })] } }];
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    m['blockDefinitions'] = [REACT];
  });
}

const masterA = stepMaster(INT_A, { code: `KSM-${TAG}`, name: 'Key starting material (invented)' });
const masterB = stepMaster(INT_B, INT_A);

let gmp: ExecServer;
let world: World;
const fam: Record<'A' | 'B', string> = { A: '', B: '' };
const batch: Record<'A' | 'B', { batchId: string; batchNumber: string }> = { A: { batchId: '', batchNumber: '' }, B: { batchId: '', batchNumber: '' } };
let lotA = '';

const password = (k: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(gmp, k).loginName, password: personaIn(gmp, k).password });

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

async function plannedAndIssued(step: 'A' | 'B', content: flow.MbrContent): Promise<{ batchId: string; batchNumber: string }> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, SIZE);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: fam[step], markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: planned.batchId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: planned.batchId, reason: { code: 'PRODUCTION_PLAN', text: `Step ${step}` }, variants: {}, inputs: {} };
  const challenge = valueOf(await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: planned.batchId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action } }));
  const body = { challengeId: challenge.challengeId, credentials: password('issuer'), action };
  valueOf(await issuer.call(routes.esig.sign, { body: { ...body, proof: await issuer.proof('POST', '/api/esig/sign', body) } }));
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The reaction step run, verified and its stage signed off: the batch's execution is complete. */
async function runToComplete(batchId: string): Promise<void> {
  const d = new RunDriver(gmp, batchId, { operator1: await gmp.asPersona('operator1'), verifier1: await gmp.asPersona('verifier1'), supervisor1: await gmp.asPersona('supervisor1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-react@' });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-react@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'run', data: { temp: '60.0', complete: true } } } as never);
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-react@' });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-react@', meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-REACT@' });
  expect((await gmp.db.admin.query<{ s: string }>('select status as s from recipe.execution_state where batch_id = $1', [batchId])).rows[0]?.s).toBe('EXECUTION_COMPLETE');
}

/** recipe.consume_lot in the dispenser's command, outside any batch-record entry. */
async function consume(batchId: string, materialCode: string, quantity: string): Promise<Json> {
  const dispenser = await gmp.asPersona('dispenser1');
  const reservation = (await gmp.db.admin.query<{ id: string }>('select r.id from site.lot_reservation r where r.lot_id = $1 and r.batch_id = $2 order by r.reserved_at desc limit 1', [lotA, batchId])).rows[0]?.id ?? randomUUID();
  return withCommand(gmp.db.app, { ...(await actorOfBrowser(gmp, dispenser, 'dispenser1')), correlationId: randomUUID() }, async (c) =>
    (await c.query<{ r: Json }>("select recipe.consume_lot($1, $2, $3, $4::numeric, 'kg') as r", [batchId, reservation, materialCode, quantity])).rows[0]!.r);
}

const lotState = async (lotId: string): Promise<string | undefined> => (await gmp.db.admin.query<{ s: string }>("select site.lot_state($1) as s", [lotId])).rows[0]?.s;

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-api-a2-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of [INT_A, INT_B]) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: 12, changeReason: REASON } }));
  }
  await confirmErpPending(gmp);
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: REACT as unknown as Json } }));
  await sign(approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  world = await gmpLifecycleWorld(gmp);
  const stewardActor = await actorOf(gmp, 'steward');
  for (const [step, content, p] of [['A', masterA, INT_A], ['B', masterB, INT_B]] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented API)' });
    fam[step] = v.familyId;
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `A2-${step}-${TAG}`, site_code: SITE, product_code: p.code, batch_kind: 'PROCESSING', format: `${step}{YY}{SEQ:5}`, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`API A2 numbering (step ${step})`),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('API plan A2: intermediate lots between synthesis steps (C1)', () => {
  it('[IN-05][PR-45][INV-27] step A runs to completion and the stores post its output as an INTERMEDIATE lot in quarantine, dated from the product master\'s shelf life; a second and a third post of the same batch are lots <batch>-2 and <batch>-3; an incomplete batch and a non-stores person are refused', async () => {
    batch.A = await plannedAndIssued('A', masterA);
    const stores = await gmp.asPersona('stores');
    const post = { batchId: batch.A.batchId, quantity: '50', unit: 'kg' };
    expect(refusalOf(await stores.call(routes.specifications.postIntermediateLot, { body: post }))?.why).toMatch(/EBMR-SITE-994|execution is complete/);
    await runToComplete(batch.A.batchId);
    expect(refusalOf(await (await gmp.asPersona('qcAnalyst')).call(routes.specifications.postIntermediateLot, { body: post })).code).toMatch(/^EBMR-IAM/);
    const lot = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: post }));
    lotA = lot.lotId;
    expect(lot).toMatchObject({ lotCode: batch.A.batchNumber, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '50', unit: 'kg' });
    const { rows } = await gmp.db.admin.query<{ kind: string; edition: string; exp: string; want: string }>(
      `select l.material_kind as kind, i.edition, (l.expires_at at time zone 'Asia/Kolkata')::date::text as exp, recipe.batch_expiry($2) ->> 'expiryDate' as want
         from site.intermediate_lot i join site.material_lot l on l.id = i.lot_id where i.lot_id = $1`, [lotA, batch.A.batchId]);
    expect(rows).toEqual([{ kind: 'INTERMEDIATE', edition: 'SUBSTANCE', exp: rows[0]?.want, want: rows[0]?.want }]);
    // More than one intermediate lot per batch (second crops, split isolations; site-services 1734): numbered in posting order.
    const second = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { ...post, quantity: '7.25' } }));
    const third = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { ...post, quantity: '3' } }));
    expect([second, third]).toMatchObject([
      { lotCode: `${batch.A.batchNumber}-2`, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '7.25' },
      { lotCode: `${batch.A.batchNumber}-3`, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '3' },
    ]);
    // Not a finished lot: the manufacturer release and the finished-lot register never see it.
    expect((await gmp.db.admin.query('select 1 from site.finished_lot where lot_id = $1', [lotA])).rowCount).toBe(0);
    const of = async (b: string): Promise<string | null> => (await gmp.db.app.query<{ l: string | null }>('select site.intermediate_lot_of($1) as l', [b])).rows[0]?.l ?? null;
    expect([await of(batch.A.batchId), await of(randomUUID())]).toEqual([third.lotId, null]);
    const all = (await gmp.db.app.query<{ l: string }>('select l from site.intermediate_lots_of($1) as l', [batch.A.batchId])).rows.map((r) => r.l);
    expect(all).toEqual([lotA, second.lotId, third.lotId]);
  });

  it('[INV-27][IN-18] a tablets batch never reaches the intermediate post: the site function refuses any batch that is not a complete processing batch of the API edition', async () => {
    const tablets = (await gmp.db.admin.query<{ id: string }>("select b.id from recipe.stub_batch b join recipe.mbr_family f on f.id = b.family_id where f.edition <> 'substance' limit 1")).rows[0]?.id;
    const stores = await gmp.asPersona('stores');
    const r = await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: tablets ?? randomUUID(), quantity: '1', unit: 'kg' } });
    expect(refusalOf(r)?.why).toMatch(/EBMR-SITE-99[34]|EBMR-SUB-001|not a GMP batch|API edition/);
    // The internal function is not the application role's.
    await expect(gmp.db.app.query("select site.create_intermediate_lot('{}'::jsonb)")).rejects.toThrow(/permission denied/);
  });

  it('[INV-13][PR-18][IN-18] a quarantined intermediate is refused for step B at the reservation; QA releases it for further processing over the material-lot release, then step B reserves it; a consumption no batch-record entry names is refused', async () => {
    batch.B = await plannedAndIssued('B', masterB);
    const stores = await gmp.asPersona('stores');
    const reserve = { batchNumber: batch.B.batchNumber, quantity: '50' };
    expect(refusalOf(await stores.call(routes.quality.reserveLot, { params: { lotId: lotA }, body: reserve }))?.why).toMatch(/QUARANTINE|released|cannot be/i);
    // QC: the intermediate's specification and its approved result; QA's release for further processing.
    const [qc, head, qa] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover'), gmp.asPersona('qaInvestigator')]);
    const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
      materialCode: INT_A.code, title: 'Intermediate A specification (invented)', monographReference: 'In-house',
      tests: [{ testCode: 'ASSAY', methodReference: 'STP-A2-01', unit: '%', lowerLimit: '97.0', upperLimit: '103.0', required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '0.1', sampleUnit: 'kg' }],
    } }));
    await sign(head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
    const r = valueOf(await qc.call(routes.quality.recordLotResult, { params: { lotId: lotA }, body: { testCode: 'ASSAY', methodReference: 'STP-A2-01', purpose: 'RELEASE', value: '99.1', unit: '%' } }));
    await sign(head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
    const decision = { kind: 'LOT_DECISION' as const, lotId: lotA, decision: 'RELEASE_FOR_FURTHER_PROCESSING' as const, reason: { code: 'QC_PASSED', text: 'Intermediate meets its specification' } };
    expect(valueOf(await qa.call(routes.specifications.proposeLotDecision, { params: { lotId: lotA }, body: { event: 'RELEASE_FOR_FURTHER_PROCESSING' } }))).toMatchObject({ fromState: 'QUARANTINE' });
    await sign(qa, 'qaInvestigator', decision);
    expect(await lotState(lotA)).toBe('RELEASED_FOR_FURTHER_PROCESSING');
    valueOf(await stores.call(routes.quality.reserveLot, { params: { lotId: lotA }, body: reserve }));
    expect((await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from site.lot_reservation where lot_id = $1 and batch_id = $2', [lotA, batch.B.batchId])).rows[0]?.n).toBe('1');
    // On GMP a consumption is the batch record's own entry (the G-07 weighing, in the same command): a bare call is refused.
    await expect(consume(batch.B.batchId, INT_A.code, '50')).rejects.toThrow(/EBMR-RCP-433/);
  });

  it('[IN-05][PR-45][INV-27] the batch overview offers the intermediate post only for a complete processing batch of the API edition, also once a lot is posted (header.postsIntermediateLot, the server\'s answer): step A posted, yes; step B issued and not complete, no; a tablets batch, no', async () => {
    const offered = async (batchId: string): Promise<boolean | undefined> =>
      (await new RunDriver(gmp, batchId, { stores: await gmp.asPersona('stores') }).runView('stores')).header.postsIntermediateLot;
    expect([await offered(batch.A.batchId), await offered(batch.B.batchId)]).toEqual([true, false]);
    // A tablets processing batch at the same state, whatever its register says: the master's edition decides first.
    const tablets = { familyEdition: 'tablets', recordKind: 'PROCESSING', status: 'EXECUTION_COMPLETE' };
    expect([intermediatePostOffered({ ...tablets, registerEdition: 'TABLETS' }), intermediatePostOffered({ ...tablets, registerEdition: 'SUBSTANCE' }),
      intermediatePostOffered({ ...tablets, familyEdition: 'substance', registerEdition: 'TABLETS' }), intermediatePostOffered({ ...tablets, familyEdition: 'substance', recordKind: 'PACKAGING', registerEdition: 'SUBSTANCE' }),
      intermediatePostOffered({ ...tablets, familyEdition: 'substance', registerEdition: 'SUBSTANCE' })]).toEqual([false, false, false, false, true]);
  });

  it('[IN-05][PR-45] step B completes and posts intermediate B in quarantine, a lot of its own product; the overview still offers the post after it is made', async () => {
    await runToComplete(batch.B.batchId);
    const offered = async (): Promise<boolean | undefined> =>
      (await new RunDriver(gmp, batch.B.batchId, { stores: await gmp.asPersona('stores') }).runView('stores')).header.postsIntermediateLot;
    expect(await offered()).toBe(true);
    const lotB = valueOf(await (await gmp.asPersona('stores')).call(routes.specifications.postIntermediateLot, { body: { batchId: batch.B.batchId, quantity: '42.5', unit: 'kg' } }));
    expect(lotB).toMatchObject({ lotCode: batch.B.batchNumber, materialCode: INT_B.code, status: 'QUARANTINE', quantity: '42.5' });
    expect(await offered()).toBe(true);
  });

  it('[INV-27][IN-05] a lot code another lot holds at the site is refused: a received lot carrying <batch>-2 stops step B\'s second post (EBMR-SITE-997) and no intermediate lot is recorded; the material-lot uniqueness refuses any other row reusing the code', async () => {
    const stores = await gmp.asPersona('stores');
    const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface in the GMP seed');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const material = `EXC-${TAG}`;
    valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [{ materialCode: material, materialName: 'Excipient (invented)', materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${material}` }], orders: [] } } }));
    await confirmErpPending(gmp);
    valueOf(await stores.call(routes.quality.receiveLot, {
      body: { materialCode: material, lotCode: `${batch.B.batchNumber}-2`, supplier: 'Demo Supplier', supplierLot: `S-${TAG}`, quantity: '5.000', expiresAt: '2029-09-30T00:00:00+05:30', retestAt: '2029-03-31T00:00:00+05:30' },
    }));
    const r = await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: batch.B.batchId, quantity: '1', unit: 'kg' } });
    expect(refusalOf(r)?.why).toMatch(/EBMR-SITE-997|already held by another lot/);
    const n = await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from site.intermediate_lot where batch_id = $1', [batch.B.batchId]);
    expect(n.rows[0]?.n).toBe('1');
    // The table's own rule, under any path: a second row with the code at the site is refused by unique (site, lot code).
    await expect(gmp.db.admin.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       select gen_random_uuid(), l.site_code, l.lot_code, l.material_code, l.material_name, l.material_kind, l.received_quantity, l.unit, l.expires_at, l.received_by_person, l.received_by_account, gen_random_uuid()
         from site.material_lot l where l.site_code = $1 and l.lot_code = $2`, [SITE, batch.B.batchNumber])).rejects.toThrow(/material_lot_site_code_lot_code_key/);
  });
});
