/**
 * Output containers, rule by rule (SQL mutation group "output-containers": recipe-core 0420, 0422, 0540 and
 * plant.charge_container of 0624). These tests close the gaps the Phase 3 exit SQL mutation run found in
 * test/containers:
 *   - TB-11 bracketing read for the container's own batch and press, its own stream where the press separates streams,
 *     every stream checked otherwise, from the instant of its close inclusive;
 *   - each refusal of the commands with its own code (unknown container, batch or label; no product strength; a stream
 *     without a press; an undecided discharge configuration; containers of another stage or unit);
 *   - the state-row locks of a merge and a charge, on the containers named and no other;
 *   - the hold guard on a direct transition, the signed content of a container, the product scope of a disposition;
 *   - a reprocessing batch charging its parent's held containers (PR-47): only the containers its parent link names,
 *     only to charge, only while held, once.
 *
 * Controls: PR-22, PR-29, PR-47, IN-21, IN-26; invariant INV-33.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../../kernel/src/db/command.ts';
import { asTimeTraveller, challengeFor, cmd, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as oc from '../../src/containers/index.ts';
import * as plant from '../../src/plant/index.ts';

let db: TestDatabase;
let operator: SeededActor;
let qa: SeededActor;
let steward: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator' });
  qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Qamar QA' });
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Sana Steward' });
}, 180_000);
afterAll(async () => {
  await db.drop();
});

let serial = 0;
interface Batch {
  id: string;
  number: string;
}

/** A batch of the product (default ATV-40, 40 mg), arranged directly (setup only, as test/containers does). */
async function newBatch(product: Record<string, string> = { code: 'ATV-40', name: 'Atorvastatin tablets', strength: '40 mg' }): Promise<Batch> {
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

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(not refused)';
}

const why = (text: string) => ({ reasonCode: 'TEST', reasonText: text });
function open(batch: Batch, press?: string, stream?: string, stage = 'COMPRESSION', unit = 'kg'): Promise<oc.ContainerRef> {
  return run(db, operator, (c) => oc.openContainer(c, { batchId: batch.id, stage, unit, ...(press ? { pressCode: press } : {}), ...(stream ? { stream } : {}) }));
}
function close(ref: oc.ContainerRef, qty = '12.500'): Promise<oc.ContainerRef> {
  return run(db, operator, (c) => oc.closeContainer(c, ref.containerId, qty, ref.version));
}
function check(batch: Batch, press: string, result: oc.IpcResult, stream: string | null = null): Promise<oc.IpcCheckOutcome> {
  return run(db, operator, (c) => oc.recordIpcCheck(c, { batchId: batch.id, pressCode: press, stream, result, reference: `IPC-${serial++}` }));
}
async function problem(ref: oc.ContainerRef): Promise<string | null> {
  return (await oc.containerStatus(db.app, ref.containerId))?.usableProblem ?? null;
}
const stateOf = async (ref: oc.ContainerRef): Promise<string | undefined> => (await oc.containerStatus(db.app, ref.containerId))?.state;
function charge(batch: Batch, label: string, purpose: oc.ChargePurpose = 'CHARGE') {
  return run(db, operator, (c) => oc.chargeContainer(c, batch.id, 'COATING', label, purpose));
}
async function sign(signer: SeededActor, ref: oc.ContainerRef, expectedState: string): Promise<string> {
  const ch = await challengeFor(db, signer, ref.containerId, { meaning: oc.CONTAINER_RELEASE_MEANING, aggregateType: 'output_container' });
  const ev = await signatureAuth(db, signer, signer, ch.challengeId);
  return (await signWith(db, signer, ch.challengeId, ev, { expectedState })).signatureId;
}
let pressSerial = 0;
async function press(separate?: boolean): Promise<string> {
  const n = `${pressSerial++}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const classCode = `CL-PRESS-${n}`;
  await run(db, steward, (c) => plant.defineEquipmentClass(c, { code: classCode, kind: 'PROCESS', description: 'Rotary tablet press', cleanHold: '72 hours', dirtyHold: '48 hours', calibrationRequired: false }));
  const code = `PRESS-${n}`;
  await run(db, steward, (c) => plant.defineEquipment(c, { code, name: `Press ${code}`, classCode }));
  if (separate !== undefined) await run(db, steward, (c) => oc.configurePressDischarge(c, code, separate));
  return code;
}

/** Owner-level work (the superuser inside a validated command of `actor`, triggers on), always rolled back. */
async function asOwner<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, extra: Partial<ActorContext> = {}): Promise<T> {
  const ctx = await cmd(db, actor, extra);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Which of the containers' state rows `work`, left open in a command of `actor`, holds a FOR UPDATE lock on. */
async function lockedStates(ids: string[], actor: SeededActor, work: (c: pg.PoolClient) => Promise<unknown>): Promise<boolean[]> {
  const ctx = await cmd(db, actor);
  const a = await db.admin.connect();
  const b = await db.admin.connect();
  try {
    await a.query('begin');
    await a.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    await work(a).catch(() => undefined);
    const out: boolean[] = [];
    for (const id of ids) {
      out.push(
        await b
          .query(`select 1 from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1 for no key update nowait`, [id])
          .then(
            () => false,
            (e: { code?: string }) => e.code === '55P03',
          ),
      );
    }
    return out;
  } finally {
    await a.query('rollback');
    a.release();
    b.release();
  }
}

describe('TB-11 bracketing reads the container\'s own batch, press and streams, from its close inclusive', () => {
  it('[PR-29] checks of another press of the batch, or of another batch on the press, neither bracket a container nor add a series to it', async () => {
    const b = await newBatch();
    const other = await newBatch();
    const p = await press(true);
    const p2 = await press(true);
    // The batch has checks on another press (stream Z); another batch has a passing check on this press after the close.
    await check(b, p2, 'PASS', 'Z');
    const c1 = await close(await open(b, p, 'A'));
    await check(other, p, 'PASS', 'A');
    await check(b, p2, 'PASS', 'A');
    expect(await problem(c1)).toMatch(/^no passing in-process check of press .* was recorded after container .* was closed$/);
    // Its own passing check after the close brackets it, whatever the other press and batch hold.
    await check(b, p, 'PASS', 'A');
    expect(await problem(c1)).toBeNull();
  });

  it('[PR-29] on a press that separates streams, a container needs its own stream only; another stream\'s check neither brackets it nor is required', async () => {
    const b = await newBatch();
    const p = await press(true);
    await check(b, p, 'PASS', 'B');
    const c1 = await close(await open(b, p, 'A'));
    await check(b, p, 'PASS', 'B');
    expect(await problem(c1)).toMatch(/^no passing in-process check of press/);
    await check(b, p, 'PASS', 'A');
    expect(await problem(c1)).toBeNull();
    // A container without a stream on that press needs every stream checked for the batch.
    const c2 = await close(await open(b, p));
    await check(b, p, 'PASS', 'A');
    expect(await problem(c2)).toMatch(/^stream B of press .* has no passing in-process check recorded after container/);
    await check(b, p, 'PASS', 'B');
    expect(await problem(c2)).toBeNull();
  });

  it('[PR-29] on a press that does not separate streams, any stream\'s check is a series of every container: each needs its own pass', async () => {
    const b = await newBatch();
    const p = await press(false);
    await check(b, p, 'PASS', 'B');
    const c1 = await close(await open(b, p, 'A'));
    await check(b, p, 'PASS', 'A');
    expect(await problem(c1)).toMatch(/^stream B of press .* has no passing in-process check recorded after container/);
    await check(b, p, 'PASS', 'B');
    expect(await problem(c1)).toBeNull();
  });

  it('[PR-29] a passing check recorded at the very instant of the close brackets the container', async () => {
    const b = await newBatch();
    const p = await press(true);
    const c1 = await close(await open(b, p, 'A'));
    const pass = await check(b, p, 'PASS', 'A');
    const { rows } = await db.admin.query<{ t: string }>('select recorded_at::text as t from plant.ipc_check where id = $1', [pass.ipcCheckId]);
    await asTimeTraveller(db, 'update plant.container_close set closed_at = $2::timestamptz where container_id = $1', [c1.containerId, rows[0]?.t]);
    expect(await problem(c1)).toBeNull();
    // A check of the whole press at that instant brackets a stream container too.
    const c2 = await close(await open(b, p, 'C'));
    const whole = await check(b, p, 'PASS');
    const r2 = await db.admin.query<{ t: string }>('select recorded_at::text as t from plant.ipc_check where id = $1', [whole.ipcCheckId]);
    await asTimeTraveller(db, 'update plant.container_close set closed_at = $2::timestamptz where container_id = $1', [c2.containerId, r2.rows[0]?.t]);
    expect(await problem(c2)).toBeNull();
  });

  it('[PR-29] a container is usable once bracketed even when another container of the batch was merged', async () => {
    const b = await newBatch();
    const src = await close(await open(b, undefined, undefined, 'GRANULATION'));
    const target = await open(b, undefined, undefined, 'GRANULATION');
    await run(db, operator, (c) => oc.mergeContainer(c, src.labelCode, target.labelCode));
    const fresh = await close(await open(b, undefined, undefined, 'GRANULATION'));
    expect(await problem(fresh)).toBeNull();
    expect(await problem(src)).toMatch(/was already merged into another container/);
  });
});

describe('each refusal with its own code', () => {
  it('[IN-21][PR-22] an unknown container, batch or label is refused as unknown', async () => {
    const ghost = randomUUID();
    expect(await refusal(run(db, operator, (c) => oc.closeContainer(c, ghost, '1.000', 1)))).toMatch(/Unknown output container .*EBMR-CNT-030/);
    expect(await refusal(run(db, operator, (c) => oc.sortContainer(c, ghost, 1), why('sort')))).toMatch(/Unknown output container .*EBMR-CNT-030/);
    expect(await refusal(run(db, operator, (c) => oc.openContainer(c, { batchId: ghost, stage: 'COMPRESSION', unit: 'kg' })))).toMatch(/Unknown batch .*EBMR-CNT-020/);
    const b = await newBatch();
    const c1 = await close(await open(b, undefined, undefined, 'GRANULATION'));
    expect(await refusal(run(db, operator, (c) => oc.chargeContainer(c, ghost, 'COATING', c1.labelCode)))).toMatch(/Unknown batch .*EBMR-CNT-020/);
    const target = await open(b, undefined, undefined, 'GRANULATION');
    expect(await refusal(run(db, operator, (c) => oc.mergeContainer(c, 'OC-NOPE-0001', target.labelCode)))).toMatch(/names no output container; merge refused.*EBMR-CNT-040/);
    expect(await refusal(run(db, operator, (c) => oc.mergeContainer(c, c1.labelCode, 'OC-NOPE-0001')))).toMatch(/names no output container; merge refused.*EBMR-CNT-040/);
  });

  it('[IN-21] a container carries a product code and a strength; a stream names its press; a discharge configuration is decided', async () => {
    const noStrength = await newBatch({ code: 'ATV-40', name: 'Atorvastatin tablets' });
    expect(await refusal(open(noStrength))).toMatch(/names no product code and strength; a container carries both/);
    const noCode = await newBatch({ name: 'Atorvastatin tablets', strength: '40 mg' });
    expect(await refusal(open(noCode))).toMatch(/names no product or site.*EBMR-CNT-020/);
    const b = await newBatch();
    expect(await refusal(open(b, undefined, 'A'))).toMatch(/A stream belongs to a press: name the press \(EBMR-CNT-022\)/);
    const p = await press();
    expect(await refusal(run(db, steward, (c) => c.query('select plant.configure_press_discharge($1, null)', [p])))).toMatch(/EBMR-CNT-010/);
  });

  it('[IN-26] a merge needs the same batch, stage and unit', async () => {
    const b = await newBatch();
    const src = await close(await open(b, undefined, undefined, 'GRANULATION'));
    const otherStage = await open(b, undefined, undefined, 'BLENDING');
    const otherUnit = await open(b, undefined, undefined, 'GRANULATION', 'g');
    expect(await refusal(run(db, operator, (c) => oc.mergeContainer(c, src.labelCode, otherStage.labelCode)))).toMatch(/differ in batch, stage or unit.*EBMR-CNT-043/);
    expect(await refusal(run(db, operator, (c) => oc.mergeContainer(c, src.labelCode, otherUnit.labelCode)))).toMatch(/differ in batch, stage or unit.*EBMR-CNT-043/);
  });

  it('[DI-17] a disposition is checked against the product of the container disposed of', async () => {
    const atv = await newBatch();
    const met = await newBatch({ code: 'MET-500', name: 'Metformin tablets', strength: '500 mg' });
    const scoped = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Mira Metformin', scope: { product: 'MET-500' } });
    const p = await press();
    // A held container of each product.
    const hMet = await close(await open(met, p));
    await check(met, p, 'FAIL');
    await close(await open(atv, p));
    await check(atv, p, 'FAIL');
    const s = await oc.containerStatus(db.app, hMet.containerId);
    const sorted = await run(db, scoped, (c) => oc.sortContainer(c, hMet.containerId, s?.version ?? 0), why('sorting'));
    expect(sorted.state).toBe('SORTED');
  });
});

describe('a merge and a charge lock the state rows of the containers they name, and no other', () => {
  it('[INV-12][IN-26] merge: both containers; charge: the container charged', async () => {
    const b = await newBatch();
    const bystander = await open(b, undefined, undefined, 'GRANULATION');
    const src = await close(await open(b, undefined, undefined, 'GRANULATION'));
    const target = await open(b, undefined, undefined, 'GRANULATION');
    expect(await lockedStates([src.containerId, target.containerId, bystander.containerId], operator, (c) => oc.mergeContainer(c, src.labelCode, target.labelCode))).toEqual([
      true,
      true,
      false,
    ]);
    const ch = await close(await open(b, undefined, undefined, 'GRANULATION'));
    expect(await lockedStates([ch.containerId, bystander.containerId], operator, (c) => oc.chargeContainer(c, b.id, 'COATING', ch.labelCode))).toEqual([true, false]);
  });
});

describe('the hold guard and the signed content of a container', () => {
  it('[PR-29] a direct HOLD needs a hold of this container recorded in the transaction or before its close; a hold of another container, or one after the close, does not count', async () => {
    const b = await newBatch();
    const p = await press();
    // Another container was held at its close by a pending hold (a hold recorded before its close).
    const pending = await open(b, p);
    await check(b, p, 'FAIL');
    expect((await close(pending)).state).toBe('HELD');
    await check(b, p, 'PASS');
    const x = await close(await open(b, p));
    const s = await oc.containerStatus(db.app, x.containerId);
    const hold = `select platform.transition('output_container', 'output_container', $1, 'HOLD', $2, '{}'::jsonb)`;
    expect(await refusal(asOwner(operator, (c) => c.query(hold, [x.containerId, s?.version])))).toMatch(/output_container.hold_recorded/);
    // A hold row of this container recorded after its close by an earlier transaction (forged xact) does not count.
    const k = (await db.admin.query<{ id: string }>('select id from plant.ipc_check where batch_id = $1 order by recorded_at limit 1', [b.id])).rows[0]?.id;
    expect(
      await refusal(
        asOwner(operator, async (c) => {
          await c.query(
            "insert into plant.container_hold (container_id, ipc_check_id, xact_id, person_id, account_id) values ($1, $2, '3'::xid8, $3, $4)",
            [x.containerId, k, operator.personId, operator.accountId],
          );
          return c.query(hold, [x.containerId, s?.version]);
        }),
      ),
    ).toMatch(/output_container.hold_recorded/);
  });

  it('[DI-05][IN-21] the signed content of a container holds its own close, its own holds and the persons of those acts', async () => {
    const b = await newBatch();
    const p = await press();
    const other = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Oli Other' });
    // Another container, closed and held by another operator's acts, comes first.
    const first = await run(db, other, (c) => oc.openContainer(c, { batchId: b.id, stage: 'COMPRESSION', unit: 'kg', pressCode: p }));
    await run(db, other, (c) => oc.closeContainer(c, first.containerId, '3.000', first.version));
    await run(db, other, (c) => oc.recordIpcCheck(c, { batchId: b.id, pressCode: p, stream: null, result: 'FAIL', reference: 'IPC-O' }));
    await check(b, p, 'PASS');
    const mine = await close(await open(b, p), '7.250');
    const fail = await check(b, p, 'FAIL');
    const content = (await db.admin.query<{ c: { content_version: number; content: { net_quantity: string; holds: { ipc_check_id: string }[] }; entered_by?: string[] } & Record<string, unknown> }>(
      'select plant.output_container_content($1) as c',
      [mine.containerId],
    )).rows[0]?.c;
    expect(content?.content_version).toBe(3);
    expect(content?.content.net_quantity).toBe('7.250');
    expect(content?.content.holds.map((h) => h.ipc_check_id)).toEqual([fail.ipcCheckId]);
    expect(JSON.stringify(content)).toContain(operator.personId);
    expect(JSON.stringify(content)).not.toContain(other.personId);
  });
});

describe('[PR-47] a reprocessing batch charges its parent\'s held containers', () => {
  async function parentWithHeld(): Promise<{ parent: Batch; child: Batch; held: oc.ContainerRef; unlisted: oc.ContainerRef; closed: oc.ContainerRef }> {
    const parent = await newBatch();
    const child = await newBatch();
    const p = await press();
    const held = await close(await open(parent, p));
    const unlisted = await close(await open(parent, p));
    await check(parent, p, 'FAIL');
    const closed = await close(await open(parent, undefined, undefined, 'GRANULATION'));
    await asTimeTraveller(
      db,
      'insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id) values ($1, $2, $3, $4::uuid[], gen_random_uuid())',
      [child.id, parent.id, parent.number, [held.containerId, closed.containerId]],
    );
    return { parent, child, held, unlisted, closed };
  }

  it('[PR-47][INV-33] only the containers its link names, only to charge, only while held, and once', async () => {
    const { child, held, unlisted, closed } = await parentWithHeld();
    const stranger = await newBatch();
    expect(await refusal(charge(stranger, held.labelCode))).toMatch(/EBMR-CNT-041/);
    expect(await refusal(charge(child, unlisted.labelCode))).toMatch(/EBMR-CNT-041/);
    expect(await refusal(charge(child, held.labelCode, 'PACK'))).toMatch(/EBMR-CNT-041/);
    expect(await refusal(charge(child, closed.labelCode))).toMatch(/is CLOSED, no longer held for reprocessing.*EBMR-CNT-042/);
    const ok = await charge(child, held.labelCode);
    expect(ok.containerId).toBe(held.containerId);
    expect(await refusal(charge(child, held.labelCode))).toMatch(/was already charged.*EBMR-CNT-042/);
  });

  it('[PR-47][INV-33] a held parent container that was merged away is not charged again', async () => {
    const parent = await newBatch();
    const child = await newBatch();
    const p = await press();
    const src = await close(await open(parent, p));
    await check(parent, p, 'FAIL');
    const s = await oc.containerStatus(db.app, src.containerId);
    const sig = await sign(qa, { ...src, version: s?.version ?? 0 }, 'HELD');
    await run(db, qa, (c) => oc.releaseContainer(c, src.containerId, s?.version ?? 0, sig));
    const target = await open(parent, undefined, undefined, 'COMPRESSION');
    await run(db, operator, (c) => oc.mergeContainer(c, src.labelCode, target.labelCode));
    await check(parent, p, 'MISSED');
    expect(await stateOf(src)).toBe('HELD');
    await asTimeTraveller(
      db,
      'insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id) values ($1, $2, $3, $4::uuid[], gen_random_uuid())',
      [child.id, parent.id, parent.number, [src.containerId]],
    );
    expect(await refusal(charge(child, src.labelCode))).toMatch(/was merged.*EBMR-CNT-042/);
  });
});
