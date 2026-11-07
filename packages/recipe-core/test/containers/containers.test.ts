/**
 * Output containers (recipe-core sql/0420-0422; outline 5.2.9 "Output containers", L-30; TB-11 bracketing hold; IN-21
 * identification; IN-26 (c) charge scan). Every command runs as the application role inside a validated command; the
 * bypass tests attack the tables and the state engine directly as the application role.
 *
 * Batches: recipe.batch_execution rows are arranged by the superuser with triggers off (asTimeTraveller), as test setup
 * only; nothing about batch issue is under test here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCode } from '../../../kernel/src/commands/errors.ts';
import { asTimeTraveller, challengeFor, expectPermissionDenied, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as oc from '../../src/containers/index.ts';
import * as plant from '../../src/plant/index.ts';

let db: TestDatabase;
let operator: SeededActor;
let qa: SeededActor;
let qaReviewer: SeededActor;
let steward: SeededActor;
let verifier: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator' });
  verifier = await seedActor(db, { roleCode: 'VERIFIER', legalName: 'Vera Verifier' });
  qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Qamar QA' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Sana Steward' });
}, 180_000);
afterAll(async () => {
  await db.drop();
});

// ---------------------------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------------------------

let serial = 0;
interface Batch {
  id: string;
  number: string;
}

/** A batch of product ATV-40 (40 mg), arranged directly (setup only). */
async function newBatch(product = { code: 'ATV-40', name: 'Atorvastatin tablets', strength: '40 mg' }): Promise<Batch> {
  const id = randomUUID();
  const number = `TEST-${randomUUID().slice(0, 8).toUpperCase()}${serial++}`;
  const hash = createHash('sha256').update(id).digest('hex');
  await asTimeTraveller(
    db,
    `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                      revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
     values ($1, $1 || '.json', '{}', '{}', $1, gen_random_uuid(), 'FAM', $2::jsonb, gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [hash, JSON.stringify(product)],
  );
  await asTimeTraveller(
    db,
    `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                         policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                         issued_by_account, correlation_id)
     values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
             gen_random_uuid(), gen_random_uuid())`,
    [id, number, hash],
  );
  return { id, number };
}

/** Refused with the database code (EBMR-CNT-NNN or a kernel code) wherever the message carries it. */
async function expectRefused(p: Promise<unknown>, code: string, fragment?: string | RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected refusal ${code}`).toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(errorCode(caught) ?? message, message).toBe(code);
  if (fragment) expect(message).toMatch(fragment);
}

const why = (text: string) => ({ reasonCode: 'TEST', reasonText: text });

function open(batch: Batch, press?: string, stream?: string, stage = 'COMPRESSION'): Promise<oc.ContainerRef> {
  return run(db, operator, (c) => oc.openContainer(c, { batchId: batch.id, stage, unit: 'kg', ...(press ? { pressCode: press } : {}), ...(stream ? { stream } : {}) }));
}
/** Closes with a typed net and, unless `verify` is false, has the second person verify it (sql/0740, DI-30). */
async function close(ref: oc.ContainerRef, qty = '12.500', verify = true): Promise<oc.ContainerRef> {
  const closed = await run(db, operator, (c) => oc.closeContainer(c, ref.containerId, qty, ref.version));
  if (verify) await verifyNet(verifier, closed);
  return closed;
}
async function verifyNet(who: SeededActor, ref: oc.ContainerRef): Promise<void> {
  const ch = await challengeFor(db, who, ref.containerId, { meaning: oc.CONTAINER_NET_VERIFY_MEANING, aggregateType: 'output_container' });
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  const sig = (await signWith(db, who, ch.challengeId, ev, { expectedState: (await status(ref)).state })).signatureId;
  await run(db, who, (c) => oc.verifyContainerClose(c, ref.containerId, sig));
}
function check(batch: Batch, press: string, result: oc.IpcResult, stream: string | null = null): Promise<oc.IpcCheckOutcome> {
  return run(db, operator, (c) => oc.recordIpcCheck(c, { batchId: batch.id, pressCode: press, stream, result, reference: `IPC-${serial++}` }));
}
async function status(ref: oc.ContainerRef): Promise<oc.ContainerStatus> {
  const s = await oc.containerStatus(db.app, ref.containerId);
  if (!s) throw new Error('no container');
  return s;
}
const stateOf = async (ref: oc.ContainerRef): Promise<string> => (await status(ref)).state;
function charge(batch: Batch, label: string, purpose: oc.ChargePurpose = 'CHARGE') {
  return run(db, operator, (c) => oc.chargeContainer(c, batch.id, 'COATING', label, purpose));
}
async function sign(signer: SeededActor, ref: oc.ContainerRef, expectedState: string): Promise<string> {
  const ch = await challengeFor(db, signer, ref.containerId, { meaning: oc.CONTAINER_RELEASE_MEANING, aggregateType: 'output_container' });
  const ev = await signatureAuth(db, signer, signer, ch.challengeId);
  return (await signWith(db, signer, ch.challengeId, ev, { expectedState })).signatureId;
}
let pressSerial = 0;
/** A press: a PROCESS unit of the plant equipment list (recipe-core 0540: a container's press is plant equipment). */
async function press(): Promise<string> {
  const n = `${pressSerial++}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const classCode = `CL-PRESS-${n}`;
  await run(db, steward, (c) => plant.defineEquipmentClass(c, { code: classCode, kind: 'PROCESS', description: 'Rotary tablet press', cleanHold: '72 hours', dirtyHold: '48 hours', calibrationRequired: false }));
  const code = `PRESS-${n}`;
  await run(db, steward, (c) => plant.defineEquipment(c, { code, name: `Press ${code}`, classCode }));
  return code;
}

// ---------------------------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------------------------

describe('identification', () => {
  it('[IN-21] a container carries product, strength, batch and stage from the batch, under a generated unique label', async () => {
    const b = await newBatch({ code: 'MET-500', name: 'Metformin tablets', strength: '500 mg' });
    const p = await press();
    const a = await open(b, p, undefined, 'GRANULATION');
    const a2 = await open(b, p, undefined, 'GRANULATION');
    const s = await status(a);
    expect(s).toMatchObject({ productCode: 'MET-500', strength: '500 mg', batchNumber: b.number, stage: 'GRANULATION', state: 'OPEN', netQuantity: null });
    expect(s.labelCode).toBe(`OC-${b.number}-0001`);
    expect((await status(a2)).labelCode).toBe(`OC-${b.number}-0002`);
    await close(a, '20.125');
    expect(await status(a)).toMatchObject({ state: 'CLOSED', netQuantity: '20.125' });
    // The identification and the close never change, not even for owner-level code (insert-only, audited).
    await expectRefused(db.admin.query(`update plant.output_container set batch_number = 'OTHER' where id = $1`, [a.containerId]), 'EBMR-AUDIT-004');
    await expectRefused(db.admin.query(`update plant.container_close set net_quantity = 1 where container_id = $1`, [a.containerId]), 'EBMR-AUDIT-004');
  });

  it('a close needs a net quantity above zero, and a closed container is never closed again', async () => {
    const b = await newBatch();
    const a = await open(b);
    await expectRefused(run(db, operator, (c) => oc.closeContainer(c, a.containerId, '0', a.version)), 'EBMR-CNT-031');
    const closed = await close(a);
    await expectRefused(run(db, operator, (c) => oc.closeContainer(c, a.containerId, '3', closed.version)), 'EBMR-CNT-032');
  });
});

// ---------------------------------------------------------------------------------------------
// The hold interval
// ---------------------------------------------------------------------------------------------

describe('IPC hold over (last passing check, failing check]', () => {
  it('holds containers across and inside the interval and the open one at its close; not those before or after, nor another batch', async () => {
    const b = await newBatch();
    const other = await newBatch();
    const p = await press();
    const before = await close(await open(b, p)); // closed before the last pass
    const across = await open(b, p); // open across the last pass
    const pass = await check(b, p, 'PASS');
    expect(pass.held).toEqual([]);
    const acrossClosed = await close(across);
    const inside = await close(await open(b, p));
    const stillOpen = await open(b, p);
    const otherBatch = await close(await open(other, p));
    const fail = await check(b, p, 'FAIL');
    expect(fail.lastPassingCheckAt).not.toBeNull();
    expect(new Set(fail.held)).toEqual(new Set([acrossClosed.labelCode, inside.labelCode]));
    expect(fail.pending).toEqual([stillOpen.labelCode]);
    const after = await open(b, p); // opened after the failing check

    expect(await stateOf(before)).toBe('CLOSED');
    expect(await stateOf(acrossClosed)).toBe('HELD');
    expect(await stateOf(inside)).toBe('HELD');
    expect(await stateOf(stillOpen)).toBe('OPEN');
    expect(await stateOf(otherBatch)).toBe('CLOSED');
    // The open container is held the moment it is closed.
    expect((await close(stillOpen)).state).toBe('HELD');
    expect((await close(after)).state).toBe('CLOSED');
  });

  it('a missed check with no passing check yet holds every container of the batch and press since the first', async () => {
    const b = await newBatch();
    const p = await press();
    const first = await close(await open(b, p));
    const second = await close(await open(b, p));
    const missed = await check(b, p, 'MISSED');
    expect(missed.lastPassingCheckAt).toBeNull();
    expect(new Set(missed.held)).toEqual(new Set([first.labelCode, second.labelCode]));
  });

  it('the last passing check is derived in the database: a later pass moves the start of the next interval', async () => {
    const b = await newBatch();
    const p = await press();
    const early = await close(await open(b, p));
    await check(b, p, 'PASS');
    await check(b, p, 'PASS');
    const late = await close(await open(b, p));
    const fail = await check(b, p, 'FAIL');
    expect(fail.held).toEqual([late.labelCode]);
    expect(await stateOf(early)).toBe('CLOSED');
  });

  it('boundary: a container closed at the instant of the last passing check is outside the interval; one closed 1 microsecond later is held', async () => {
    const b = await newBatch();
    const p = await press();
    const atPass = await close(await open(b, p));
    const justAfter = await close(await open(b, p));
    const pass = await check(b, p, 'PASS');
    const { rows } = await db.admin.query<{ t: string }>(`select recorded_at::text as t from plant.ipc_check where id = $1`, [pass.ipcCheckId]);
    const lp = rows[0]?.t ?? '';
    // Arrange the close instants relative to the pass (setup only; the forcing triggers are off for it).
    await asTimeTraveller(db, `update plant.container_close set closed_at = $2::timestamptz where container_id = $1`, [atPass.containerId, lp]);
    await asTimeTraveller(db, `update plant.container_close set closed_at = $2::timestamptz + interval '1 microsecond' where container_id = $1`, [justAfter.containerId, lp]);
    const fail = await check(b, p, 'FAIL');
    expect(fail.held).toEqual([justAfter.labelCode]);
    expect(await stateOf(atPass)).toBe('CLOSED');
  });

  it('per stream only where the press discharges streams into separate containers; otherwise the whole press', async () => {
    const separate = await press();
    const shared = await press();
    await run(db, steward, (c) => oc.configurePressDischarge(c, separate, true));
    const b = await newBatch();
    const sA = await close(await open(b, separate, 'A'));
    const sB = await close(await open(b, separate, 'B'));
    const hA = await close(await open(b, shared, 'A'));
    const hB = await close(await open(b, shared, 'B'));
    const failSeparate = await check(b, separate, 'FAIL', 'A');
    expect(failSeparate.held).toEqual([sA.labelCode]);
    expect(await stateOf(sB)).toBe('CLOSED');
    const failShared = await check(b, shared, 'FAIL', 'A');
    expect(new Set(failShared.held)).toEqual(new Set([hA.labelCode, hB.labelCode]));
  });

  it('only a master-data steward configures a press, and an unconfigured press holds its whole output', async () => {
    const conf = await press();
    const other = await press();
    await expectRefused(run(db, operator, (c) => oc.configurePressDischarge(c, other, true)), 'EBMR-IAM-040');
    expect(await run(db, steward, (c) => oc.configurePressDischarge(c, conf, true))).toEqual({ version: 1 });
    expect(await run(db, steward, (c) => oc.configurePressDischarge(c, conf, false))).toEqual({ version: 2 });
    const b = await newBatch();
    const a = await close(await open(b, conf, 'A'));
    const bb = await close(await open(b, conf, 'B'));
    expect(new Set((await check(b, conf, 'FAIL', 'A')).held)).toEqual(new Set([a.labelCode, bb.labelCode]));
  });
});

// ---------------------------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------------------------

describe('dispositions of a held container', () => {
  async function held(): Promise<{ b: Batch; ref: oc.ContainerRef }> {
    const b = await newBatch();
    const p = await press();
    const ref = await close(await open(b, p));
    await check(b, p, 'FAIL');
    const s = await status(ref);
    expect(s.state).toBe('HELD');
    return { b, ref: { ...ref, state: 'HELD', version: s.version } };
  }

  it('QA release needs the QA role and a signature OUTPUT_CONTAINER_RELEASED; then the container is usable', async () => {
    const { b, ref } = await held();
    // A signature id that is no signature of this container.
    await expectRefused(run(db, qa, (c) => oc.releaseContainer(c, ref.containerId, ref.version, randomUUID())), 'EBMR-PLAT-008', /does not exist/);
    // An operator cannot release, even with a QA signature in hand.
    const sig = await sign(qa, ref, 'HELD');
    await expectRefused(run(db, operator, (c) => oc.releaseContainer(c, ref.containerId, ref.version, sig)), 'EBMR-IAM-040');
    // A QA reviewer without QA.FLOOR_APPROVE cannot sign this meaning.
    await expectRefused(sign(qaReviewer, ref, 'HELD'), 'EBMR-ESIG-040', /not authorised/);
    const r = await run(db, qa, (c) => oc.releaseContainer(c, ref.containerId, ref.version, sig));
    expect(r.state).toBe('RELEASED_BY_QA');
    expect((await status(ref)).usableProblem).toBeNull();
    await charge(b, ref.labelCode);
  });

  it('sorting needs a reason and leaves the container unusable until QA releases or rejects it', async () => {
    const { b, ref } = await held();
    await expectRefused(run(db, operator, (c) => oc.sortContainer(c, ref.containerId, ref.version)), 'EBMR-PLAT-068');
    const sorted = await run(db, operator, (c) => oc.sortContainer(c, ref.containerId, ref.version), why('100% weight sorting after IPC failure'));
    expect(sorted.state).toBe('SORTED');
    await expectRefused(charge(b, ref.labelCode), 'EBMR-CNT-042', /SORTED/);
    await expectRefused(run(db, operator, (c) => oc.rejectContainer(c, ref.containerId, sorted.version), why('reject')), 'EBMR-IAM-040');
    const rejected = await run(db, qa, (c) => oc.rejectContainer(c, ref.containerId, sorted.version), why('sorted yield too low'));
    expect(rejected.state).toBe('REJECTED');
    await expectRefused(charge(b, ref.labelCode), 'EBMR-CNT-042', /REJECTED/);
  });

  // API plan A4c (sql/1881): a container no in-process check covers (an API batch's mother liquor) is held by QA itself.
  it('[AS-21][DI-17][DI-22][L-30] QA holds a closed container of its own decision with its reason (QA_HOLD, machine v2), and a released one again; the floor, a command without a reason, an unknown container and a container that is open or already held are refused; QA then releases it', async () => {
    const b = await newBatch();
    const opened = await open(b);
    await expectRefused(run(db, qa, (c) => oc.holdContainer(c, opened.containerId, opened.version), why('open')), 'EBMR-PLAT-067', /QA_HOLD is not allowed in state OPEN/);
    const ref = await close(opened);
    const v = (await status(ref)).version;
    await expectRefused(run(db, qa, (c) => oc.holdContainer(c, randomUUID(), v), why('unknown')), 'EBMR-CNT-030');
    await expectRefused(run(db, operator, (c) => oc.holdContainer(c, ref.containerId, v), why('floor')), 'EBMR-IAM-040');
    await expectRefused(run(db, qa, (c) => oc.holdContainer(c, ref.containerId, v)), 'EBMR-PLAT-068', /reason is required/);
    const held = await run(db, qa, (c) => oc.holdContainer(c, ref.containerId, v), why('mother liquor in quarantine until tested'));
    expect(held).toEqual({ state: 'HELD', version: v + 1 });
    const { rows } = await db.admin.query<{ permission_code: string; reason_text: string; person_id: string; from_state: string }>(
      "select permission_code, reason_text, person_id, from_state from platform.state_history where aggregate_type = 'output_container' and aggregate_id = $1 and event = 'QA_HOLD'", [ref.containerId]);
    expect(rows).toEqual([{ permission_code: 'qa.floor_approve', reason_text: 'mother liquor in quarantine until tested', person_id: qa.personId, from_state: 'CLOSED' }]);
    expect((await status(ref)).usableProblem).toMatch(/HELD/);
    await expectRefused(run(db, qa, (c) => oc.holdContainer(c, ref.containerId, held.version), why('again')), 'EBMR-PLAT-067', /QA_HOLD is not allowed in state HELD/);
    const sig = await sign(qa, ref, 'HELD');
    const r = await run(db, qa, (c) => oc.releaseContainer(c, ref.containerId, held.version, sig));
    expect(r.state).toBe('RELEASED_BY_QA');
    const again = await run(db, qa, (c) => oc.holdContainer(c, ref.containerId, r.version), why('a later doubt about the released container'));
    expect(again.state).toBe('HELD');
  });
});

// ---------------------------------------------------------------------------------------------
// Use: charge, pack, merge
// ---------------------------------------------------------------------------------------------

describe('held containers are never merged, charged or packed', () => {
  it('a held container is refused at the charge and pack scan and as a merge source', async () => {
    const b = await newBatch();
    const p = await press();
    const h = await close(await open(b, p));
    await check(b, p, 'FAIL');
    const target = await open(b, p, undefined, 'COMPRESSION');
    await expectRefused(charge(b, h.labelCode), 'EBMR-CNT-042', /HELD/);
    await expectRefused(charge(b, h.labelCode, 'PACK'), 'EBMR-CNT-042', /packed/);
    await expectRefused(run(db, operator, (c) => oc.mergeContainer(c, h.labelCode, target.labelCode)), 'EBMR-CNT-044', /HELD/);
  });

  it('an open container under a pending hold is refused as a merge target and, once closed, held', async () => {
    const b = await newBatch();
    const p = await press();
    const pending = await open(b, p);
    await check(b, p, 'FAIL');
    const good = await close(await open(b, p));
    await check(b, p, 'PASS');
    await expectRefused(run(db, operator, (c) => oc.mergeContainer(c, good.labelCode, pending.labelCode)), 'EBMR-CNT-045');
    await expectRefused(charge(b, pending.labelCode), 'EBMR-CNT-042', /hold/);
  });

  it('a closed container is usable only once a passing check after its close brackets it (its stream and every stream checked)', async () => {
    const b = await newBatch();
    const p = await press();
    const c1 = await close(await open(b, p, 'A'));
    await expectRefused(charge(b, c1.labelCode), 'EBMR-CNT-042', /no passing in-process check/);
    await check(b, p, 'PASS', 'B');
    await expectRefused(charge(b, c1.labelCode), 'EBMR-CNT-042', /stream A/);
    await check(b, p, 'PASS', 'A');
    expect((await status(c1)).usableProblem).toBeNull();
    const c2 = await close(await open(b, p, 'A'));
    await check(b, p, 'PASS', 'A');
    await expectRefused(charge(b, c2.labelCode), 'EBMR-CNT-042', /stream B/);
    await check(b, p, 'PASS', 'B');
    const ch = await charge(b, c2.labelCode, 'PACK');
    expect(ch.netQuantity).toBe('12.500');
    await expectRefused(charge(b, c2.labelCode), 'EBMR-CNT-042', /already charged/);
  });

  it('a container without a press is usable once closed, and is never charged twice', async () => {
    const b = await newBatch();
    const c1 = await close(await open(b, undefined, undefined, 'GRANULATION'));
    await charge(b, c1.labelCode);
    await expectRefused(charge(b, c1.labelCode), 'EBMR-CNT-042');
  });

  it('[IN-26] the charge scan of a container labelled for another batch is refused, and an unknown label too', async () => {
    const mine = await newBatch();
    const theirs = await newBatch();
    const c1 = await close(await open(theirs, undefined, undefined, 'GRANULATION'));
    await expectRefused(charge(mine, c1.labelCode), 'EBMR-CNT-041', new RegExp(`labelled for batch ${theirs.number}`));
    await expectRefused(charge(mine, 'OC-NOPE-0001'), 'EBMR-CNT-040');
    const target = await open(mine, undefined, undefined, 'GRANULATION');
    await expectRefused(run(db, operator, (c) => oc.mergeContainer(c, c1.labelCode, target.labelCode)), 'EBMR-CNT-043');
  });

  it('a hold reaches the containers a released source was merged into, and holds the released source again', async () => {
    const b = await newBatch();
    const p = await press();
    const src = await close(await open(b, p));
    await check(b, p, 'FAIL');
    const s = await status(src);
    const sig = await sign(qa, { ...src, version: s.version }, 'HELD');
    await run(db, qa, (c) => oc.releaseContainer(c, src.containerId, s.version, sig));
    const target = await open(b, undefined, undefined, 'COMPRESSION');
    await run(db, operator, (c) => oc.mergeContainer(c, src.labelCode, target.labelCode));
    // No passing check since: a missed check holds the source again, and the open target at its close.
    const missed = await check(b, p, 'MISSED');
    expect(missed.held).toEqual([src.labelCode]);
    expect(missed.pending).toEqual([target.labelCode]);
    expect(await stateOf(src)).toBe('HELD');
    expect((await close(target)).state).toBe('HELD');
  });
});

// ---------------------------------------------------------------------------------------------
// Bypass
// ---------------------------------------------------------------------------------------------

describe('direct writes are refused', () => {
  it('the application role cannot write the container tables', async () => {
    const b = await newBatch();
    const c1 = await open(b, await press());
    await expectPermissionDenied(
      db.app.query(`insert into plant.output_container (label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
                    values ('OC-X-0001', $1, 'X', 'P', 'S', 'COMPRESSION', 'kg', gen_random_uuid(), gen_random_uuid())`, [b.id]),
    );
    await expectPermissionDenied(db.app.query(`insert into plant.container_close (container_id, net_quantity, person_id, account_id) values ($1, 1, gen_random_uuid(), gen_random_uuid())`, [c1.containerId]));
    await expectPermissionDenied(db.app.query(`insert into plant.container_hold (container_id, ipc_check_id, person_id, account_id) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [c1.containerId]));
    await expectPermissionDenied(db.app.query(`insert into plant.ipc_check (batch_id, press_code, result, reference, person_id, account_id) values ($1, 'P', 'PASS', 'x', gen_random_uuid(), gen_random_uuid())`, [b.id]));
    await expectPermissionDenied(db.app.query(`delete from plant.container_hold`));
    await expectPermissionDenied(db.app.query(`insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id) values ($1, $2, 'COATING', 'CHARGE', 'x', gen_random_uuid(), gen_random_uuid())`, [c1.containerId, b.id]));
  });

  it('the state engine called directly cannot close a container without its close record, nor hold one without a failing check', async () => {
    const b = await newBatch();
    const c1 = await open(b, await press());
    await expectRefused(
      run(db, operator, (c) => c.query(`select platform.transition('output_container', 'output_container', $1, 'CLOSE', $2, '{}'::jsonb)`, [c1.containerId, c1.version])),
      'EBMR-PLAT-068',
      /output_container.closed/,
    );
    const closed = await close(c1);
    await expectRefused(
      run(db, operator, (c) => c.query(`select platform.transition('output_container', 'output_container', $1, 'HOLD', $2, '{}'::jsonb)`, [c1.containerId, closed.version])),
      'EBMR-PLAT-068',
      /output_container.hold_recorded/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 3 slice 3c (recipe-core 0540): press codes, the open and hold race, the unit transition scope
// ---------------------------------------------------------------------------------------------

describe('press codes are plant equipment; a check and an open never race (recipe-core 0540)', () => {
  it('[PR-22][IN-21] a container, an in-process check and a discharge configuration name a PROCESS unit of the plant: an unknown code or an instrument is refused', async () => {
    const b = await newBatch();
    await expectRefused(open(b, 'PRESS-NOT-IN-PLANT'), 'EBMR-CNT-023', /no unit of the plant equipment list/);
    await expectRefused(check(b, 'PRESS-NOT-IN-PLANT', 'PASS'), 'EBMR-CNT-023');
    await expectRefused(run(db, steward, (c) => oc.configurePressDischarge(c, 'PRESS-NOT-IN-PLANT', true)), 'EBMR-CNT-023');
    const n = randomUUID().slice(0, 6).toUpperCase();
    await run(db, steward, (c) => plant.defineEquipmentClass(c, { code: `CL-BAL-${n}`, kind: 'INSTRUMENT', description: 'Balance', calibrationRequired: true, checkRegime: 'DAILY' }));
    await run(db, steward, (c) => plant.defineEquipment(c, { code: `BAL-${n}`, name: 'Balance', classCode: `CL-BAL-${n}` }));
    await expectRefused(open(b, `BAL-${n}`), 'EBMR-CNT-023', /INSTRUMENT equipment, not a press/);
    const p = await press();
    expect((await open(b, p)).labelCode).toMatch(/^OC-/);
  });

  it('[INV-12][IN-26] review backlog #8: a container being opened while a failing check is recorded is held (the check waits for the open); the hold reads the state it acts on under lock', async () => {
    const b = await newBatch();
    const p = await press();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let opened: oc.ContainerRef | undefined;
    // The open holds its transaction until the check has been sent.
    const opening = run(db, operator, async (c) => {
      const ref = await oc.openContainer(c, { batchId: b.id, stage: 'COMPRESSION', unit: 'kg', pressCode: p });
      opened = ref;
      await gate;
      return ref;
    });
    while (!opened) await new Promise((r) => setTimeout(r, 20));
    const checking = check(b, p, 'FAIL');
    await new Promise((r) => setTimeout(r, 300));
    release();
    const ref = await opening;
    const outcome = await checking;
    expect(outcome.pending).toEqual([ref.labelCode]);
    expect((await close(ref)).state).toBe('HELD');
  });

  it('[DI-17] review backlog #6 (slice 3a): a step.execute transition of a unit is evaluated for the product of the use the transaction starts or ends, never for the product of an earlier use', async () => {
    const p = await press();
    const unit = (await db.admin.query<{ id: string }>('select id from plant.equipment where code = $1', [p])).rows[0]?.id ?? '';
    const scope = async (c: { query: typeof db.admin.query }) =>
      (await c.query<{ s: unknown }>("select plant.transition_scope('step.execute', 'plant_equipment', $1) as s", [unit])).rows[0]?.s;
    // A use of product ATV-40 recorded and ended earlier (arranged as superuser, triggers off: setup only).
    const b = await newBatch();
    await asTimeTraveller(db, `insert into plant.product (code, name, highly_potent, recorded_by) values ('ATV-40', 'Atorvastatin', false, gen_random_uuid()) on conflict do nothing`);
    await asTimeTraveller(db, `insert into plant.cleaning (id, equipment_id, level, method, dirty_hold_exceeded, started_by) values ($1, $2, 'MAJOR', 'MANUAL', false, gen_random_uuid())`, [b.id, unit]);
    await asTimeTraveller(db, `insert into plant.cleaning_completion (cleaning_id, completed_by) values ($1, gen_random_uuid())`, [b.id]);
    await asTimeTraveller(db, `insert into plant.cleaning_verification (cleaning_id, verified_by, signature_id) values ($1, gen_random_uuid(), gen_random_uuid())`, [b.id]);
    const use = randomUUID();
    await asTimeTraveller(db, `insert into plant.equipment_use (id, equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by, started_at)
                               values ($1, $2, $3, 'B', 'ATV-40', clock_timestamp() + interval '1 hour', $3, gen_random_uuid(), clock_timestamp() - interval '2 hours')`, [use, unit, b.id]);
    await asTimeTraveller(db, `insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, ended_at, clean_hold_crossed, calibration_crossed, campaign_crossed, overran_plan)
                               values ($1, $2, clock_timestamp() - interval '2 hours', gen_random_uuid(), clock_timestamp() - interval '1 hour', false, false, false, false)`, [use, unit]);
    // Outside the start or end of a use: no product (0523 answered ATV-40, the earlier use's).
    expect(await scope(db.admin)).toEqual({});
    // Inside a transaction that starts a use: that use's product.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(`insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
                     values ($1, $2, $3, 'B2', 'ATV-40', clock_timestamp() + interval '1 hour', $3, gen_random_uuid())`, [unit, use, b.id]);
      expect(await scope(c as never)).toEqual({ product: 'ATV-40' });
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
});
