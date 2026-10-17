/**
 * Controlled-substance mode in the database (Phase 6 slice 6e; draft control IN-53, status U; recipe-core 1031 to 1034,
 * site services 0970). Every act runs as the application role through the definers with real e-signatures of seeded
 * people, and each rule is tried around (one person in both places, direct writes, an administrator, an unflagged
 * product). Kept with the site-services tests because it needs real material lots, reservations and consumptions, which
 * the lot test world provides; the rules themselves are recipe-core's.
 *
 * Batch records are fixtures written by the superuser with triggers off (lots/support.ts), each with a test package that
 * names its product, exactly as recipe.batch_product reads it. The stage sign-off guard is tried with a SIGN_OFF_STAGE
 * row written by the superuser with triggers on, so the guard (which fires first) decides.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { withChangeRecord } from '../../../kernel/test/support/change-record.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { ErpWorld } from '../erp-wms/support.ts';
import { refusal, unique, type Batch, type World } from '../lots/support.ts';

let db: TestDatabase;
let w: ErpWorld;
let supervisor: SeededActor;
let qaApprover: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ErpWorld.create(db);
  supervisor = await signerActor(db, 'SHIFT_SUPERVISOR');
  qaApprover = w.cast.qa;
}, 300_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const one = async <T>(who: SeededActor, sql: string, params: unknown[] = [], reason?: string): Promise<T> =>
  w.run(who, async (c) => ((await c.query<{ r: T }>(sql, params)).rows[0] as { r: T }).r, reason);

/** A batch fixture of product `product` in `status` (a test package names the product; recipe.batch_product reads it). */
async function batchOf(product: string, status = 'IN_PROGRESS'): Promise<Batch> {
  const b = await w.batch(['IN'], status);
  const hash = randomUUID().replace(/-/g, '').padEnd(64, '0');
  await w.timeTravel(
    `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number, revision,
                                      version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
     values ($1, $1 || '.json', '{}', '{}', $1, gen_random_uuid(), 'FAM', jsonb_build_object('code', $2::text), gen_random_uuid(), '1.0', 0, 'EFFECTIVE', '{}', 0, '{}',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [hash, product],
  );
  await w.timeTravel('update recipe.batch_execution set package_hash = $2 where id = $1', [b.id, hash]);
  return b;
}

/** QA records the flag under the fixture change record; a second QA person approves it. Returns the record id. */
async function flag(product: string, materials: string[], approve = true): Promise<string> {
  const ctx = await withChangeRecord(db, w.cast.qaMaster);
  const id = await one<string>(ctx, 'select plant.record_controlled_product($1::jsonb) as r', [
    JSON.stringify({ productCode: product, controlled: materials.length > 0, materialCodes: materials, basisRef: 'NDPS manufacturing licence ML-17 (draft)' }),
  ]);
  if (approve) {
    const sig = await signFor(db, qaApprover, { type: 'controlled_product', id }, 'CONTROLLED_PRODUCT_APPROVED', 'RECORDED');
    await w.run(qaApprover, (c) => c.query('select plant.approve_controlled_product($1, $2)', [id, sig]));
  }
  return id;
}

const propose = (who: SeededActor, p: Json): Promise<string> => one<string>(who, 'select recipe.propose_controlled_custody($1::jsonb) as r', [JSON.stringify(p)]);

/** `who` signs custody record `id` in the place its state asks for; returns the state after. */
async function signCustody(who: SeededActor, id: string): Promise<string> {
  const state = (await db.admin.query<{ s: string }>('select recipe.controlled_custody_state($1) as s', [id])).rows[0]?.s ?? '';
  const meaning = state === 'PROPOSED' ? 'CONTROLLED_CUSTODY_RECORDED' : 'CONTROLLED_CUSTODY_COUNTERSIGNED';
  const sig = await signFor(db, who, { type: 'controlled_custody', id }, meaning, state);
  return one<string>(who, 'select recipe.sign_controlled_custody($1, $2) as r', [id, sig]);
}

/** A custody record proposed and signed by `first` and countersigned by `second`. */
async function custody(p: Json, first: SeededActor = w.cast.dispenser, second: SeededActor = w.cast.witness): Promise<string> {
  const id = await propose(first, p);
  await signCustody(first, id);
  expect(await signCustody(second, id)).toBe('CONFIRMED');
  return id;
}

/** A released controlled API lot, the product that lists it (flag approved) and a running batch with a reservation. */
async function controlledSetup(): Promise<{ lot: Awaited<ReturnType<World['releasedLot']>>; product: string; batch: Batch; reservation: string }> {
  const lot = await w.releasedLot('API');
  const product = unique('P');
  await flag(product, [lot.materialCode]);
  const batch = await batchOf(product);
  const reservation = await w.reserve(lot.lotId, batch, '5');
  return { lot, product, batch, reservation };
}

async function deviationOf(batch: Batch): Promise<string> {
  const id = randomUUID();
  const serial = Math.floor(Math.random() * 900_000) + 100_000;
  await w.timeTravel(
    `insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id)
     values ($1, 'DEV-SITE-1-2026-' || $2::text, 'SITE-1', 2026, $2::text::integer, 'DEVIATION', 'Controlled API weighing difference', 'MINOR', 'Balance uncertainty under investigation', $3, $3, $3)`,
    [id, serial, w.cast.qa.personId],
  );
  await w.timeTravel(
    `insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account)
     values ($1, 'BATCH', $2, $3, $2, $3, 'TABLETS', $4, $4)`,
    [id, batch.id, batch.number, w.cast.qa.personId],
  );
  return id;
}

const recordCheckpoint = (p: Json): Promise<string> => one<string>(supervisor, 'select recipe.record_controlled_checkpoint($1::jsonb) as r', [JSON.stringify(p)]);
async function signCheckpoint(id: string): Promise<void> {
  const sig = await signFor(db, supervisor, { type: 'controlled_checkpoint', id }, 'CONTROLLED_BALANCE_SIGNED', 'RECORDED');
  await w.run(supervisor, (c) => c.query('select recipe.sign_controlled_checkpoint($1, $2)', [id, sig]));
}

/** A SIGN_OFF_STAGE row of stage `stage` written by the superuser with triggers on, in a transaction rolled back after. */
async function signOffRow(batch: Batch, stage: string): Promise<string> {
  const c = await db.admin.connect();
  const hex = 'b'.repeat(64);
  try {
    await c.query('begin');
    await c.query(
      `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                             session_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id)
       values ($1, 2, 'COMMAND', $2, 'SIGN_OFF_STAGE', jsonb_build_object('type', 'SIGN_OFF_STAGE', 'stage', $3::text, 'context', '[]'::jsonb), $4, $5, $5, 'SHIFT_SUPERVISOR', 'UI',
               $5, 'PERSONAL', 1, true, 2, $4, $4, 0, $4, $4, $5)`,
      [batch.id, `cmd-${randomUUID()}`, stage, hex, supervisor.personId],
    );
    return 'inserted';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** The batch's stored state moved to EXECUTION_COMPLETE by the superuser with triggers on, rolled back after. */
async function completeRow(batch: Batch): Promise<string> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE', state = jsonb_set(state, '{status}', '\"EXECUTION_COMPLETE\"') where batch_id = $1", [batch.id]);
    return 'completed';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('controlled-substance mode (IN-53, draft; recipe-core 1031 to 1035)', () => {
  it('[IN-53] the flag is recorded by QA under an approved change record and takes effect on a second QA person\'s signature; a pending flag counts at once, a pending unflagging only once approved', async () => {
    const lot = await w.releasedLot('API');
    const product = unique('P');
    // Without a change record the configuration guard (DI-09) refuses it; not by a warehouse person; never an administrator.
    const p = JSON.stringify({ productCode: product, controlled: true, materialCodes: [lot.materialCode], basisRef: 'NDPS licence (draft)' });
    expect(await refusal(w.run(w.cast.qaMaster, (c) => c.query('select plant.record_controlled_product($1::jsonb)', [p])))).toMatch(/EBMR-CFG-001/);
    expect(await refusal(w.run(await withChangeRecord(db, w.cast.warehouse), (c) => c.query('select plant.record_controlled_product($1::jsonb)', [p])))).toMatch(/EBMR-IAM/);
    expect(await refusal(w.run(await withChangeRecord(db, w.cast.admin), (c) => c.query('select plant.record_controlled_product($1::jsonb)', [p])))).toMatch(/EBMR-IAM/);
    // An excipient or an unknown material is no controlled API.
    const exc = await w.releasedLot('EXCIPIENT');
    expect(await refusal(flag(product, [exc.materialCode], false))).toMatch(/EBMR-CSM-003/);
    const id = await flag(product, [lot.materialCode], false);
    // Pending: it restricts at once (fail-safe).
    expect((await db.admin.query<{ m: string[] }>('select plant.controlled_materials($1) as m', [product])).rows[0]?.m).toEqual([lot.materialCode]);
    // The recorder cannot approve it, and the approval needs the signature on this record.
    expect(await refusal(signFor(db, w.cast.qaMaster, { type: 'controlled_product', id }, 'CONTROLLED_PRODUCT_APPROVED', 'RECORDED'))).not.toBe('');
    const sig = await signFor(db, qaApprover, { type: 'controlled_product', id }, 'CONTROLLED_PRODUCT_APPROVED', 'RECORDED');
    await w.run(qaApprover, (c) => c.query('select plant.approve_controlled_product($1, $2)', [id, sig]));
    expect(await refusal(w.run(qaApprover, (c) => c.query('select plant.approve_controlled_product($1, $2)', [id, sig])))).toMatch(/EBMR-CSM-005/);
    // An unflagging recorded but not approved does not lift the flag.
    const off = await flag(product, [], false);
    expect((await db.admin.query<{ m: string[] }>('select plant.controlled_materials($1) as m', [product])).rows[0]?.m).toEqual([lot.materialCode]);
    expect((await db.admin.query<{ c: boolean }>('select plant.material_is_controlled($1) as c', [lot.materialCode])).rows[0]?.c).toBe(true);
    const offSig = await signFor(db, qaApprover, { type: 'controlled_product', id: off }, 'CONTROLLED_PRODUCT_APPROVED', 'RECORDED');
    await w.run(qaApprover, (c) => c.query('select plant.approve_controlled_product($1, $2)', [off, offSig]));
    expect((await db.admin.query<{ m: string[] }>('select plant.controlled_materials($1) as m', [product])).rows[0]?.m).toEqual([]);
    // The history is a configuration read (DI-09), and the application role writes nothing directly.
    expect(Number((await db.admin.query<{ n: string }>("select count(*)::text as n from platform.config_version where area = 'CONTROLLED_PRODUCT' and item_key = $1", [product])).rows[0]?.n)).toBe(2);
    expect(await refusal(db.app.query("insert into plant.controlled_product (product_code, controlled, material_codes, basis_ref, recorded_by_person, recorded_by_account, correlation_id) values ('X', false, '{}', 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
  });

  it('[IN-53] dispensing a controlled API with one person is refused', async () => {
    const { lot, batch, reservation } = await controlledSetup();
    // No custody record at all.
    expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1'))).toMatch(/EBMR-CSM-020/);
    // Proposed and signed by the dispenser only: still one person.
    const half = await propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' });
    expect(await signCustody(w.cast.dispenser, half)).toBe('AWAITING_COUNTERSIGN');
    expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1'))).toMatch(/EBMR-CSM-020/);
    // The same person cannot countersign (the command and the kernel refuse it).
    expect(await refusal(signCustody(w.cast.dispenser, half))).not.toBe('');
    // Countersigned by a second person: the dispensing of exactly that quantity is accepted, once.
    expect(await signCustody(w.cast.witness, half)).toBe('CONFIRMED');
    expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1.5'))).toMatch(/EBMR-CSM-020/);
    expect(await w.consume(batch, reservation, lot.materialCode, '1')).toMatchObject({ batch_id: batch.id });
    expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1'))).toMatch(/EBMR-CSM-020/);
    // A record whose custodians do not include the dispenser does not cover the dispensing.
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' }, w.cast.warehouse, w.cast.witness);
    expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1'))).toMatch(/EBMR-CSM-020/);
    // The proposer is the first custodian; an administrator never takes part; the tables are not writable.
    const other = await propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' });
    expect(await refusal(signCustody(w.cast.witness, other))).not.toBe('');
    expect(await refusal(propose(w.cast.admin, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' }))).toMatch(/EBMR-IAM/);
    expect(await refusal(db.app.query('insert into recipe.controlled_custody_use (custody_id, consumption_id) values ($1, gen_random_uuid())', [half]))).toMatch(/permission denied/);
    expect(await refusal(db.app.query("insert into recipe.controlled_custody_signature (custody_id, position, signature_id, person_id, account_id) values ($1, 'SECOND', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [other]))).toMatch(/permission denied/);
  });

  it('[IN-53] a WMS move of a controlled lot without a transfer record signed by two custodians is recorded with a location exception; one with it is clean', async () => {
    const { lot } = await controlledSetup();
    const move = (qty: string, n: string) => ({
      lotNumber: lot.lotCode, fromLocation: 'WH-A-01', toLocation: 'DISP-01', toLocationKind: 'PRODUCTION', quantity: { value: qty, unit: 'kg' }, movedAt: `18000000000000${n}`,
    });
    // Without a record: accepted whole (it already happened), with the problem, the alarm and the exception (D-P6a-7).
    const bare = (await w.inbound(w.envelope('wms.stock_move', move('1.000', '01')))).applied as { problem: string; exceptionId: string | null };
    expect(bare.problem).toMatch(/without a transfer record signed by two custodians \(IN-53\)/);
    expect(bare.exceptionId).not.toBeNull();
    // With a CONFIRMED transfer of exactly that quantity between those locations: clean, and the record is used once.
    const lot2 = (await controlledSetup()).lot;
    const t = await custody({ kind: 'TRANSFER', lotId: lot2.lotId, quantity: '2', fromLocation: 'WH-A-01', toLocation: 'DISP-01' }, w.cast.warehouse, w.cast.witness);
    const m2 = (qty: string, n: string) => ({ ...move(qty, n), lotNumber: lot2.lotCode });
    const ok = (await w.inbound(w.envelope('wms.stock_move', m2('2.000', '02')))).applied as { problem: string | null; moveId: string };
    expect(ok.problem).toBeNull();
    expect((await db.admin.query('select move_id from recipe.controlled_custody_use where custody_id = $1', [t])).rows).toEqual([{ move_id: ok.moveId }]);
    const again = (await w.inbound(w.envelope('wms.stock_move', m2('2.000', '03')))).applied as { problem: string | null };
    expect(again.problem).toMatch(/IN-53/);
    // A transfer names two different locations and is only for a controlled material.
    expect(await refusal(propose(w.cast.warehouse, { kind: 'TRANSFER', lotId: lot.lotId, quantity: '1', fromLocation: 'A', toLocation: 'A' }))).toMatch(/EBMR-CSM-013/);
    const plain = await w.releasedLot('API');
    expect(await refusal(propose(w.cast.warehouse, { kind: 'TRANSFER', lotId: plain.lotId, quantity: '1', fromLocation: 'A', toLocation: 'B' }))).toMatch(/EBMR-CSM-014/);
    // Lots of other materials move as before.
    const p = (await w.inbound(w.envelope('wms.stock_move', { ...move('1.000', '04'), lotNumber: plain.lotCode }))).applied as { problem: string | null };
    expect(p.problem).toBeNull();
  });

  it('[IN-53] a yield checkpoint with an unexplained difference of the controlled API is refused', async () => {
    const { lot, batch, reservation } = await controlledSetup();
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '2.000' });
    await w.consume(batch, reservation, lot.materialCode, '2.000');
    // The stage sign-off is refused while the account has no signed checkpoint.
    expect(await signOffRow(batch, 'S-BLEND')).toMatch(/EBMR-CSM-042 .*no checkpoint/);
    // 2.000 dispensed, 1.900 in the product, 0.050 in process: 0.050 unexplained (exact decimals, no tolerance; D-P6e-1).
    const base = { batchId: batch.id, stageKey: 'S-BLEND@', materialCode: lot.materialCode };
    expect(await refusal(recordCheckpoint({ ...base, consumed: '1.900', inProcess: '0.050' }))).toMatch(/EBMR-CSM-035 .*difference of 0\.050/);
    expect(await refusal(recordCheckpoint({ ...base, consumed: '1.999999', inProcess: '0' }))).toMatch(/EBMR-CSM-035/);
    // An explanation alone, or a deviation of another batch, is not enough.
    expect(await refusal(recordCheckpoint({ ...base, consumed: '1.900', inProcess: '0.050', explanation: 'Balance drift' }))).toMatch(/EBMR-CSM-035/);
    const elsewhere = await deviationOf(await batchOf(unique('P')));
    expect(await refusal(recordCheckpoint({ ...base, consumed: '1.900', inProcess: '0.050', explanation: 'Balance drift', deviationId: elsewhere }))).toMatch(/EBMR-CSM-036/);
    // Recorded but unsigned: the sign-off is still refused.
    const closed = await recordCheckpoint({ ...base, consumed: '1.950', inProcess: '0.050' });
    expect(await signOffRow(batch, 'S-BLEND')).toMatch(/EBMR-CSM-042 .*not signed/);
    await signCheckpoint(closed);
    expect(await signOffRow(batch, 'S-BLEND')).not.toMatch(/EBMR-CSM/);
    // A return confirmed later moves the account: the checkpoint is no longer current, and the sign-off is refused again.
    await custody({ kind: 'RETURN', lotId: lot.lotId, batchId: batch.id, quantity: '0.050' });
    expect(await signOffRow(batch, 'S-BLEND')).toMatch(/EBMR-CSM-042 .*moved since/);
    // With an explanation and the batch's deviation, a difference is recorded and signed; the sign-off passes the guard.
    const dev = await deviationOf(batch);
    const explained = await recordCheckpoint({ ...base, consumed: '1.900', inProcess: '0', explanation: 'Weighing uncertainty of the dispensing balance', deviationId: dev });
    await signCheckpoint(explained);
    expect(await signOffRow(batch, 'S-BLEND')).not.toMatch(/EBMR-CSM/);
    const row = (await db.admin.query<Json>('select difference::text as d, returned::text as r from recipe.controlled_checkpoint where id = $1', [explained])).rows[0];
    expect(row).toMatchObject({ d: '0.050', r: '0.050' });
    // The batch completes only with the account closed: a return confirmed after the last checkpoint holds it (quick review).
    expect(await completeRow(batch)).not.toMatch(/EBMR-CSM/);
    await custody({ kind: 'RETURN', lotId: lot.lotId, batchId: batch.id, quantity: '0.010' });
    expect(await completeRow(batch)).toMatch(/EBMR-CSM-043/);
    // Another stage has its own checkpoint; the table refuses a direct write.
    expect(await signOffRow(batch, 'S-COMPRESS')).toMatch(/EBMR-CSM-042/);
    expect(await refusal(db.app.query("insert into recipe.controlled_checkpoint_signature (checkpoint_id, signature_id, person_id, account_id) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [explained]))).toMatch(/permission denied/);
  });

  it('[IN-53] destruction of controlled rejects without a witness is refused', async () => {
    const { lot, batch, reservation } = await controlledSetup();
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' });
    await w.consume(batch, reservation, lot.materialCode, '1');
    // A destruction states how and why; it cannot destroy more than the batch holds.
    expect(await refusal(propose(w.cast.dispenser, { kind: 'DESTRUCTION', lotId: lot.lotId, batchId: batch.id, quantity: '0.1' }))).toMatch(/EBMR-CSM-017/);
    expect(await refusal(propose(w.cast.dispenser, { kind: 'DESTRUCTION', lotId: lot.lotId, batchId: batch.id, quantity: '1.1', note: 'Sweepings, incinerated' }))).toMatch(/EBMR-CSM-016/);
    const d = await propose(w.cast.dispenser, { kind: 'DESTRUCTION', lotId: lot.lotId, batchId: batch.id, quantity: '0.1', note: 'Rejected tablets and sweepings, incinerated (SOP-WM-04)' });
    await signCustody(w.cast.dispenser, d);
    // The performer cannot witness it; until a witness countersigns, nothing is destroyed in the account.
    expect(await refusal(signCustody(w.cast.dispenser, d))).not.toBe('');
    expect((await db.admin.query<{ b: Json }>("select recipe.controlled_balance($1, $2) as b", [batch.id, lot.materialCode])).rows[0]?.b).toMatchObject({ destroyed: '0' });
    expect(await signCustody(w.cast.witness, d)).toBe('CONFIRMED');
    expect((await db.admin.query<{ b: Json }>("select recipe.controlled_balance($1, $2) as b", [batch.id, lot.materialCode])).rows[0]?.b).toMatchObject({ dispensed: '1', destroyed: '0.1' });
    // A whole lot is destroyed in the lot register only with a witness's signature (site services 0712).
    expect(await refusal(w.run(w.cast.warehouse, async (c) => c.query('select site.destroy_lot($1, $2, $3)', [lot.lotId, await w.version(lot.lotId), randomUUID()])))).toMatch(/EBMR-SITE-15/);
  });

  it('[IN-53] the register export is reproducible (same hash)', async () => {
    const { lot, batch, reservation } = await controlledSetup();
    await custody({ kind: 'TRANSFER', lotId: lot.lotId, quantity: '3', fromLocation: 'WH-A-01', toLocation: 'DISP-01' }, w.cast.warehouse, w.cast.witness);
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '2' });
    await w.consume(batch, reservation, lot.materialCode, '2');
    const today = (await db.app.query<{ d: string }>("select (now() at time zone 'UTC')::date::text as d")).rows[0]?.d ?? '';
    const run = (): Promise<string> => one<string>(w.cast.qa, 'select recipe.run_controlled_register($1, $2::date, $3::date) as r', [lot.materialCode, '2026-01-01', today]);
    const a = await run();
    const b = await run();
    const rows = (await db.admin.query<{ id: string; h: string; r: { rows: { movement: string; persons: string[] }[] } }>(
      'select id, result_sha256 as h, result as r from recipe.controlled_register_extract where id = any ($1::uuid[]) order by recorded_at', [[a, b]])).rows;
    expect(rows[0]?.h).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.h).toBe(rows[0]?.h);
    expect((await db.admin.query<{ ok: boolean }>('select recipe.controlled_register_reproduces($1) as ok', [a])).rows[0]?.ok).toBe(true);
    expect(rows[0]?.r.rows.map((r) => r.movement)).toEqual(expect.arrayContaining(['RECEIPT', 'TRANSFER', 'DISPENSE']));
    expect(rows[0]?.r.rows.find((r) => r.movement === 'DISPENSE')?.persons).toEqual([w.cast.dispenser.personId, w.cast.witness.personId]);
    // New data changes the hash of a new run, and the stored extract no longer reproduces.
    await custody({ kind: 'RETURN', lotId: lot.lotId, batchId: batch.id, quantity: '0.5' });
    const c = await run();
    expect((await db.admin.query<{ h: string }>('select result_sha256 as h from recipe.controlled_register_extract where id = $1', [c])).rows[0]?.h).not.toBe(rows[0]?.h);
    expect((await db.admin.query<{ ok: boolean }>('select recipe.controlled_register_reproduces($1) as ok', [a])).rows[0]?.ok).toBe(false);
    // Only for a flagged material; not by a dispenser; the extract is insert-only.
    expect(await refusal(one(w.cast.qa, 'select recipe.run_controlled_register($1, $2::date, $3::date) as r', ['NOPE', '2026-01-01', today]))).toMatch(/EBMR-CSM-051/);
    expect(await refusal(one(w.cast.dispenser, 'select recipe.run_controlled_register($1, $2::date, $3::date) as r', [lot.materialCode, '2026-01-01', today]))).toMatch(/EBMR-IAM/);
    expect(await refusal(db.admin.query('update recipe.controlled_register_extract set result_sha256 = $2 where id = $1', [a, 'f'.repeat(64)]))).not.toBe('');
  });

  it('[IN-53] an unflagged product is unaffected', async () => {
    const lot = await w.releasedLot('API');
    const product = unique('P');
    const batch = await batchOf(product);
    const reservation = await w.reserve(lot.lotId, batch, '2');
    // One person dispenses, as before; no checkpoint is asked at a stage sign-off; no custody record is kept.
    expect(await w.consume(batch, reservation, lot.materialCode, '1')).toMatchObject({ batch_id: batch.id });
    expect(await signOffRow(batch, 'S-BLEND')).not.toMatch(/EBMR-CSM/);
    expect(await completeRow(batch)).not.toMatch(/EBMR-CSM/);
    expect(await refusal(propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' }))).toMatch(/EBMR-CSM-014/);
    expect((await db.admin.query<{ m: string[] }>('select plant.controlled_materials($1) as m', [product])).rows[0]?.m).toEqual([]);
    // The same API flagged for another product does not reach this product's batches.
    await flag(unique('P'), [lot.materialCode]);
    expect(await w.consume(batch, reservation, lot.materialCode, '1')).toMatchObject({ batch_id: batch.id });
  });

  it('[IN-53] the application role reads no controlled-substance table or read function directly; the writers stay granted (recipe-core 1214)', async () => {
    // Phase 7 slice 7a (6jc-R2): the edition reads them through its gated definers (CONTROLLED.READ in scope).
    const tables = ['plant.controlled_product', 'plant.controlled_product_approval', 'recipe.controlled_custody', 'recipe.controlled_custody_signature',
      'recipe.controlled_custody_use', 'recipe.controlled_checkpoint', 'recipe.controlled_checkpoint_signature', 'recipe.controlled_register_extract'];
    for (const t of tables) expect(await refusal(db.app.query(`select count(*) from ${t}`)), t).toMatch(/permission denied/);
    const id = randomUUID();
    const reads = ['plant.controlled_materials(text)', 'plant.material_is_controlled(text)', 'plant.controlled_product_state(text)', 'plant.controlled_record_state(uuid)',
      'recipe.batch_controlled_materials(uuid)', 'recipe.controlled_moved_materials(uuid)', 'recipe.controlled_custody_state(uuid)', 'recipe.controlled_custodians(uuid)',
      'recipe.controlled_balance(uuid, text)', 'recipe.controlled_checkpoint_state(uuid)', 'recipe.controlled_checkpoint_current(uuid)',
      'recipe.controlled_checkpoint_problem(uuid, text)', 'recipe.controlled_batch_end_problem(uuid)', 'recipe.controlled_register_reproduces(uuid)'];
    const may = (await db.admin.query<{ f: string; app: boolean }>(
      "select f, has_function_privilege('ebmr_app', f, 'execute') as app from unnest($1::text[]) f order by f", [reads])).rows;
    expect(may.filter((r) => r.app).map((r) => r.f)).toEqual([]);
    expect(await refusal(db.app.query('select recipe.controlled_balance($1, $2)', [id, 'API-X']))).toMatch(/permission denied/);
    const writers = ['plant.record_controlled_product(jsonb)', 'plant.approve_controlled_product(uuid, uuid)', 'recipe.propose_controlled_custody(jsonb)',
      'recipe.sign_controlled_custody(uuid, uuid)', 'recipe.record_controlled_checkpoint(jsonb)', 'recipe.sign_controlled_checkpoint(uuid, uuid)',
      'recipe.run_controlled_register(text, date, date)'];
    const granted = (await db.admin.query<{ f: string; app: boolean }>(
      "select f, has_function_privilege('ebmr_app', f, 'execute') as app from unnest($1::text[]) f order by f", [writers])).rows;
    expect(granted.filter((r) => !r.app).map((r) => r.f)).toEqual([]);
  });
});
