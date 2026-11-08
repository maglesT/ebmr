/**
 * API plan A2, change C1 (site-services 1732, substance 5004): a processing batch of the API edition posts its output as
 * an INTERMEDIATE lot in quarantine; QA releases it for further processing through the material-lot release
 * (RELEASE_FOR_FURTHER_PROCESSING over the proposal, MATERIAL_LOT_STATUS_DECIDED); the next step's batch reserves it as
 * any lot (site.reserve_lot) and consumes it through the G-07 weighing of its own record.
 *
 * Three steps, one master record each (plan 2.3): step A makes intermediate A; QA releases it; step B's master names it
 * as its BOM line and its G-07 step dispenses it on a booked, qualified balance, which consumes the lot from B's
 * reservation in the same command (tablets 1093), and posts intermediate B; step C (the final API step) dispenses B the
 * same way, isolates the API into bulk, is released for packing (H-PACK), packed into drums and released as an API lot
 * (as api-chain.test.ts, A1a). A quarantined intermediate is refused at the reservation and at the weighing. The
 * genealogy route traces each step's consumption edge both ways.
 *
 * Arranged outside the routes, as in api-chain.test.ts: the plant-free masters (the dispensing step excepted), the ERP
 * orders, the numbering rules and the dispensing balance of the plant (support.ts, as tb-01-gmp.test.ts). A bare
 * recipe.consume_lot in the dispenser's command is refused: on GMP a consumption is the record's own entry.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { routes } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { openServiceSession, terminalOf } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { API_PACK } from '../../../../packages/recipe-core/src/library/seed/substance.ts';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { RunDriver, type ExecServer } from '../execution/support.ts';
import { intermediatePostOffered } from '../../src/features/execution/views.ts';
import { actorOf, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import {
  apiContent, arrangeBalance, bookBalance, closeBulk, driverOf, g07Phase, issueBatch, libraryEntry, packIntoDrums, phaseOf, range, reactBlock, releaseApiLot,
  signAs, stage, statusOf, type BatchRef, type Json, type StepInput,
} from './support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const BALANCE = 'BAL-A2';
const INT_A = { code: `INTA-${TAG}`, name: 'Demo intermediate A', strength: 'Step 1' };
const INT_B = { code: `INTB-${TAG}`, name: 'Demo intermediate B', strength: 'Step 2' };
const API_C = { code: `APIC-${TAG}`, name: 'Demosubstance A2', strength: '500 mg' };
const IN_A: StepInput = { code: INT_A.code, name: INT_A.name, quantity: '50', item: 'dispIntA' };
const IN_B: StepInput = { code: INT_B.code, name: INT_B.name, quantity: '42.5', item: 'dispIntB' };
const REASON = 'API edition A2 intermediates';

const REACT = reactBlock(`API-REACT-I${TAG}`);
const reaction = (like: Json): Json => stage(like, 'S-REACT', 'Reaction', [phaseOf(REACT, 'p-react', { limits: { temp: range('Cel', '55', '65', 'REF-A2') } })]);
const dispensing = (like: Json, input: StepInput): Json => stage(like, 'S-DISP', 'Dispensing', [g07Phase('p-disp', input)]);
/** The pack of step C: 40 kg into two 20 kg drums. */
const PACK_USE = { ...API_PACK.exampleUse, limits: { ...API_PACK.exampleUse.limits, netMass: range('kg', '19.950', '20.050', 'REF-A2') }, targets: { ...API_PACK.exampleUse.targets, netMass: '20.000' }, counts: { containers: '2' } };

const step = (p: typeof INT_A, stages: (like: Json) => Json[], input?: StepInput): flow.MbrContent =>
  apiContent({ family: `API-${p.code}`, title: `${p.name}: synthesis step`, product: p, recordKind: 'PROCESSING', defs: [REACT], stages, ...(input ? { input } : {}),
    ...(input ? {} : { materials: [{ code: `KSM-${TAG}`, title: 'Key starting material (invented)', role: 'ACTIVE', quantity: { value: '50', unit: 'kg' } }] }) });
const masterA = step(INT_A, (like) => [reaction(like)]);
const masterB = step(INT_B, (like) => [dispensing(like, IN_A), reaction(like)], IN_A);
const masterC = step(API_C, (like) => [
  dispensing(like, IN_B), reaction(like),
  stage(like, 'S-RELEASE', 'Release for packing', [{ kind: 'holdPoint', id: 'H-PACK', name: 'Batch released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }]),
], IN_B);
const packC = apiContent({
  family: `API-PK-${TAG}`, title: `${API_C.name} ${API_C.strength}: packing into drums`, product: API_C, recordKind: 'PACKAGING', packType: 'DRUM-30KG', defs: [API_PACK.definition],
  materials: [{ code: 'MAT-DRUM-30', title: 'HDPE drum 30 kg with two liners', role: 'PRIMARY_PACKAGING', quantity: { value: '2', unit: '1' } }],
  stages: (like) => [stage(like, 'S-PACK', 'Packing', [phaseOf(API_PACK.definition, 'p-pack', PACK_USE)])],
});

type Step = 'A' | 'B' | 'C' | 'P';
let gmp: ExecServer;
let world: World;
const fam: Record<Step, string> = { A: '', B: '', C: '', P: '' };
const empty = (): BatchRef => ({ batchId: '', batchNumber: '' });
const batch: Record<Step, BatchRef> = { A: empty(), B: empty(), C: empty(), P: empty() };
const lot = { A: '', B: '', P: '' };

async function plannedAndIssued(s: 'A' | 'B' | 'C', content: flow.MbrContent): Promise<BatchRef> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, SIZE);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: fam[s], markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: `Step ${s}` });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The reaction step run, verified and its stage signed off. */
async function runReaction(d: RunDriver): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-react@' });
  await d.ok('operator1', libraryEntry('p-react@', 'run', { temp: '60.0', complete: true }));
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-react@' });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-react@', meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-REACT@' });
}

/** The reaction step run: the execution of a batch without a release stage is complete. */
async function runToComplete(batchId: string): Promise<void> {
  await runReaction(await driverOf(gmp, batchId));
  expect(await statusOf(gmp, batchId)).toBe('EXECUTION_COMPLETE');
}

/** The dispenser's G-07 weighing of `lotCode` at step p-disp, keyed by hand on the booked balance (tare 1 kg). */
const weighing = (lotCode: string, input: StepInput, gross: string) => ({
  type: 'RECORD_ENTRY' as const, stepKey: 'p-disp@',
  entry: { kind: 'CONTAINER_WEIGHING' as const, item: input.item, bomLine: 'BOM-IN', lotCode, manual: { gross, tare: '1.000', unit: 'kg', deviceCode: BALANCE } },
});
/** The dispensing step performed by the dispenser, verified by a second person; QA dispositions the hand-keyed weight; the stage signed off. */
async function closeDispensing(d: RunDriver): Promise<void> {
  await d.signed('dispenser1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp@' });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-disp@', meaning: 'VERIFIED' });
  for (const e of (await d.runView('qa1')).exceptions.filter((x) => x.status === 'OPEN')) {
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: 'Second person checked the weight keyed by hand at the time; no impact on the batch.' });
  }
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' });
}

/** site.lot_consumption of the batch: lot code, batch number, quantity, unit, stock before and after. */
const consumptions = async (batchId: string): Promise<string[][]> =>
  (await gmp.db.admin.query<{ lot: string; batch: string; q: string; unit: string; before: string; after: string }>(
    `select l.lot_code as lot, c.batch_number as batch, trim_scale(c.quantity)::text as q, c.unit, trim_scale(c.quantity_before)::text as before, trim_scale(c.quantity_after)::text as after
       from site.lot_consumption c join site.material_lot l on l.id = c.lot_id where c.batch_id = $1 order by c.consumed_at`, [batchId],
  )).rows.map((r) => [r.lot, r.batch, r.q, r.unit, r.before, r.after]);

/** The G-07 entries of the batch record: the lot, BOM line and net each names. */
const dispensed = async (batchId: string): Promise<string[][]> =>
  (await gmp.db.admin.query<{ d: Json }>("select e.value -> 'data' as d from recipe.execution_state s, jsonb_each(s.state -> 'entries') e where s.batch_id = $1 and e.value ->> 'kind' = 'CONTAINER_WEIGHING'", [batchId]))
    .rows.map((r) => [String((r.d['lot'] as Json)['id']), String(r.d['bomLine']), String(r.d['net']), String(r.d['unit'])]);

/** recipe.consume_lot in the dispenser's command, outside any batch-record entry. */
async function consume(batchId: string, materialCode: string, quantity: string): Promise<Json> {
  const dispenser = await gmp.asPersona('dispenser1');
  const reservation = (await gmp.db.admin.query<{ id: string }>('select r.id from site.lot_reservation r where r.lot_id = $1 and r.batch_id = $2 order by r.reserved_at desc limit 1', [lot.A, batchId])).rows[0]?.id ?? randomUUID();
  return withCommand(gmp.db.app, { ...(await actorOfBrowser(gmp, dispenser, 'dispenser1')), correlationId: randomUUID() }, async (c) =>
    (await c.query<{ r: Json }>("select recipe.consume_lot($1, $2, $3, $4::numeric, 'kg') as r", [batchId, reservation, materialCode, quantity])).rows[0]!.r);
}

const lotState = async (lotId: string): Promise<string | undefined> => (await gmp.db.admin.query<{ s: string }>("select site.lot_state($1) as s", [lotId])).rows[0]?.s;

/** QC: the intermediate's specification and its approved result; QA's release for further processing. */
async function releaseForFurtherProcessing(lotId: string, materialCode: string): Promise<void> {
  const [qc, head, qa] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover'), gmp.asPersona('qaInvestigator')]);
  const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
    materialCode, title: `Intermediate ${materialCode} specification (invented)`, monographReference: 'In-house',
    tests: [{ testCode: 'ASSAY', methodReference: 'STP-A2-01', unit: '%', lowerLimit: '97.0', upperLimit: '103.0', required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '0.1', sampleUnit: 'kg' }],
  } }));
  await signAs(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
  const r = valueOf(await qc.call(routes.quality.recordLotResult, { params: { lotId }, body: { testCode: 'ASSAY', methodReference: 'STP-A2-01', purpose: 'RELEASE', value: '99.1', unit: '%' } }));
  await signAs(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
  expect(valueOf(await qa.call(routes.specifications.proposeLotDecision, { params: { lotId }, body: { event: 'RELEASE_FOR_FURTHER_PROCESSING' } }))).toMatchObject({ fromState: 'QUARANTINE' });
  await signAs(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId, decision: 'RELEASE_FOR_FURTHER_PROCESSING', reason: { code: 'QC_PASSED', text: 'Intermediate meets its specification' } });
  expect(await lotState(lotId)).toBe('RELEASED_FOR_FURTHER_PROCESSING');
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-api-a2-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const [p, months] of [[INT_A, 12], [INT_B, 12], [API_C, 36]] as const) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: months, changeReason: REASON } }));
  }
  await confirmErpPending(gmp);
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [REACT, API_PACK.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  world = await gmpLifecycleWorld(gmp);
  const stewardActor = await actorOf(gmp, 'steward');
  for (const [s, content, p, kind, format] of [
    ['A', masterA, INT_A, 'PROCESSING', 'A{YY}{SEQ:5}'], ['B', masterB, INT_B, 'PROCESSING', 'B{YY}{SEQ:5}'],
    ['C', masterC, API_C, 'PROCESSING', 'C{YY}{SEQ:5}'], ['P', packC, API_C, 'PACKAGING', '{PARENT}/P{SEQ:2}'],
  ] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented API)' });
    fam[s] = v.familyId;
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `A2-${s}-${TAG}`, site_code: SITE, product_code: p.code, batch_kind: kind, format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`API A2 numbering (step ${s})`),
    );
  }
  await arrangeBalance(gmp, BALANCE, [INT_B.code, API_C.code]);
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
    const posted = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: post }));
    lot.A = posted.lotId;
    expect(posted).toMatchObject({ lotCode: batch.A.batchNumber, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '50', unit: 'kg' });
    const { rows } = await gmp.db.admin.query<{ kind: string; edition: string; exp: string; want: string }>(
      `select l.material_kind as kind, i.edition, (l.expires_at at time zone 'Asia/Kolkata')::date::text as exp, recipe.batch_expiry($2) ->> 'expiryDate' as want
         from site.intermediate_lot i join site.material_lot l on l.id = i.lot_id where i.lot_id = $1`, [lot.A, batch.A.batchId]);
    expect(rows).toEqual([{ kind: 'INTERMEDIATE', edition: 'SUBSTANCE', exp: rows[0]?.want, want: rows[0]?.want }]);
    // More than one intermediate lot per batch (second crops, split isolations; site-services 1734): numbered in posting order.
    const second = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { ...post, quantity: '7.25' } }));
    const third = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { ...post, quantity: '3' } }));
    expect([second, third]).toMatchObject([
      { lotCode: `${batch.A.batchNumber}-2`, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '7.25' },
      { lotCode: `${batch.A.batchNumber}-3`, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '3' },
    ]);
    // Not a finished lot: the manufacturer release and the finished-lot register never see it.
    expect((await gmp.db.admin.query('select 1 from site.finished_lot where lot_id = $1', [lot.A])).rowCount).toBe(0);
    const of = async (b: string): Promise<string | null> => (await gmp.db.app.query<{ l: string | null }>('select site.intermediate_lot_of($1) as l', [b])).rows[0]?.l ?? null;
    expect([await of(batch.A.batchId), await of(randomUUID())]).toEqual([third.lotId, null]);
    const all = (await gmp.db.app.query<{ l: string }>('select l from site.intermediate_lots_of($1) as l', [batch.A.batchId])).rows.map((r) => r.l);
    expect(all).toEqual([lot.A, second.lotId, third.lotId]);
  });

  it('[INV-27][IN-18] a tablets batch never reaches the intermediate post: the site function refuses any batch that is not a complete processing batch of the API edition', async () => {
    const tablets = (await gmp.db.admin.query<{ id: string }>("select b.id from recipe.stub_batch b join recipe.mbr_family f on f.id = b.family_id where f.edition <> 'substance' limit 1")).rows[0]?.id;
    const stores = await gmp.asPersona('stores');
    const r = await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: tablets ?? randomUUID(), quantity: '1', unit: 'kg' } });
    expect(refusalOf(r)?.why).toMatch(/EBMR-SITE-99[34]|EBMR-SUB-001|not a GMP batch|API edition/);
    // The internal function is not the application role's.
    await expect(gmp.db.app.query("select site.create_intermediate_lot('{}'::jsonb)")).rejects.toThrow(/permission denied/);
  });

  it('[AS-16][INV-13][PR-18][IN-18] a quarantined intermediate is refused for step B at the reservation; QA releases it for further processing over the material-lot release, then step B reserves it; a consumption no batch-record entry names is refused', async () => {
    batch.B = await plannedAndIssued('B', masterB);
    const stores = await gmp.asPersona('stores');
    const reserve = { batchNumber: batch.B.batchNumber, quantity: '50' };
    expect(refusalOf(await stores.call(routes.quality.reserveLot, { params: { lotId: lot.A }, body: reserve }))?.why).toMatch(/QUARANTINE|released|cannot be/i);
    await releaseForFurtherProcessing(lot.A, INT_A.code);
    valueOf(await stores.call(routes.quality.reserveLot, { params: { lotId: lot.A }, body: reserve }));
    expect((await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from site.lot_reservation where lot_id = $1 and batch_id = $2', [lot.A, batch.B.batchId])).rows[0]?.n).toBe('1');
    // On GMP a consumption is the batch record's own entry (the G-07 weighing, in the same command): a bare call is refused.
    await expect(consume(batch.B.batchId, INT_A.code, '50')).rejects.toThrow(/EBMR-RCP-433/);
    expect(await consumptions(batch.B.batchId)).toEqual([]);
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

  it('[AS-03][AS-04][INV-13][INV-14][PR-57][IN-05][PR-45] step B dispenses intermediate A at its G-07 step on the booked balance: the weighing is consumed from B\'s reservation in the same command, so B\'s record names lot A and its quantity; B completes and posts intermediate B in quarantine, a lot of its own product; the overview still offers the post after it is made', async () => {
    await bookBalance(gmp, BALANCE, batch.B.batchId);
    const d = await driverOf(gmp, batch.B.batchId);
    await d.ok('dispenser1', { type: 'START_STEP', stepKey: 'p-disp@' });
    await d.ok('dispenser1', weighing(batch.A.batchNumber, IN_A, '51.000'));
    expect(await consumptions(batch.B.batchId)).toEqual([[batch.A.batchNumber, batch.B.batchNumber, '50', 'kg', '50', '0']]);
    expect(await dispensed(batch.B.batchId)).toEqual([[batch.A.batchNumber, 'BOM-IN', '50.000', 'kg']]);
    await closeDispensing(d);
    await runReaction(d);
    expect(await statusOf(gmp, batch.B.batchId)).toBe('EXECUTION_COMPLETE');
    const offered = async (): Promise<boolean | undefined> =>
      (await new RunDriver(gmp, batch.B.batchId, { stores: await gmp.asPersona('stores') }).runView('stores')).header.postsIntermediateLot;
    expect(await offered()).toBe(true);
    const posted = valueOf(await (await gmp.asPersona('stores')).call(routes.specifications.postIntermediateLot, { body: { batchId: batch.B.batchId, quantity: '42.5', unit: 'kg' } }));
    lot.B = posted.lotId;
    expect(posted).toMatchObject({ lotCode: batch.B.batchNumber, materialCode: INT_B.code, status: 'QUARANTINE', quantity: '42.5' });
    expect(await offered()).toBe(true);
  });

  it('[AS-16][PR-18][INV-13][INV-14] the final step C refuses intermediate B in quarantine at the reservation and at its G-07 weighing, consuming nothing; once QA releases B for further processing, C reserves it and its weighing consumes it', async () => {
    batch.C = await plannedAndIssued('C', masterC);
    const stores = await gmp.asPersona('stores');
    const reserve = { batchNumber: batch.C.batchNumber, quantity: '42.5' };
    expect(refusalOf(await stores.call(routes.quality.reserveLot, { params: { lotId: lot.B }, body: reserve }))?.why).toMatch(/QUARANTINE|released|cannot be/i);
    await bookBalance(gmp, BALANCE, batch.C.batchId);
    const d = await driverOf(gmp, batch.C.batchId);
    await d.ok('dispenser1', { type: 'START_STEP', stepKey: 'p-disp@' });
    expect(refusalOf(await d.command('dispenser1', weighing(batch.B.batchNumber, IN_B, '43.500')))?.why).toMatch(/QUARANTINE/i);
    expect([await consumptions(batch.C.batchId), await dispensed(batch.C.batchId)]).toEqual([[], []]);
    await releaseForFurtherProcessing(lot.B, INT_B.code);
    valueOf(await stores.call(routes.quality.reserveLot, { params: { lotId: lot.B }, body: reserve }));
    await d.ok('dispenser1', weighing(batch.B.batchNumber, IN_B, '43.500'));
    expect(await consumptions(batch.C.batchId)).toEqual([[batch.B.batchNumber, batch.C.batchNumber, '42.5', 'kg', '42.5', '0']]);
    expect(await dispensed(batch.C.batchId)).toEqual([[batch.B.batchNumber, 'BOM-IN', '42.500', 'kg']]);
    await closeDispensing(d);
  });

  it('[AS-03][INV-27][PR-37][IN-17] step C runs to its isolated API, is released for packing, packed into two drums and posted as the API lot; QC, QA and the authorised person release it with no RED item of G-REL', async () => {
    const d = await driverOf(gmp, batch.C.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-react@' });
    await d.ok('operator1', libraryEntry('p-react@', 'run', { temp: '60.5', complete: true }));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-react@' });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-react@', meaning: 'VERIFIED' });
    const bulk = await closeBulk(gmp, d, batch.C.batchId, '40.000');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-REACT@' });
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Batch released for packing' });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-RELEASE@' });
    expect(await statusOf(gmp, batch.C.batchId)).toBe('EXECUTION_COMPLETE');
    const issuer = await gmp.asPersona('issuer');
    const orderNo = await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), packC, SIZE);
    const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: fam.P, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE, erpOrder: orderNo, parentBatchId: batch.C.batchId } }));
    await issueBatch(gmp, planned.batchId, { code: 'PACKING_PLAN', text: `Packaging order of batch ${batch.C.batchNumber}` });
    batch.P = { batchId: planned.batchId, batchNumber: planned.batchNumber };
    await packIntoDrums(gmp, batch.P, bulk, [['D-01', '20.000'], ['D-02', '20.000']]);
    const posted = valueOf(await (await gmp.asPersona('stores')).call(routes.specifications.postFinishedLot, { body: { batchId: batch.P.batchId, quantity: '40', unit: 'kg' } }));
    lot.P = (posted as unknown as { lotId: string }).lotId;
    await releaseApiLot(gmp, lot.P, API_C.code, [batch.C, batch.P]);
  });

  it('[PR-57][IN-07][AS-04] the genealogy route traces each step\'s consumption both ways: lot A forward to step B, step B back to lot A, and the API lot back through its packaging order and step C to lot B', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const trace = async (kind: 'LOT' | 'BATCH', id: string, direction: 'FORWARD' | 'BACKWARD'): Promise<(string | null)[][]> => {
      const t = valueOf(await qa.call(routes.genealogy.trace, { query: { kind, id, direction } }));
      return t.edges.map((e) => [e.node.kind, t.nodes.find((n) => n.kind === e.node.kind && n.id === e.node.id)?.label ?? null, e.edgeKind]);
    };
    expect(await trace('LOT', lot.A, 'FORWARD')).toEqual(expect.arrayContaining([['BATCH', batch.B.batchNumber, 'CONSUMED']]));
    expect(await trace('BATCH', batch.B.batchId, 'BACKWARD')).toEqual(expect.arrayContaining([['LOT', batch.A.batchNumber, 'CONSUMED']]));
    expect(await trace('LOT', lot.P, 'BACKWARD')).toEqual(expect.arrayContaining([
      ['BATCH', batch.P.batchNumber, 'FINISHED'], ['BATCH', batch.C.batchNumber, 'PACKAGING_ORDER'], ['LOT', batch.B.batchNumber, 'CONSUMED'],
    ]));
  });

  it('[AS-04][PR-57][IN-07] the trace crosses the intermediate lots both ways (recipe-core 1879): the API lot back through step C, lot B and step B to lot A and step A; lot A forward through step B, lot B and step C to the API lot', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const trace = async (kind: 'LOT' | 'BATCH', id: string, direction: 'FORWARD' | 'BACKWARD'): Promise<(string | null)[][]> => {
      const t = valueOf(await qa.call(routes.genealogy.trace, { query: { kind, id, direction } }));
      const label = (r: { kind: string; id: string } | null): string | null => (r ? t.nodes.find((n) => n.kind === r.kind && n.id === r.id)?.label ?? null : null);
      return t.edges.map((e) => [e.parent?.kind ?? null, label(e.parent), e.edgeKind, e.node.kind, label(e.node)]);
    };
    const [A, B, C, P] = [batch.A.batchNumber, batch.B.batchNumber, batch.C.batchNumber, batch.P.batchNumber];
    expect(await trace('LOT', lot.P, 'BACKWARD')).toEqual(expect.arrayContaining([
      ['LOT', P, 'FINISHED', 'BATCH', P], ['BATCH', P, 'PACKAGING_ORDER', 'BATCH', C], ['BATCH', C, 'CONSUMED', 'LOT', B],
      ['LOT', B, 'OUTPUT', 'BATCH', B], ['BATCH', B, 'CONSUMED', 'LOT', A], ['LOT', A, 'OUTPUT', 'BATCH', A],
    ]));
    expect(await trace('LOT', lot.A, 'FORWARD')).toEqual(expect.arrayContaining([
      ['LOT', A, 'CONSUMED', 'BATCH', B], ['BATCH', B, 'OUTPUT', 'LOT', B], ['LOT', B, 'CONSUMED', 'BATCH', C],
      ['BATCH', C, 'PACKAGING_ORDER', 'BATCH', P], ['BATCH', P, 'FINISHED', 'LOT', P],
    ]));
  });

  it('[INV-27][IN-05] a lot code another lot holds at the site is never reused: with a received lot carrying <batch>-2, step B\'s second post takes the next free code <batch>-3; the material-lot uniqueness refuses any other row reusing a code', async () => {
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
    const next = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: batch.B.batchId, quantity: '1', unit: 'kg' } }));
    expect(next).toMatchObject({ lotCode: `${batch.B.batchNumber}-3`, materialCode: INT_B.code, status: 'QUARANTINE' });
    const n = await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from site.intermediate_lot where batch_id = $1', [batch.B.batchId]);
    expect(n.rows[0]?.n).toBe('2');
    // The table's own rule, under any path: a second row with the code at the site is refused by unique (site, lot code).
    await expect(gmp.db.admin.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       select gen_random_uuid(), l.site_code, l.lot_code, l.material_code, l.material_name, l.material_kind, l.received_quantity, l.unit, l.expires_at, l.received_by_person, l.received_by_account, gen_random_uuid()
         from site.material_lot l where l.site_code = $1 and l.lot_code = $2`, [SITE, batch.B.batchNumber])).rejects.toThrow(/material_lot_site_code_lot_code_key/);
  });
});
