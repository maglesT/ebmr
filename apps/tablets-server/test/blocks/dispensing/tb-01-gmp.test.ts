/**
 * TB-01@1 on the GMP installation (Phase 3 slice 3b; tablets 0841 to 0843; slice 1 site lots and recipe.consume_lot;
 * slice 2b GMP batches): a GMP batch issued from an effective MBR version runs the potency-adjusted dispensing on the
 * site's material lots. The calculation reads the register's status and approved result; a quarantined site lot is
 * refused; the dispenser weighs on a calibrated, checked balance of the room (plant instrument check and use) by hand,
 * since no scale of the room is behind the gateway, so the step needs a second person; the server consumes each
 * container's net from the batch's reservation in the same command and the entry names the consumption (genealogy,
 * INV-13, INV-14). Past the server, a GMP weighing without its consumption, or naming another quantity, is refused.
 *
 * Master data the test needs and no GMP persona can record yet (site lots, their release, reservations and results by
 * stores and QC, the balance's qualification and calibration) is arranged by the superuser with triggers off, as test
 * setup only; everything the step does runs as the application role.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { execution, flow, type engine } from '@ebmr/recipe-core';
import type pg from 'pg';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { openPersonaSession, openServiceSession, passwordActor } from '@ebmr/test-kit';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { cmd, signatureAuth } from '../../../../../packages/kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../../../packages/kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../../../packages/kernel/test/support/db.ts';
import { cell, reason, World, type Cast } from '../../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import type { TestServer } from '../../support/harness.ts';
import { arrangeCompleteReceipt } from '../../support/receipt-fixture.ts';
import { recordContentForSigning } from '../../../src/features/esig/content.ts';
import { engineActor, engineRoles } from '../../../src/features/execution/roles.ts';
import { runContext } from '../../../src/features/execution/runs.ts';
import { actorOfBrowser, personaIn, startSigningServer } from '../../esig/support.ts';
import { actorOf as actorOfRun, appendAs, engineResult, messageOf, prepareSignature } from '../../execution/db-guards-support.ts';
import { asPersonaInRole, dcMini, refusalOf, RunDriver, valueOf, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;
const SITE = 'SITE-1';
const LINE = 'L1';
const BATCH_SIZE = 'BS-100K';
const STEP = 'p-tb01';
const KEY = `${STEP}@`;
const G07_STEP = 'p-g07';
const G07_KEY = `${G07_STEP}@`;
const BALANCE = 'BAL-07';

let gmp: ExecServer;
let world: World;
let familyId: string;
let gmpMbr: flow.MbrContent;
let product: string;

class GmpWorld extends World {
  constructor(
    db: TestDatabase,
    cast: Cast,
    private readonly key: esig.SealKeyProvider,
  ) {
    super(db, cast);
  }

  override async sign(signer: SeededActor, aggregateType: string, aggregateId: string, meaning: string, expectedState: string | null): Promise<string> {
    const content = await recordContentForSigning(this.db.app, aggregateType, aggregateId);
    const ch = await withCommand(this.db.app, await cmd(this.db, signer), (c) =>
      esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
    );
    const authEventId = await signatureAuth(this.db, signer, signer, ch.challengeId);
    return (await withCommand(this.db.app, await cmd(this.db, signer), (c) => esig.sign(c, { challengeId: ch.challengeId, authEventId, expectedState }, this.key))).signatureId;
  }

  override async regulatoryConfirm(versionId: string, signer: SeededActor = this.cast.regulatory): Promise<void> {
    await this.sign(signer, 'mbr_version', versionId, 'REGULATORY_CONFIRMED', (await this.state(versionId)).state);
  }
}

async function actorOf(server: TestServer, key: string): Promise<SeededActor> {
  const p = personaIn(server, key);
  const s = await openPersonaSession(server.db, server.seed, key);
  return { ...s, seed: { loginName: p.loginName, password: p.password, deviceFingerprint: s.fingerprint, deviceClass: 'PERSONAL', grantId: '', identityVerificationId: '' } };
}

/** dc-mini as a GMP master with a TB-01 step first in dispensing (paracetamol as is, compensated by MCC), without G-09@1 and G-10@1. */
function gmpContent(): flow.MbrContent {
  const m = JSON.parse(JSON.stringify(dcMini())) as Json;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const header = m['header'] as Json;
  header['family'] = `${String(header['family'])}-${tag}`;
  product = `${String((header['product'] as Json)['code'])}-${tag}`;
  header['product'] = { ...(header['product'] as Json), code: product };
  (m['parameters'] as Json[]).push(
    { id: 'tbApi', name: 'Paracetamol dispensed (potency-adjusted)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
    { id: 'tbMcc', name: 'MCC dispensed (compensating)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'NON_CRITICAL', riskClass: 'MEDIUM', capture: 'DEVICE' },
  );
  const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
  (m['parameters'] as Json[]).push({ id: 'g07Mgs', name: 'Magnesium stearate dispensed (G-07)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'NON_CRITICAL', riskClass: 'MEDIUM', capture: 'DEVICE' });
  const tb01 = {
    kind: 'phase', id: STEP, name: 'Potency-adjusted dispensing', block: { type: 'TB-01', version: '1' },
    config: {
      active: { bomLine: 'BOM-PCM', basis: 'AS_IS', standardIs: 'FORM', standardBasis: 'paracetamol at 100.0 % as is' },
      compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', min: '8.000', max: '11.000' },
      readability: '0.001',
      tolerancePercent: { active: '0.5', excipient: '1.0' },
    },
    records: ['tbApi', 'tbMcc'], computes: [], reads: [], consumes: ['BOM-PCM', 'BOM-MCC'], produces: [], uses: [], equipment: [],
    signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
    significant: true, riskClass: 'HIGH',
  };
  // A G-07 dispensing step beside it (slice 6d: on GMP its weighing of a lot is consumed too, tablets 1093).
  const g07 = {
    kind: 'phase', id: G07_STEP, name: 'Dispense the lubricant', block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '1.0' } },
    records: ['g07Mgs'], computes: [], reads: [], consumes: ['BOM-MGS'], produces: [], uses: [], equipment: [],
    signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
    significant: true, riskClass: 'HIGH',
  };
  prep['children'] = [
    { kind: 'parallel', id: 'par-disp', branches: [{ id: 'br-tb01', name: 'Potency-adjusted', body: tb01 }, { id: 'br-g07', name: 'Lubricant', body: g07 }] },
    ...(prep['children'] as Json[]),
  ];
  const strip = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.filter((x) => !['G-09', 'G-10'].includes(String(((x as Json | null)?.['block'] as Json | undefined)?.['type']))).map(strip);
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, strip(v)]));
    return n;
  };
  const parsed = flow.parseMbr(strip(m));
  if (!parsed.ok) throw new Error(`the GMP master does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

/** Superuser set-up with triggers off (test arrangement of master data only). */
async function arrange(work: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await work(c);
    await c.query('commit');
  } finally {
    c.release();
  }
}

const LOTS: { code: string; material: string; days: number; state: string; assay?: string }[] = [
  { code: 'L26-0201', material: 'MAT-PCM', days: 700, state: 'RELEASED', assay: '98.5' },
  { code: 'L26-0202', material: 'MAT-PCM', days: 900, state: 'RELEASED', assay: '99.0' },
  { code: 'L26-0203', material: 'MAT-PCM', days: 650, state: 'QUARANTINE', assay: '99.0' },
  { code: 'L26-0301', material: 'MAT-MCC', days: 700, state: 'RELEASED' },
  { code: 'L26-0401', material: 'MAT-MGS', days: 700, state: 'RELEASED' },
];
const lotIds = new Map<string, string>();

/** Registers site lot `l` (received `quantity` kg, 100 when not given) with its state, identity result, receipt and assay (test arrangement). */
async function registerLot(c: pg.PoolClient, l: { code: string; material: string; days: number; state: string; assay?: string; quantity?: string }): Promise<void> {
  const id = randomUUID();
  lotIds.set(l.code, id);
  await c.query(
    `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at, received_by_person, received_by_account, correlation_id)
     values ($1, $2, $3, $4, $4, $5, $7::numeric, 'kg', clock_timestamp() + make_interval(days => $6 - 300), clock_timestamp() + make_interval(days => $6), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [id, SITE, l.code, l.material, l.material === 'MAT-PCM' ? 'API' : 'EXCIPIENT', l.days, l.quantity ?? '100'],
  );
  await c.query("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('material_lot', $1, 'material_lot', 1, $2, 1)", [id, l.state]);
  await c.query("insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account) values ($1, 'PASS', 'IR-01', 'T-01', gen_random_uuid(), gen_random_uuid())", [id]);
  await arrangeCompleteReceipt(c, { id, site: SITE, material: l.material, ...(l.quantity ? { quantity: l.quantity } : {}) });
  if (l.assay) {
    // On GMP the assay is copied from an approved LIMS-lite result and names it (slice 5a; tablets 1001).
    const { rows: lims } = await c.query<{ id: string }>(
      "insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'ASSAY', 'STP-AS-01', 'RELEASE', $2::numeric, '%', 98.0, 102.0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id",
      [id, l.assay],
    );
    await c.query('insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [lims[0]?.id]);
    const { rows: assay } = await c.query<{ id: string }>(
      "insert into tab.lot_assay_result (material_lot_id, basis, assay, certificate_ref, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'AS_IS', $2::numeric, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id",
      [id, l.assay, `COA-${l.code}`],
    );
    await c.query("insert into tab.lot_assay_source (assay_result_id, value_kind, lims_result_id) values ($1, 'assay', $2)", [assay[0]?.id, lims[0]?.id]);
  }
}

async function owner(): Promise<ActorContext> {
  return passwordActor(gmp.db, gmp.seed.bootstrap.owner, gmp.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'dispenser designation', correlationId: randomUUID() });
}
async function admin(): Promise<ActorContext> {
  return passwordActor(gmp.db, gmp.seed.bootstrap.admin, gmp.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'dispenser designation', correlationId: randomUUID() });
}

const passwordOf = (key: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(gmp, key).loginName, password: personaIn(gmp, key).password });

/** A GMP batch planned and issued by the issuer (ceremony with ISSUED); its id and number. */
async function issued(): Promise<{ batchId: string; batchNumber: string }> {
  const issuer = await gmp.asPersona('issuer');
  // The ERP order the server plans the batch against (D-S5-4; recipe-core 0602).
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), gmpMbr, BATCH_SIZE);
  const plan = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE } }));
  const content = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: plan.batchId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: plan.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the TB-01 tests' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT' as const, value: '100000' } } };
  const body = { aggregateType: 'batch_issue', aggregateId: plan.batchId, contentVersion: content.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(content.canonicalText), action };
  const challenge = valueOf(await issuer.call(routes.esig.createChallenge, { body }));
  const signBody = { challengeId: challenge.challengeId, credentials: passwordOf('issuer'), action };
  const r = await issuer.call(routes.esig.sign, { body: { ...signBody, proof: await issuer.proof('POST', '/api/esig/sign', signBody) } });
  if (!r.ok) throw new Error(`SETUP: the issue was refused: ${JSON.stringify(refusalOf(r))}`);
  return { batchId: plan.batchId, batchNumber: plan.batchNumber };
}

/** Stores reserve `qty` kg of each released lot for the batch (test arrangement), and operator1 records the balance's check and use. */
async function prepareBatch(b: { batchId: string; batchNumber: string }): Promise<void> {
  await arrange(async (c) => {
    for (const l of LOTS.filter((x) => x.state === 'RELEASED')) {
      await c.query(
        `insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
         values ($1, $2, $3, 'TABLETS', 60, 'kg', clock_timestamp() + interval '2 days', 1, gen_random_uuid(), gen_random_uuid())`,
        [lotIds.get(l.code), b.batchId, b.batchNumber],
      );
    }
  });
  const operator = { ...(await openPersonaSession(gmp.db, gmp.seed, 'operator1')), correlationId: randomUUID() };
  const tap = await identity.authenticate(gmp.db.authn, { method: 'BADGE_TAP', identifier: personaIn(gmp, 'operator1').badgeUid ?? '', deviceFingerprint: gmp.seed.terminals.find((t) => t.code === 'KIOSK-DISP-1')?.fingerprint ?? '', purpose: 'COMMAND' });
  await withCommand(gmp.db.app, { ...operator, authEventId: tap.authEventId }, async (c) => {
    await c.query("select plant.record_instrument_check($1, 'PASS', 'DC-BAL-07 per-use check', $2::uuid)", [BALANCE, b.batchId]);
    await c.query("select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + interval '8 hours')", [BALANCE, b.batchId]);
  });
}

const tapAdvance = () => vi.advanceTimersByTime(7_000);
async function dispenser(batchId: string): Promise<RunDriver> {
  const d = new RunDriver(gmp, batchId, { operator1: await asPersonaInRole(gmp, 'operator1', 'DISPENSER', 'KIOSK-DISP-1') });
  d.beforeTap = tapAdvance;
  return d;
}

const calc = (lots: { lotCode: string }[]) => ({ type: 'RECORD_ENTRY' as const, stepKey: KEY, entry: { kind: 'POTENCY_CALCULATION' as const, lots } });
const weigh = (item: string, bomLine: string, lotCode: string, gross: string) => ({
  type: 'RECORD_ENTRY' as const,
  stepKey: KEY,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item, bomLine, lotCode, manual: { gross, tare: '1.000', unit: 'kg', deviceCode: BALANCE } },
});

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-tb01-ledger-'));
  const server = await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } });
  gmp = Object.assign(server, { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const db: TestDatabase = { name: gmp.database, admin: gmp.db.admin, app: gmp.db.app, drop: () => Promise.resolve() };
  const key = gmp.built.ctx.sealKey;
  if (!key) throw new Error('the GMP server has no seal key');
  const author = await actorOf(gmp, 'author');
  const checker = await actorOf(gmp, 'checker');
  const qa = await actorOf(gmp, 'approver');
  // The second QA person proposes market authorisations; the proposer cannot authorise (owner item 11, recipe-core 1889).
  const qa2 = await actorOf(gmp, 'approver2');
  const regulatory = await actorOf(gmp, 'regulatory');
  const issuer = await actorOf(gmp, 'issuer');
  world = new GmpWorld(db, { author, coAuthor: author, checker, checker2: checker, qa, qa2, regulatory, issuer }, key);
  const content = gmpContent();
  const v = await world.approvedVersion(content);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, BATCH_SIZE)], regulatoryBasis: 'IN: registration on file' });
  const steward = await actorOf(gmp, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `G-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: product, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
    reason('numbering rule for the test'),
  );
  familyId = v.familyId;
  gmpMbr = content;
  // The dispenser designation for operator1 (requested by the administrator, approved by the process owner).
  const grantId = await withCommand(gmp.db.app, await admin(), (c) => identity.requestRoleGrant(c, { accountId: personaIn(gmp, 'operator1').accountId, roleCode: 'DISPENSER', reason: 'TB-01 tests' }));
  await withCommand(gmp.db.app, await owner(), (c) => identity.decideRoleGrant(c, grantId, true, 'approved for the TB-01 tests'));
  // A balance of DISP-1 that no gateway serves: an active instrument of the room in the device registry.
  await identity.withGuardedCommand(gmp.db.app, await admin(), (c) =>
    c.query("select iam.register_device($1, 'INSTRUMENT', $2, 'DISP-1', null, $3, 'Balance 60 kg in DISP-1 (not interfaced)')", [BALANCE, SITE, createHash('sha256').update(`${BALANCE}:${randomUUID()}`).digest('hex')]),
  );
  await arrange(async (c) => {
    for (const l of LOTS) await registerLot(c, l);
    await c.query('insert into plant.product (code, name, highly_potent, recorded_by) values ($1, $1, false, gen_random_uuid())', [product]);
    await c.query("insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ('EQC-BAL-07', 'INSTRUMENT', 'Balance 60 kg', true, 'PER_USE', gen_random_uuid())");
    const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Balance 60 kg', 'EQC-BAL-07', 'INSTRUMENT', gen_random_uuid()) returning id", [BALANCE]);
    await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-BAL-07', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-BAL-07', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
  });
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

async function entries(batchId: string, kind: string): Promise<Json[]> {
  const { rows } = await gmp.db.admin.query<{ d: Json }>(
    "select e.value -> 'data' as d from recipe.execution_state s, jsonb_each(s.state -> 'entries') e where s.batch_id = $1 and e.value ->> 'kind' = $2 order by (e.value ->> 'recordedSeq')::numeric",
    [batchId, kind],
  );
  return rows.map((r) => r.d);
}

describe('TB-01 on the GMP installation (site lots, reservations, consumption)', () => {
  let b: { batchId: string; batchNumber: string };
  beforeAll(async () => {
    b = await issued();
    await prepareBatch(b);
  }, 300_000);

  it('[PR-18][IN-23] a quarantined lot of the site register is refused in the calculation; the released lot\'s approved result raises the active target and lowers the filler', async () => {
    const d = await dispenser(b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const q = await d.command('operator1', calc([{ lotCode: 'L26-0203' }]));
    expect(refusalOf(q)?.why).toMatch(/L26-0203 is quarantine.*TB01-LOT-STATUS/i);
    await d.ok('operator1', calc([{ lotCode: 'L26-0201' }]));
    const [data] = await entries(b.batchId, 'POTENCY_CALCULATION');
    expect(data?.['results']).toEqual([{ lot: 'L26-0201', asIsAssay: '98.5', baseEquivalent: '50', calculated: '50.761421', target: '50.762' }]);
    expect(data?.['excipient']).toMatchObject({ target: '8.639' });
  });

  it('[PR-19][DI-33] R10 #1, #2: after the calculation the step shows its result (lot, assay, as-is potency, each target), each dispensed box shows its target, and what is still to weigh counts against the potency targets', async () => {
    const d = await dispenser(b.batchId);
    const view = valueOf(await d.browser('operator1').call(routes.batches.step, { params: { batchId: b.batchId, stepKey: KEY } }));
    const p = view.potency;
    expect(p?.lots).toEqual([expect.objectContaining({ lotCode: 'L26-0201', asIs: '98.5', target: '50.762' })]);
    expect(p?.active).toMatchObject({ bomLine: 'BOM-PCM', target: '50.762', unit: 'kg' });
    expect(p?.excipient).toMatchObject({ bomLine: 'BOM-MCC', target: '8.639', unit: 'kg' });
    expect(p?.summary).toMatch(/Lot L26-0201: .*98\.5 % as is; .*50\.762 kg; .*8\.639 kg/);
    expect(view.entries.find((e) => e.kind === 'POTENCY_CALCULATION')?.summary).toBe(p?.summary);
    expect(p?.lots[0]?.changed).toBe(false);
    expect(view.fields.find((f) => f.item === 'tbApi')?.target?.value).toEqual({ kind: 'DECIMAL', value: '50.762', unit: 'kg' });
    expect(view.fields.find((f) => f.item === 'tbMcc')?.target?.value).toEqual({ kind: 'DECIMAL', value: '8.639', unit: 'kg' });
    const remaining = view.bomRemaining ?? [];
    expect(remaining.map((l) => [l.bomLine, l.basis, l.required, l.remaining])).toEqual([
      ['BOM-PCM', 'POTENCY', '50.762', '50.762'],
      ['BOM-MCC', 'POTENCY', '8.639', '8.639'],
    ]);
  });

  it('[INV-13][INV-14][PR-18][PR-20] the dispensed net is consumed from the batch\'s reservation in the same command and the entry names that consumption; the hand-keyed weighing needs a second person', async () => {
    const d = await dispenser(b.batchId);
    const before = (await gmp.db.admin.query<{ q: string }>('select site.lot_quantity($1)::text as q', [lotIds.get('L26-0201')])).rows[0]?.q;
    await d.ok('operator1', weigh('tbApi', 'BOM-PCM', 'L26-0201', '51.762'));
    await d.ok('operator1', weigh('tbMcc', 'BOM-MCC', 'L26-0301', '9.639'));
    const [api, mcc] = await entries(b.batchId, 'CONTAINER_WEIGHING');
    const { rows } = await gmp.db.admin.query<{ id: string; lot: string; batch: string; quantity: string; unit: string; markets: string[] }>(
      'select c.id::text, l.lot_code as lot, c.batch_number as batch, c.quantity::text, c.unit, c.market_set as markets from site.lot_consumption c join site.material_lot l on l.id = c.lot_id where c.batch_id = $1 order by c.consumed_at',
      [b.batchId],
    );
    expect(rows.map((r) => [r.id, r.lot, r.batch, r.quantity, r.unit])).toEqual([
      [api?.['consumption'], 'L26-0201', b.batchNumber, '50.762', 'kg'],
      [mcc?.['consumption'], 'L26-0301', b.batchNumber, '8.639', 'kg'],
    ]);
    const after = (await gmp.db.admin.query<{ q: string }>('select site.lot_quantity($1)::text as q', [lotIds.get('L26-0201')])).rows[0]?.q;
    expect(Number(before) - Number(after)).toBeCloseTo(50.762, 6);
    const { rows: st } = await gmp.db.admin.query<{ v: boolean }>("select (state -> 'steps' -> $2 ->> 'verificationRequired')::boolean as v from recipe.execution_state where batch_id = $1", [b.batchId, KEY]);
    expect(st[0]?.v).toBe(true);
  });

  it('[INV-13][INV-14] past the server, a GMP weighing that names no consumption, or a consumption of another quantity, is refused by the database', async () => {
    const run = await runContext(gmp.db.admin, b.batchId);
    const facts = (await gmp.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['L26-0201', b.batchId])).rows[0]?.f ?? {};
    const lot = { id: 'L26-0201', material: 'MAT-PCM', status: 'RELEASED', expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'], identityTested: true };
    const attempt = async (n: number, consume: boolean, quantity: string) => {
      const browser = (await dispenser(b.batchId)).browser('operator1');
      vi.advanceTimersByTime(7_000);
      return messageOf(
        withCommand(gmp.db.app, await actorOfBrowser(gmp, browser, 'operator1'), async (c) => {
          let consumption: string | undefined;
          if (consume) {
            const res = (await c.query<{ r: Json }>('select tab.tb01_reservation_for($1::uuid, $2, $3::numeric, $4) as r', [b.batchId, 'L26-0201', quantity, 'kg'])).rows[0]?.r ?? {};
            consumption = String((await c.query<{ r: Json }>('select recipe.consume_lot($1::uuid, $2::uuid, $3, $4::numeric, $5) as r', [b.batchId, res['reservationId'], 'MAT-PCM', quantity, 'kg'])).rows[0]?.r['consumption_id']);
          }
          const tx = await execution.ExecutionTx.open(c, run.def, b.batchId);
          const roles = await engineRoles(c);
          const actor = engineActor(personaIn(gmp, 'operator1').personId, roles);
          const entry = { kind: 'CONTAINER_WEIGHING', item: 'tbApi', bomLine: 'BOM-PCM', container: `${b.batchNumber}/C9${n}`, lot, gross: '1.100', tare: '1.000', unit: 'kg', balance: BALANCE, source: 'MANUAL', ...(consumption ? { consumption } : {}) };
          const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step: STEP, context: [], entry };
          return appendAs(tx, command, engineResult(tx, command), roles);
        }),
      );
    };
    expect(await attempt(1, false, '0.100')).toMatch(/names no consumption of lot L26-0201.*TB01-CONSUMPTION.*EBMR-EXE-240/s);
    expect(await attempt(2, true, '0.200')).toMatch(/names a consumption of 0\.200 kg, not of its net 0\.100 kg.*EBMR-EXE-240/s);
    expect(await attempt(3, true, '0.100')).toBe('ok');
  });

  it('[PR-19][DI-33][DI-37] on GMP the lot assay comes only from approved LIMS-lite results of that lot, copied, never typed; a revision of the result drops it', async () => {
    const lot = lotIds.get('L26-0202') ?? '';
    const qc = async () => ({ ...(await openPersonaSession(gmp.db, gmp.seed, 'qcAnalyst')), correlationId: randomUUID() });
    const record = async (result: Record<string, unknown>, why: string | null = 'Assay result reissued from LIMS') =>
      withCommand(gmp.db.app, await qc(), (c) => c.query('select tab.record_lot_assay($1, $2, $3::jsonb, $4) as id', ['L26-0202', SITE, JSON.stringify(result), why]));
    const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => /\[(EBMR-[A-Z]+-\d{3})\]|^(EBMR-[A-Z]+-\d{3})/.exec(e instanceof Error ? e.message : String(e))?.slice(1).find(Boolean) ?? String(e));
    // A typed value is refused on GMP.
    expect(await codeOf(record({ basis: 'AS_IS', assay: '99.9', certificateRef: 'COA-TYPED' }))).toBe('EBMR-EXE-606');
    // LIMS results: one not approved, one failing, one of another test, one of another lot; then an approved passing one.
    const lims = async (lotId: string, test: string, value: string, approved: boolean): Promise<string> => {
      let id = '';
      await arrange(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          "insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, recorded_by_person, recorded_by_account, correlation_id) values ($1, $2, 'STP-01', 'RELEASE', $3::numeric, '%', 98.0, 102.0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id",
          [lotId, test, value],
        );
        id = rows[0]?.id ?? '';
        if (approved) await c.query('insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [id]);
      });
      return id;
    };
    for (const id of [await lims(lot, 'ASSAY', '99.6', false), await lims(lot, 'ASSAY', '97.0', true), await lims(lot, 'WATER', '99.6', true), await lims(lotIds.get('L26-0201') ?? '', 'ASSAY', '99.6', true)]) {
      expect(await codeOf(record({ basis: 'AS_IS', assayResultId: id, certificateRef: 'LIMS-0202' }))).toBe('EBMR-EXE-606');
    }
    const good = await lims(lot, 'ASSAY', '99.60', true);
    expect(await codeOf(record({ basis: 'AS_IS', assayResultId: good, certificateRef: 'LIMS-0202' }))).toBe('ok');
    const batch = await issued();
    const readFor = async () => (await gmp.db.app.query<{ r: Record<string, string> | null }>('select tab.lot_assay_of($1, $2) as r', ['L26-0202', batch.batchId])).rows[0]?.r ?? null;
    expect(await readFor()).toMatchObject({ basis: 'AS_IS', assay: '99.6' });
    // A revision of the LIMS result drops its approval, and the assay is no longer read until QC records it again.
    await arrange(async (c) => {
      await c.query(
        "insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, revises, revision_reason, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'ASSAY', 'STP-01', 'RELEASE', 99.1, '%', 98.0, 102.0, $2, 'integration corrected', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        [lot, good],
      );
    });
    expect(await readFor()).toBeNull();
    expect(await gmp.db.app.query("insert into tab.lot_assay_source (assay_result_id, value_kind, lims_result_id) values (gen_random_uuid(), 'assay', $1)", [good]).then(() => 'ok', (e: unknown) => String(e))).toMatch(/permission denied/);
  });
});

describe('G-07 on the GMP installation (slice 6d: every dispensed lot is consumed, tablets 1093)', () => {
  let b: { batchId: string; batchNumber: string };
  beforeAll(async () => {
    b = await issued();
    await prepareBatch(b);
  }, 300_000);

  const consumptions = async () =>
    (
      await gmp.db.admin.query<{ lot: string; batch: string; quantity: string; unit: string }>(
        'select l.lot_code as lot, c.batch_number as batch, c.quantity::text, c.unit from site.lot_consumption c join site.material_lot l on l.id = c.lot_id where c.batch_id = $1 order by c.consumed_at',
        [b.batchId],
      )
    ).rows.map((r) => [r.lot, r.batch, r.quantity, r.unit]);

  it('[PR-19][DI-33][DI-37] slice 7q (C2): on GMP an enzyme activity comes from an approved, passing ACTIVITY result of the lot in U/mg; a percent result, an activity in another unit or an activity on a percent basis is refused', async () => {
    const lot = lotIds.get('L26-0202') ?? '';
    const qc = async () => ({ ...(await openPersonaSession(gmp.db, gmp.seed, 'qcAnalyst')), correlationId: randomUUID() });
    const record = async (result: Record<string, unknown>) =>
      withCommand(gmp.db.app, await qc(), (c) => c.query('select tab.record_lot_assay($1, $2, $3::jsonb, $4) as id', ['L26-0202', SITE, JSON.stringify(result), 'Enzyme activity from LIMS']));
    const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => /\[(EBMR-[A-Z]+-\d{3})\]|^(EBMR-[A-Z]+-\d{3})/.exec(e instanceof Error ? e.message : String(e))?.slice(1).find(Boolean) ?? String(e));
    const lims = async (test: string, value: string, unit: string, opts: { approved?: boolean; lotId?: string } = {}): Promise<string> => {
      let id = '';
      await arrange(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          "insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, recorded_by_person, recorded_by_account, correlation_id) values ($1, $2, 'STP-ENZ-01', 'RELEASE', $3::numeric, $4, 90, 2000, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id",
          [opts.lotId ?? lot, test, value, unit],
        );
        id = rows[0]?.id ?? '';
        if (opts.approved !== false) await c.query('insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [id]);
      });
      return id;
    };
    // Review P7Q-4: an ACTIVITY result not approved, one that fails its limits, and one of another lot are refused.
    for (const id of [await lims('ACTIVITY', '1250', 'U/mg', { approved: false }), await lims('ACTIVITY', '50', 'U/mg'), await lims('ACTIVITY', '1250', 'U/mg', { lotId: lotIds.get('L26-0201') ?? '' })]) {
      expect(await codeOf(record({ basis: 'ACTIVITY', assayResultId: id, certificateRef: 'LIMS-ENZ' }))).toBe('EBMR-EXE-606');
    }
    const percent = await lims('ASSAY', '99.5', '%');
    const perGram = await lims('ACTIVITY', '1250', 'U/g');
    const activity = await lims('ACTIVITY', '1250', 'U/mg');
    expect(await codeOf(record({ basis: 'ACTIVITY', assayResultId: percent, certificateRef: 'LIMS-ENZ' }))).toBe('EBMR-EXE-606');
    expect(await codeOf(record({ basis: 'ACTIVITY', assayResultId: perGram, certificateRef: 'LIMS-ENZ' }))).toBe('EBMR-EXE-606');
    expect(await codeOf(record({ basis: 'AS_IS', assayResultId: activity, certificateRef: 'LIMS-ENZ' }))).toBe('EBMR-EXE-606');
    expect(await codeOf(record({ basis: 'ACTIVITY', assay: '1250', certificateRef: 'COA-TYPED' }))).toBe('EBMR-EXE-606');
    expect(await codeOf(record({ basis: 'ACTIVITY', assayResultId: activity, certificateRef: 'LIMS-ENZ' }))).toBe('ok');
    const batch = await issued();
    const read = (await gmp.db.app.query<{ r: Record<string, string> | null }>('select tab.lot_assay_of($1, $2) as r', ['L26-0202', batch.batchId])).rows[0]?.r ?? null;
    expect(read).toMatchObject({ basis: 'ACTIVITY', assay: '1250' });
  });

  it('[INV-13][INV-14][PR-57][DI-20][DI-30] a G-07 weighing of a site lot on GMP is consumed from the batch\'s reservation in the same command, so the genealogy holds the lot; keyed with no balance named, it records the room\'s one booked balance and says the balance was inferred (P7L-1)', async () => {
    const d = await dispenser(b.batchId);
    // Test arrangement: the balance stands in DISP-1 (the room of the kiosk), so it is the room's one instrument booked for the batch.
    const setup = await gmp.db.admin.connect();
    try {
      await setup.query('begin');
      await setup.query("set local session_replication_role = 'replica'");
      await setup.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ('DISP-1', 'ROOM', 'Dispensing booth', false, true, gen_random_uuid()) on conflict (code) do nothing");
      await setup.query("update plant.equipment set area_id = (select id from plant.area where code = 'DISP-1') where code = $1", [BALANCE]);
      await setup.query('commit');
    } finally {
      setup.release();
    }
    await d.ok('operator1', { type: 'START_STEP', stepKey: G07_KEY });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: G07_KEY, entry: { kind: 'CONTAINER_WEIGHING', item: 'g07Mgs', bomLine: 'BOM-MGS', lotCode: 'L26-0401', manual: { gross: '1.600', tare: '1.000', unit: 'kg' } } });
    expect(await consumptions()).toEqual([['L26-0401', b.batchNumber, '0.600', 'kg']]);
    const { rows } = await gmp.db.admin.query<{ entry: Json; manual: Json }>(
      "select r.command -> 'entry' as entry, r.evidence -> 'manual' as manual from recipe.execution_command r where r.batch_id = $1 and r.evidence ? 'manual' order by r.seq desc limit 1",
      [b.batchId],
    );
    expect({ balance: rows[0]?.entry['balance'], declared: rows[0]?.manual['declaredBalance'], inferred: rows[0]?.manual['balanceInferred'] }).toEqual({ balance: BALANCE, declared: null, inferred: true });
    // The step screen (and the record built from it) says the balance was not named.
    expect((await d.stepView('operator1', G07_KEY)).entries.at(-1)?.summary).toContain(`on ${BALANCE}, keyed by hand (balance not named: the room's one balance booked for the batch)`);
  });

  it('[INV-13][INV-14][PR-57] past the server, a GMP G-07 weighing of a lot without its consumption, or with a consumption of another quantity, is refused by the database (EBMR-TAB-391)', async () => {
    const run = await runContext(gmp.db.admin, b.batchId);
    const facts = (await gmp.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['L26-0401', b.batchId])).rows[0]?.f ?? {};
    const lot = { id: 'L26-0401', material: 'MAT-MGS', status: 'RELEASED', expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'], identityTested: true };
    const attempt = async (n: number, consume: string | null) => {
      const browser = (await dispenser(b.batchId)).browser('operator1');
      vi.advanceTimersByTime(7_000);
      return messageOf(
        withCommand(gmp.db.app, await actorOfBrowser(gmp, browser, 'operator1'), async (c) => {
          if (consume) {
            const res = (await c.query<{ r: Json }>('select tab.tb01_reservation_for($1::uuid, $2, $3::numeric, $4) as r', [b.batchId, 'L26-0401', consume, 'kg'])).rows[0]?.r ?? {};
            await c.query('select recipe.consume_lot($1::uuid, $2::uuid, $3, $4::numeric, $5) as r', [b.batchId, res['reservationId'], 'MAT-MGS', consume, 'kg']);
          }
          const tx = await execution.ExecutionTx.open(c, run.def, b.batchId);
          const roles = await engineRoles(c);
          const actor = engineActor(personaIn(gmp, 'operator1').personId, roles);
          const entry = { kind: 'CONTAINER_WEIGHING', item: 'g07Mgs', bomLine: 'BOM-MGS', container: `${b.batchNumber}/C8${n}`, lot, gross: '1.010', tare: '1.000', unit: 'kg', balance: BALANCE, source: 'MANUAL' };
          const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step: G07_STEP, context: [], entry };
          return appendAs(tx, command, engineResult(tx, command), roles);
        }),
      );
    };
    expect(await attempt(1, null)).toMatch(/consumed no such quantity of that lot.*G07-CONSUMPTION.*EBMR-TAB-391/s);
    expect(await attempt(2, '0.020')).toMatch(/G07-CONSUMPTION.*EBMR-TAB-391/s);
    expect(await attempt(3, '0.010')).toBe('ok');
  });
});

describe('a weighing that uses up a whole lot on GMP: the entry guard judges the lot as it stood before the command (EBMR-EXE-078; tablets 1903)', () => {
  let b: { batchId: string; batchNumber: string };
  const WHOLE: { code: string; material: string; days: number; state: string; quantity: string; reserve: boolean }[] = [
    // First to expire of their materials, so stock rotation picks them without a reason (PR-18).
    { code: 'L26-0302', material: 'MAT-MCC', days: 600, state: 'RELEASED', quantity: '8.639', reserve: true },
    { code: 'L26-0402', material: 'MAT-MGS', days: 600, state: 'RELEASED', quantity: '0.600', reserve: true },
    { code: 'L26-0403', material: 'MAT-MGS', days: 600, state: 'REJECTED', quantity: '5', reserve: false },
    { code: 'L26-0404', material: 'MAT-MGS', days: 650, state: 'RELEASED', quantity: '0.010', reserve: true },
    { code: 'L26-0405', material: 'MAT-MGS', days: 660, state: 'QUARANTINE', quantity: '5', reserve: false },
    { code: 'L26-0406', material: 'MAT-MGS', days: 670, state: 'RELEASED', quantity: '0.020', reserve: true },
  ];
  beforeAll(async () => {
    b = await issued();
    await prepareBatch(b);
    await arrange(async (c) => {
      for (const l of WHOLE) {
        await registerLot(c, l);
        // The lot's creation in its state history, so its CONSUME transition continues it.
        await c.query(
          `insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, to_state, to_version, person_id, account_id, role_code, correlation_id)
           values ('material_lot', $1, 'material_lot', 1, $2, 1, 'TEST_SETUP', 'TEST_SETUP', 'TEST_SETUP', gen_random_uuid())`,
          [lotIds.get(l.code), l.state],
        );
        if (!l.reserve) continue;
        await c.query(
          `insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
           values ($1, $2, $3, 'TABLETS', 60, 'kg', clock_timestamp() + interval '2 days', 1, gen_random_uuid(), gen_random_uuid())`,
          [lotIds.get(l.code), b.batchId, b.batchNumber],
        );
      }
    });
  }, 300_000);

  /** The lot's state, what is left of it, and its consumptions into the batch. */
  const lotEnd = async (code: string) => {
    const id = lotIds.get(code);
    const { rows } = await gmp.db.admin.query<{ state: string; left: string }>('select site.lot_state($1) as state, site.lot_quantity($1)::text as left', [id]);
    const { rows: used } = await gmp.db.admin.query<{ id: string; quantity: string; unit: string }>(
      'select c.id::text, c.quantity::text, c.unit from site.lot_consumption c where c.lot_id = $1 and c.batch_id = $2 order by c.consumed_at',
      [id, b.batchId],
    );
    return { state: rows[0]?.state, left: Number(rows[0]?.left), consumed: used.map((u) => [u.id, u.quantity, u.unit]) };
  };

  it('[INV-13][INV-14][PR-18][DI-05] TB-01 dispensing the whole of a released lot is accepted: the lot is consumed in full in the same command and ends CONSUMED', async () => {
    const d = await dispenser(b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await d.ok('operator1', calc([{ lotCode: 'L26-0201' }]));
    await d.ok('operator1', weigh('tbMcc', 'BOM-MCC', 'L26-0302', '9.639'));
    const [mcc] = await entries(b.batchId, 'CONTAINER_WEIGHING');
    expect(mcc?.['lot']).toMatchObject({ id: 'L26-0302', status: 'RELEASED' });
    expect(await lotEnd('L26-0302')).toEqual({ state: 'CONSUMED', left: 0, consumed: [[mcc?.['consumption'], '8.639', 'kg']] });
  });

  it('[INV-13][INV-14][PR-57][PR-18][DI-05] G-07 dispensing the whole of a released lot is accepted: the lot is consumed in full in the same command and ends CONSUMED', async () => {
    const d = await dispenser(b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: G07_KEY });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: G07_KEY, entry: { kind: 'CONTAINER_WEIGHING', item: 'g07Mgs', bomLine: 'BOM-MGS', lotCode: 'L26-0402', manual: { gross: '1.600', tare: '1.000', unit: 'kg', deviceCode: BALANCE } } });
    const end = await lotEnd('L26-0402');
    expect({ ...end, consumed: end.consumed.map(([, q, u]) => [q, u]) }).toEqual({ state: 'CONSUMED', left: 0, consumed: [['0.600', 'kg']] });
  });

  it('[INV-13][INV-14][PR-57][PR-18][DI-05] G-07 weighing part of a lot in one entry and the rest in a second: both are accepted, each consumed in its own command, and the lot ends CONSUMED', async () => {
    const d = await dispenser(b.batchId);
    const part = (gross: string) => d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: G07_KEY, entry: { kind: 'CONTAINER_WEIGHING', item: 'g07Mgs', bomLine: 'BOM-MGS', lotCode: 'L26-0406', manual: { gross, tare: '1.000', unit: 'kg', deviceCode: BALANCE } } });
    await part('1.012');
    expect(await lotEnd('L26-0406')).toMatchObject({ state: 'RELEASED', left: 0.008 });
    await part('1.008');
    const end = await lotEnd('L26-0406');
    expect({ ...end, consumed: end.consumed.map(([, q, u]) => [q, u]) }).toEqual({ state: 'CONSUMED', left: 0, consumed: [['0.012', 'kg'], ['0.008', 'kg']] });
  });

  it('[INV-13][INV-14][PR-18][DI-05] past the server, a lot already consumed, rejected or in quarantine before the command is still refused (EBMR-EXE-078); a lot this command uses up passes only with the facts it had before the command', async () => {
    const run = await runContext(gmp.db.admin, b.batchId);
    const factsOf = async (code: string) => (await gmp.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', [code, b.batchId])).rows[0]?.f ?? {};
    const attempt = async (n: number, code: string, lotFacts: Json, consume: string | null) => {
      const browser = (await dispenser(b.batchId)).browser('operator1');
      vi.advanceTimersByTime(7_000);
      return messageOf(
        withCommand(gmp.db.app, await actorOfBrowser(gmp, browser, 'operator1'), async (c) => {
          if (consume) {
            const res = (await c.query<{ r: Json }>('select tab.tb01_reservation_for($1::uuid, $2, $3::numeric, $4) as r', [b.batchId, code, consume, 'kg'])).rows[0]?.r ?? {};
            await c.query('select recipe.consume_lot($1::uuid, $2::uuid, $3, $4::numeric, $5) as r', [b.batchId, res['reservationId'], 'MAT-MGS', consume, 'kg']);
          }
          const tx = await execution.ExecutionTx.open(c, run.def, b.batchId);
          const roles = await engineRoles(c);
          const actor = engineActor(personaIn(gmp, 'operator1').personId, roles);
          const entry = { kind: 'CONTAINER_WEIGHING', item: 'g07Mgs', bomLine: 'BOM-MGS', container: `${b.batchNumber}/C7${n}`, lot: lotFacts, gross: '1.010', tare: '1.000', unit: 'kg', balance: BALANCE, source: 'MANUAL' };
          const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step: G07_STEP, context: [], entry };
          return appendAs(tx, command, engineResult(tx, command), roles);
        }),
      );
    };
    const released = (code: string, f: Json) => ({ id: code, material: 'MAT-MGS', status: 'RELEASED', expiresAtUs: f['expiresAtUs'], retestAtUs: f['retestAtUs'], identityTested: true });
    // Consumed by an earlier command (the G-07 test above): the register reads it as REJECTED, and it stays refused.
    const consumed = await factsOf('L26-0402');
    expect(consumed['status']).toBe('REJECTED');
    expect(await attempt(1, 'L26-0402', released('L26-0402', consumed), null)).toMatch(/lot L26-0402 states other facts than the lot register holds.*EBMR-EXE-078/s);
    // Rejected before the command.
    expect(await attempt(2, 'L26-0403', released('L26-0403', await factsOf('L26-0403')), null)).toMatch(/lot L26-0403 states other facts than the lot register holds.*EBMR-EXE-078/s);
    // In quarantine before the command (lead audit of #153): refused.
    expect(await attempt(5, 'L26-0405', released('L26-0405', await factsOf('L26-0405')), null)).toMatch(/lot L26-0405 states other facts than the lot register holds.*EBMR-EXE-078/s);
    // Used up by this command, but the entry states another expiry (a day later) than the lot had: refused.
    const whole = await factsOf('L26-0404');
    expect(await attempt(3, 'L26-0404', { ...released('L26-0404', whole), expiresAtUs: String(BigInt(String(whole['expiresAtUs'])) + 86_400_000_000n) }, '0.010')).toMatch(/lot L26-0404 states other facts than the lot register holds.*EBMR-EXE-078/s);
    // Used up by this command, with the facts it had before the command: accepted, and the lot ends CONSUMED.
    expect(await attempt(4, 'L26-0404', released('L26-0404', whole), '0.010')).toBe('ok');
    expect((await lotEnd('L26-0404')).state).toBe('CONSUMED');
  });
});

describe('consumption into a running batch only, named by an entry of its command; reservations end with the batch (exit review HIGH-4; recipe-core 0700)', () => {
  const quantityOf = async (code: string): Promise<string> => (await gmp.db.admin.query<{ q: string }>('select site.lot_quantity($1)::text as q', [lotIds.get(code)])).rows[0]?.q ?? '';

  it('[INV-13][INV-14] past the server, a GMP consumption that no entry of its command names is refused when the command commits; the lot keeps its stock', async () => {
    const b2 = await issued();
    await prepareBatch(b2);
    const before = await quantityOf('L26-0301');
    const browser = (await dispenser(b2.batchId)).browser('operator1');
    const orphan = await messageOf(
      withCommand(gmp.db.app, await actorOfRun(gmp, browser, 'operator1'), async (c) => {
        const res = (await c.query<{ r: Json }>('select tab.tb01_reservation_for($1::uuid, $2, $3::numeric, $4) as r', [b2.batchId, 'L26-0301', '0.500', 'kg'])).rows[0]?.r ?? {};
        await c.query('select recipe.consume_lot($1::uuid, $2::uuid, $3, $4::numeric, $5) as r', [b2.batchId, res['reservationId'], 'MAT-MCC', '0.500', 'kg']);
      }),
    );
    expect(orphan).toMatch(/EBMR-RCP-433/);
    expect(await quantityOf('L26-0301')).toBe(before);
  });

  it('[INV-13][INV-14] a batch cancelled before it started revokes its open reservations (BATCH_ENDED), and nothing is consumed into it afterwards', async () => {
    const b3 = await issued();
    await prepareBatch(b3);
    const reservations = async (): Promise<string[]> =>
      (await gmp.db.admin.query<{ k: string | null }>(
        'select x.kind as k from site.lot_reservation r left join site.lot_reservation_revocation x on x.reservation_id = r.id where r.batch_id = $1 order by r.id',
        [b3.batchId],
      )).rows.map((r) => r.k ?? 'OPEN');
    expect(await reservations()).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN']);
    const supervisor = await gmp.asPersona('supervisor1');
    const version = (await gmp.db.admin.query<{ v: string }>("select state ->> 'version' as v from recipe.execution_state where batch_id = $1", [b3.batchId])).rows[0]?.v;
    const pending = await prepareSignature(gmp, supervisor, 'supervisor1', 'batch_record', `${b3.batchId}:record@${version}`, 'BATCH_CANCELLED');
    await withCommand(gmp.db.app, await pending.actor(), async (c) => {
      const signatureId = await pending.sign(c);
      const run = await runContext(gmp.db.admin, b3.batchId);
      const tx = await execution.ExecutionTx.open(c, run.def, b3.batchId);
      const roles = await engineRoles(c);
      const actor = engineActor(personaIn(gmp, 'supervisor1').personId, roles);
      const r = await tx.command({ type: 'CANCEL_BATCH', commandId: randomUUID(), actor, reason: 'The order was withdrawn by planning', signature: { id: signatureId, meaning: 'BATCH_CANCELLED', signer: actor.id } }, roles);
      if (!r.accepted) throw new Error(`SETUP: the cancel was refused: ${JSON.stringify(r.refusal)}`);
    });
    expect(await reservations()).toEqual(['BATCH_ENDED', 'BATCH_ENDED', 'BATCH_ENDED', 'BATCH_ENDED']);
    const browser = (await dispenser(b3.batchId)).browser('operator1');
    const late = await messageOf(
      withCommand(gmp.db.app, await actorOfRun(gmp, browser, 'operator1'), async (c) => {
        const res = (await c.query<{ id: string }>('select id::text from site.lot_reservation where batch_id = $1 and lot_id = $2', [b3.batchId, lotIds.get('L26-0301')])).rows[0]?.id;
        await c.query('select recipe.consume_lot($1::uuid, $2::uuid, $3, $4::numeric, $5) as r', [b3.batchId, res, 'MAT-MCC', '0.500', 'kg']);
      }),
    );
    expect(late).toMatch(/EBMR-RCP-432/);
  });
});

describe('R13: the potency before dispensing (lot view, preview, a QC change and the recalculation)', () => {
  let b: { batchId: string; batchNumber: string };
  beforeAll(async () => {
    b = await issued();
    await prepareBatch(b);
  }, 300_000);

  const lotView = async () => valueOf(await (await gmp.asPersona('qcAnalyst')).call(routes.execution.lotQuality, { params: { code: 'L26-0201' } }));
  const preview = async () => valueOf(await (await gmp.asPersona('issuer')).call(routes.batches.potencyPreview, { params: { batchId: b.batchId }, query: {} }));
  const stepView = async (d: RunDriver) => valueOf(await d.browser('operator1').call(routes.batches.step, { params: { batchId: b.batchId, stepKey: KEY } }));

  it('[PR-19][DI-33] the lot shows its as-is potency, the approved results it came from and its history; the batch previews the targets of its reserved lots without recording anything', async () => {
    const lot = await lotView();
    expect(lot.assay).toMatchObject({ basis: 'AS_IS', assay: '98.5', asIs: '98.5', usable: true });
    expect(lot.assay?.sources?.map((s) => [s.value, s.testCode, s.state])).toEqual([['assay', 'ASSAY', 'APPROVED']]);
    expect(lot.history?.map((h) => [h.assay, h.current, h.reason])).toEqual([['98.5', true, null]]);
    const p = await preview();
    const step = p.steps.find((s) => s.stepId === STEP);
    expect(step?.lots.find((l) => l.lotCode === 'L26-0201')).toMatchObject({ reserved: true, asIs: '98.5', activeTarget: '50.762', excipientTarget: '8.639', problem: null });
    expect(p.note).toMatch(/^Preview: the weighing step recalculates/);
    const { rows } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.execution_state s, jsonb_each(s.state -> 'entries') e where s.batch_id = $1", [b.batchId]);
    expect(rows[0]?.n).toBe('0');
  });

  it('[PR-19][DI-33][DI-22] after QC changes the potency by an approved result with a reason, the calculated step says so, the preview follows, and the recalculation is an exception for QA', async () => {
    const d = await dispenser(b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await d.ok('operator1', calc([{ lotCode: 'L26-0201' }]));
    expect((await stepView(d)).potency?.lots[0]?.changed).toBe(false);
    let resultId = '';
    await arrange(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'ASSAY', 'STP-01', 'RETEST', 99.0, '%', 98.0, 102.0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id",
        [lotIds.get('L26-0201')],
      );
      resultId = rows[0]?.id ?? '';
      await c.query('insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [resultId]);
    });
    const qc = await gmp.asPersona('qcAnalyst');
    valueOf(await qc.call(routes.execution.recordLotAssay, { params: { code: 'L26-0201' }, body: { basis: 'AS_IS', assayResultId: resultId, certificateRef: 'LIMS-RETEST-0201', reason: 'Re-assay at retest' } }));
    const lot = await lotView();
    expect(lot.assay).toMatchObject({ assay: '99', asIs: '99' });
    expect(lot.history?.map((h) => [h.assay, h.current, h.reason])).toEqual([['99', true, 'Re-assay at retest'], ['98.5', false, null]]);
    expect((await stepView(d)).potency?.lots[0]?.changed).toBe(true);
    const target = (await preview()).steps.find((s) => s.stepId === STEP)?.lots.find((l) => l.lotCode === 'L26-0201')?.activeTarget;
    expect(target).not.toBe('50.762');
    await d.ok('operator1', calc([{ lotCode: 'L26-0201' }]));
    const after = await stepView(d);
    expect(after.potency?.lots[0]).toMatchObject({ changed: false, asIs: '99', target });
    expect(after.exceptions.filter((e) => e.type === 'POTENCY_RECALCULATED').map((e) => [e.severity, e.title])).toEqual([['ALERT', expect.stringMatching(/L26-0201 98\.5 % before, L26-0201 99 % now/) as unknown]]);
  });
});

describe('the lots reserved for the batch on a GMP weighing step (owner retest 13 November 2026, item 7)', () => {
  it('[INV-13][INV-14] before any weighing the step lists, per dispensed line, the lots with an open reservation for this batch and what is left; a line with none is listed empty', async () => {
    const b4 = await issued();
    let d = await dispenser(b4.batchId);
    const view = async (key: string) => valueOf(await d.browser('operator1').call(routes.batches.step, { params: { batchId: b4.batchId, stepKey: key } }));
    // Nothing reserved yet: every line of both weighing steps is listed with no lot (the first weighing would be EBMR-EXE-245).
    expect((await view(G07_KEY)).reservations).toEqual([{ bomLine: 'BOM-MGS', material: expect.stringContaining('MAT-MGS'), lots: [] }]);
    expect((await view(KEY)).reservations?.map((l) => [l.bomLine, l.lots])).toEqual([
      ['BOM-PCM', []],
      ['BOM-MCC', []],
    ]);
    await prepareBatch(b4);
    d = await dispenser(b4.batchId);
    // A cancelled reservation is not offered.
    await arrange(async (c) => {
      const r = (await c.query<{ id: string }>('select id::text from site.lot_reservation where batch_id = $1 and lot_id = $2', [b4.batchId, lotIds.get('L26-0202')])).rows[0]?.id;
      await c.query("insert into site.lot_reservation_revocation (reservation_id, kind, cause, reason_text, revoked_by_person, revoked_by_account) values ($1, 'CANCELLED', 'test', 'not needed', gen_random_uuid(), gen_random_uuid())", [r]);
    });
    expect((await view(G07_KEY)).reservations).toEqual([{ bomLine: 'BOM-MGS', material: expect.stringContaining('MAT-MGS'), lots: [{ lotCode: 'L26-0401', remaining: '60', unit: 'kg' }] }]);
    expect((await view(KEY)).reservations?.map((l) => [l.bomLine, l.lots.map((x) => x.lotCode)])).toEqual([
      ['BOM-PCM', ['L26-0201']],
      ['BOM-MCC', ['L26-0301']],
    ]);
  });
});
