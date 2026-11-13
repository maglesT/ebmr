/**
 * Injectables I-6.3 (ST-71; lead ruling (a), 12 November 2026): on an injectables processing batch, a unit accountability
 * that does not balance (INJ-UNIT-ACCOUNT, the edition's yield) and an open deviation each keep the lot from release, over
 * the routes with the seed's personas and real signatures. The master: ampoule filling (INJ-FILL), sealing
 * (INJ-AMPOULE-SEAL), 100 % inspection (INJ-VISUAL-INSPECT) and the unit accountability that reads their counts. The
 * finished lot is posted on the processing batch as the edition's definer posts it, as aseptic-gate.test.ts does (whose
 * arrangement this file follows), so the gate is evaluated on that record.
 *
 * Arranged outside the routes: the product, the licence, the plant units the steps name (test arrangement of master
 * data), the ERP order and the numbering rule.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type BatchRef, type Json } from '../substance/support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `INJUA-${TAG}`, name: 'Demoinj 10 mg/2 mL ampoules', strength: '10 mg/2 mL' };
const REASON = 'Injectables I-6.3 unit accountability gate';
/** The plant units the steps name, by field id: class, code, name. */
const UNITS: Record<string, readonly [string, string, string]> = {
  line: ['VIAL-FILLING-LINE', `AMP-LINE-${TAG}`, 'Ampoule filling line'],
  room: ['ROOM-GRADE-C', `ROOM-C-${TAG}`, 'Grade C filling room'],
  sealer: ['AMPOULE-SEALER', `SEALER-${TAG}`, 'Ampoule sealing station'],
  booth: ['INSPECTION-BOOTH', `BOOTH-${TAG}`, 'Inspection booth'],
};

const seed = (code: string) => {
  const item = INJECTABLE_SEEDS.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const SEAL = seed('INJ-AMPOULE-SEAL');
const INSPECT = seed('INJ-VISUAL-INSPECT');
const ACCOUNT = seed('INJ-UNIT-ACCOUNT');
/** An ampoule master reads the closing rejects from its sealing step, as the catalogue's own test wires it. */
const ACCOUNT_USE = { ...ACCOUNT.exampleUse, stepValues: { ...ACCOUNT.exampleUse.stepValues, closingRejectsSource: { step: 'sealing', field: 'totalRejects' } } };
const DEFS = [FILL.definition, SEAL.definition, INSPECT.definition, ACCOUNT.definition];

const processing: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-UA-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['title'] = `${PRODUCT.name}: filling to unit accountability`;
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [
    stage(like, 'S-FILL', 'Filling, sealing, inspection and unit accountability', [
      phaseOf(FILL.definition, 'filling', FILL.exampleUse),
      phaseOf(SEAL.definition, 'sealing', SEAL.exampleUse),
      phaseOf(INSPECT.definition, 'inspection', INSPECT.exampleUse),
      phaseOf(ACCOUNT.definition, 'account', ACCOUNT_USE),
    ]),
  ];
  for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
  m['blockDefinitions'] = DEFS;
});

let gmp: ExecServer;
let world: World;
let proc: { familyId: string; versionId: string };
let n = 0;

/** The plant units the steps name (test arrangement of master data, triggers off): qualified, of the formulation's classes. */
async function arrangeUnits(): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const [cls, code, name] of Object.values(UNITS)) {
      await c.query(
        "insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ($1, 'PROCESS', $2, interval '3 days', interval '2 days', false, gen_random_uuid()) on conflict do nothing",
        [cls, name],
      );
      const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, $2, $3, 'PROCESS', gen_random_uuid()) returning id", [code, name, cls]);
      await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-INJ', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    }
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** A processing batch of the master, planned from its ERP order and issued. */
async function issued(): Promise<BatchRef> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), processing, SIZE);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: proc.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The nominal entries of a library step at `stepKey` (some sections' data changed), recorded by operator1. */
async function record(d: RunDriver, stepKey: string, item: { definition: library.BlockDefinition; exampleUse: unknown }, over: Json = {}): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  const units: Json = Object.fromEntries(Object.entries(UNITS).map(([k, v]) => [k, v[1]]));
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    // The equipment facts are the server's (EBMR-API-SERVER-FILLED): the entry names the units by their codes only.
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'equipment' && k !== 'lots'));
    for (const k of Object.keys(data)) if (k in units) data[k] = units[k];
    if (kind === 'tray') data['trayOut'] = `TRAY-${TAG}-${String((n += 1))}`;
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
}

async function signed(d: RunDriver, stepKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** The finished lot of the batch, posted as the edition's definer posts it (site.create_finished_lot is not granted). */
async function lotOf(b: BatchRef): Promise<string> {
  const stores = { ...(await actorOf(gmp, 'stores')), reasonCode: 'TEST_SETUP', reasonText: 'finished lot of the processing record', correlationId: randomUUID() };
  return withCommand(gmp.db.admin, stores, async (c) =>
    String((await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b.batchId, batchNumber: b.batchNumber, edition: 'INJECTABLES', siteCode: SITE, productCode: PRODUCT.code, productName: PRODUCT.name,
                       strength: PRODUCT.strength, markets: ['IN'], quantity: '9600', unit: 'units', expiresAt: '2028-10-31T23:59:59Z' }),
    ])).rows[0]?.id),
  );
}

/** The authorised person's release view of the lot: its state and the G-REL items with their status and problem. */
async function releaseView(lotId: string): Promise<{ state: string; items: Record<string, { status: string; problem: string | null }> }> {
  const ap = await gmp.asPersona('qcuAuthoriser');
  const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  return { state: view.state, items: Object.fromEntries(view.grel.items.map((i) => [i.id, { status: i.status, problem: i.problem ?? null }])) };
}

/** A deviation raised by the QA investigator and linked to the batch. */
async function deviationOn(b: BatchRef, title: string): Promise<{ deviationId: string; ref: string }> {
  const qaInv = await gmp.asPersona('qaInvestigator');
  const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title, classification: 'MAJOR', riskRationale: 'Investigated before any release of the batch.' } }));
  valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.batchId } }));
  return dev;
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-account-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/INJ/${TAG}`, holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: PRODUCT.code, strength: PRODUCT.strength }],
  } }));
  await signAs(gmp, await gmp.asPersona('approver'), 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of DEFS) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  await arrangeUnits();
  world = await gmpLifecycleWorld(gmp);
  proc = await world.approvedVersion(processing);
  await world.authorise({ versionId: proc.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  await world.run(await actorOf(gmp, 'steward'), (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `INJUA-${TAG}`, site_code: SITE, product_code: PRODUCT.code, batch_kind: 'PROCESSING', format: 'U{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
    reason('Injectables I-6.3 numbering'),
  );
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('Injectables I-6.3: the release gate on an unbalanced unit accountability and an open deviation', () => {
  it('[ST-71] units not accounted for raise a critical exception the step cannot be signed past; QA dispositions it under a deviation, and with that deviation and another one open on the batch the lot is not releasable (G2.DEVIATIONS RED)', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    // Ampoules: no stopper-height check.
    await record(d, 'filling@', FILL, { setup: { format: 'Ampoule', stopperCheck: undefined } });
    await signed(d, 'filling@');
    await record(d, 'sealing@', SEAL);
    await signed(d, 'sealing@');
    await record(d, 'inspection@', INSPECT);
    await signed(d, 'inspection@');
    // The documented losses typed as none: the units lost on the line are not accounted for.
    await record(d, 'account@', ACCOUNT, { account: { losses: '0' } });
    const state = (await gmp.db.admin.query<{ s: { exceptions: Record<string, { type: string; source?: { step?: string } }> } }>('select state as s from recipe.execution_state where batch_id = $1', [b.batchId])).rows[0]!.s;
    const breaches = Object.entries(state.exceptions).filter(([, x]) => x.type === 'LIB_LIMIT_BREACH').map(([id]) => id);
    expect(breaches).toHaveLength(1);
    expect(state.exceptions[breaches[0] ?? '']?.source?.step).toBe('account');
    // The step cannot be signed until the exception is handled.
    expect((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'account@' })).result.ok).toBe(false);
    const yieldDev = await deviationOn(b, `Units not accounted for in the unit accountability of ${b.batchNumber}`);
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breaches[0] ?? '', deviationRef: yieldDev.ref });
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breaches[0] ?? '', outcome: 'DEVIATION_RAISED', justification: `Deviation ${yieldDev.ref}: the batch is held until the investigation concludes` });
    await signed(d, 'account@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
    const other = await deviationOn(b, `Sterilisation cycle alarm during the batch ${b.batchNumber}`);
    const lotId = await lotOf(b);
    const view = await releaseView(lotId);
    expect(view.state).toBe('NOT_READY');
    expect(view.items['G2.DEVIATIONS']).toMatchObject({ status: 'RED' });
    expect(view.items['G2.DEVIATIONS']?.problem).toMatch(new RegExp(`${yieldDev.ref}|${other.ref}`));
  });
});
