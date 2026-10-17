/**
 * Controlled-substance mode, rule by rule (SQL mutation group "controlled-substance-mode": recipe-core 1031 to 1033).
 * These tests close the gaps the Phase 6 exit SQL mutation run found in the high-risk rules of draft control IN-53:
 * each custody, checkpoint and flag signature is recorded only by the person who gave it and only in the state it was
 * given in; a custody act never exceeds what the lot holds or what the batch still holds of it (dispensed less returned
 * and destroyed, counting what waits for its countersignature); a pending flag of a product counts at once even over
 * an approved one; and a stage sign-off reads the checkpoint of its own stage, batch and material, for every
 * controlled API that moved into the batch, however it moved. The kernel's own refusal of a second custodian who is the
 * first (the witness meaning excludes the proposer) is asserted where the command's check stands behind it.
 *
 * Batch records are fixtures written by the superuser with triggers off (lots/support.ts); every rule under test runs
 * as the application role through the definers with real e-signatures of seeded people.
 *
 * Controls: IN-53 (draft); DI-35; invariant INV-03.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { withChangeRecord } from '../../../kernel/test/support/change-record.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { ErpWorld } from '../erp-wms/support.ts';
import { refusal, unique, type Batch } from '../lots/support.ts';

let db: TestDatabase;
let w: ErpWorld;
let supervisor: SeededActor;
let stageResponsible: SeededActor;
let qaReviewer: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ErpWorld.create(db);
  supervisor = await signerActor(db, 'SHIFT_SUPERVISOR');
  stageResponsible = await signerActor(db, 'STAGE_RESPONSIBLE');
  qaReviewer = await signerActor(db, 'QA_REVIEWER');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const one = async <T>(who: SeededActor, sql: string, params: unknown[] = []): Promise<T> =>
  w.run(who, async (c) => ((await c.query<{ r: T }>(sql, params)).rows[0] as { r: T }).r);

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

async function flag(product: string, materials: string[], approve = true): Promise<string> {
  const ctx = await withChangeRecord(db, w.cast.qaMaster);
  const id = await one<string>(ctx, 'select plant.record_controlled_product($1::jsonb) as r', [
    JSON.stringify({ productCode: product, controlled: materials.length > 0, materialCodes: materials, basisRef: 'NDPS manufacturing licence ML-17 (draft)' }),
  ]);
  if (approve) {
    const sig = await signFor(db, w.cast.qa, { type: 'controlled_product', id }, 'CONTROLLED_PRODUCT_APPROVED', 'RECORDED');
    await w.run(w.cast.qa, (c) => c.query('select plant.approve_controlled_product($1, $2)', [id, sig]));
  }
  return id;
}

const propose = (who: SeededActor, p: Json): Promise<string> => one<string>(who, 'select recipe.propose_controlled_custody($1::jsonb) as r', [JSON.stringify(p)]);
const custodyState = async (id: string): Promise<string> =>
  (await db.app.query<{ s: string }>('select recipe.controlled_custody_state($1) as s', [id])).rows[0]?.s ?? '';
const recordCustodySig = (who: SeededActor, id: string, sig: string): Promise<string> => one<string>(who, 'select recipe.sign_controlled_custody($1, $2) as r', [id, sig]);

async function signCustody(who: SeededActor, id: string): Promise<string> {
  const state = await custodyState(id);
  const meaning = state === 'PROPOSED' ? 'CONTROLLED_CUSTODY_RECORDED' : 'CONTROLLED_CUSTODY_COUNTERSIGNED';
  return recordCustodySig(who, id, await signFor(db, who, { type: 'controlled_custody', id }, meaning, state));
}

async function custody(p: Json, first: SeededActor = w.cast.dispenser, second: SeededActor = w.cast.witness): Promise<string> {
  const id = await propose(first, p);
  await signCustody(first, id);
  expect(await signCustody(second, id)).toBe('CONFIRMED');
  return id;
}

async function controlledSetup(): Promise<{ lot: { lotId: string; materialCode: string }; product: string; batch: Batch; reservation: string }> {
  const lot = await w.releasedLot('API');
  const product = unique('P');
  await flag(product, [lot.materialCode]);
  const batch = await batchOf(product);
  const reservation = await w.reserve(lot.lotId, batch, '5');
  return { lot, product, batch, reservation };
}

const recordCheckpoint = (who: SeededActor, p: Json): Promise<string> => one<string>(who, 'select recipe.record_controlled_checkpoint($1::jsonb) as r', [JSON.stringify(p)]);
async function signCheckpoint(id: string): Promise<void> {
  const sig = await signFor(db, supervisor, { type: 'controlled_checkpoint', id }, 'CONTROLLED_BALANCE_SIGNED', 'RECORDED');
  await w.run(supervisor, (c) => c.query('select recipe.sign_controlled_checkpoint($1, $2)', [id, sig]));
}

/** A SIGN_OFF_STAGE row of stage `stage` written by the superuser with triggers on, rolled back after. */
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

describe('controlled-substance mode, rule by rule (IN-53, draft; recipe-core 1031 to 1033)', () => {
  it('[IN-53][INV-03] dual custody: a countersignature is recorded only by its signer and only in the state it was given in; the kernel refuses the first custodian as the second', async () => {
    const { lot, batch } = await controlledSetup();
    const id = await propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' });
    // The witness signs the countersignature before the first custodian has signed: it was given in PROPOSED.
    const early = await signFor(db, w.cast.witness, { type: 'controlled_custody', id }, 'CONTROLLED_CUSTODY_COUNTERSIGNED', 'PROPOSED');
    expect(await signCustody(w.cast.dispenser, id)).toBe('AWAITING_COUNTERSIGN');
    expect(await refusal(recordCustodySig(w.cast.witness, id, early))).toMatch(/EBMR-CSM-023 signature .* was applied while the record was in state PROPOSED/);
    // The first custodian cannot obtain the second signature at all (witness meaning: independent of the first, excludes the proposer).
    expect(await refusal(signFor(db, w.cast.dispenser, { type: 'controlled_custody', id }, 'CONTROLLED_CUSTODY_COUNTERSIGNED', 'AWAITING_COUNTERSIGN'))).toMatch(/EBMR-ESIG/);
    expect(await custodyState(id)).toBe('AWAITING_COUNTERSIGN');
    // On another record: a third custodian cannot record the witness's countersignature as their own.
    const id2 = await propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' });
    expect(await signCustody(w.cast.dispenser, id2)).toBe('AWAITING_COUNTERSIGN');
    const witnessSig = await signFor(db, w.cast.witness, { type: 'controlled_custody', id: id2 }, 'CONTROLLED_CUSTODY_COUNTERSIGNED', 'AWAITING_COUNTERSIGN');
    expect(await refusal(recordCustodySig(w.cast.warehouse, id2, witnessSig))).toMatch(/EBMR-CSM-023 a custodian records the signature they gave themselves/);
    expect(await custodyState(id2)).toBe('AWAITING_COUNTERSIGN');
    expect(await recordCustodySig(w.cast.witness, id2, witnessSig)).toBe('CONFIRMED');
    expect((await db.app.query<{ c: string[] }>('select recipe.controlled_custodians($1) as c', [id2])).rows[0]?.c).toEqual([w.cast.dispenser.personId, w.cast.witness.personId]);
  });

  it('[IN-53][DI-35] a checkpoint signature and a flag approval are recorded only by the person who gave them', async () => {
    const { lot, batch, reservation } = await controlledSetup();
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '1' });
    await w.consume(batch, reservation, lot.materialCode, '1');
    const k = await recordCheckpoint(supervisor, { batchId: batch.id, stageKey: 'S-BLEND@', materialCode: lot.materialCode, consumed: '1', inProcess: '0' });
    const theirs = await signFor(db, stageResponsible, { type: 'controlled_checkpoint', id: k }, 'CONTROLLED_BALANCE_SIGNED', 'RECORDED');
    expect(await refusal(w.run(supervisor, (c) => c.query('select recipe.sign_controlled_checkpoint($1, $2)', [k, theirs])))).toMatch(/EBMR-CSM-041 the checkpoint is signed by the person recording the signature/);
    await w.run(stageResponsible, (c) => c.query('select recipe.sign_controlled_checkpoint($1, $2)', [k, theirs]));
    // The flag: the approver's signature recorded by another QA person is refused.
    const other = await w.releasedLot('API');
    const rec = await flag(unique('P'), [other.materialCode], false);
    const approverSig = await signFor(db, w.cast.qa, { type: 'controlled_product', id: rec }, 'CONTROLLED_PRODUCT_APPROVED', 'RECORDED');
    expect(await refusal(w.run(qaReviewer, (c) => c.query('select plant.approve_controlled_product($1, $2)', [rec, approverSig])))).toMatch(/EBMR-CSM-007 the approval is recorded by the person who signed it/);
    await w.run(w.cast.qa, (c) => c.query('select plant.approve_controlled_product($1, $2)', [rec, approverSig]));
  });

  it('[IN-53] a pending flag that adds a controlled API counts at once, also over an approved flag (fail-safe)', async () => {
    const m1 = (await w.releasedLot('API')).materialCode;
    const m2 = (await w.releasedLot('API')).materialCode;
    const product = unique('P');
    await flag(product, [m1]);
    await flag(product, [m1, m2], false);
    expect((await db.app.query<{ m: string[] }>('select plant.controlled_materials($1) as m', [product])).rows[0]?.m).toEqual([m1, m2].sort());
  });

  it('[IN-53] a custody act is a positive decimal in the lot\'s unit, never more than the lot holds, and a dispensing goes only into a running batch', async () => {
    const { lot, product, batch } = await controlledSetup();
    const held = (await db.app.query<{ q: string }>('select site.lot_quantity($1)::text as q', [lot.lotId])).rows[0]?.q ?? '';
    expect(held).toMatch(/^10(\.0+)?$/);
    const dispense = (quantity: string, extra: Json = {}) => propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity, ...extra });
    const transfer = (quantity: string) => propose(w.cast.warehouse, { kind: 'TRANSFER', lotId: lot.lotId, quantity, fromLocation: 'WH-A-01', toLocation: 'DISP-01' });
    expect(await refusal(dispense('0'))).toMatch(/EBMR-CSM-012/);
    expect(await refusal(dispense('1.1234567'))).toMatch(/EBMR-CSM-012/);
    expect(await refusal(dispense('1', { unit: 'g' }))).toMatch(/EBMR-CSM-012/);
    expect(await refusal(dispense('10.000001'))).toMatch(/EBMR-CSM-012 lot .* more cannot be dispensed/);
    expect(await refusal(dispense('10'))).toBe('');
    expect(await refusal(transfer('10.000001'))).toMatch(/EBMR-CSM-012 lot .* more cannot be transferred/);
    expect(await refusal(transfer('10'))).toBe('');
    const done = await batchOf(product, 'EXECUTION_COMPLETE');
    expect(await refusal(propose(w.cast.dispenser, { kind: 'DISPENSE', lotId: lot.lotId, batchId: done.id, quantity: '1' }))).toMatch(/EBMR-CSM-015 the batch is EXECUTION_COMPLETE/);
  });

  it('[IN-53] a return or destruction never exceeds what this batch holds of this lot: its own consumption, less its own returns and destructions awaiting or confirmed', async () => {
    const { lot, product, batch, reservation } = await controlledSetup();
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '2' });
    await w.consume(batch, reservation, lot.materialCode, '2');
    // Another batch of the same lot holds 1 more; it does not count for this batch.
    const other = await batchOf(product);
    const r2 = await w.reserve(lot.lotId, other, '5');
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: other.id, quantity: '1' });
    await w.consume(other, r2, lot.materialCode, '1');
    const back = (quantity: string) => propose(w.cast.dispenser, { kind: 'RETURN', lotId: lot.lotId, batchId: batch.id, quantity });
    expect(await refusal(back('2.5'))).toMatch(/EBMR-CSM-016 the batch holds 2(\.0+)? /);
    // 1.5 returned and waiting for the countersignature counts at once; 0.5 is left.
    const first = await back('1.5');
    await signCustody(w.cast.dispenser, first);
    expect(await refusal(back('1'))).toMatch(/EBMR-CSM-016 the batch holds 0\.50* /);
    // A proposal not yet signed by its first custodian does not count; exactly what is left may be returned.
    await back('0.2');
    expect(await refusal(back('0.5'))).toBe('');
  });

  it('[IN-53] a stage sign-off reads the checkpoint of its own stage and batch: a signed checkpoint of another stage or of another batch does not close it', async () => {
    const { lot, product, batch, reservation } = await controlledSetup();
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: batch.id, quantity: '2' });
    await w.consume(batch, reservation, lot.materialCode, '2');
    await signCheckpoint(await recordCheckpoint(supervisor, { batchId: batch.id, stageKey: 'S-BLEND@', materialCode: lot.materialCode, consumed: '2', inProcess: '0' }));
    expect(await signOffRow(batch, 'S-BLEND')).not.toMatch(/EBMR-CSM/);
    expect(await signOffRow(batch, 'S-COMPRESS')).toMatch(/EBMR-CSM-042 .*no checkpoint at stage S-COMPRESS@/);
    const other = await batchOf(product);
    const r2 = await w.reserve(lot.lotId, other, '5');
    await custody({ kind: 'DISPENSE', lotId: lot.lotId, batchId: other.id, quantity: '1' });
    await w.consume(other, r2, lot.materialCode, '1');
    expect(await signOffRow(other, 'S-BLEND')).toMatch(/EBMR-CSM-042 .*no checkpoint at stage S-BLEND@/);
  });

  it('[IN-53] the account covers every controlled API that moved into the batch, also one consumed before the flag, and only the controlled API', async () => {
    // Consumed by one person while the product was not flagged; the flag then takes effect: the stage asks for its checkpoint.
    const lot = await w.releasedLot('API');
    const product = unique('P');
    const batch = await batchOf(product);
    const reservation = await w.reserve(lot.lotId, batch, '2');
    await w.consume(batch, reservation, lot.materialCode, '1');
    expect(await signOffRow(batch, 'S-BLEND')).not.toMatch(/EBMR-CSM/);
    await flag(product, [lot.materialCode]);
    expect(await signOffRow(batch, 'S-BLEND')).toMatch(/EBMR-CSM-042 .*no checkpoint at stage S-BLEND@/);
    // A flagged product's batch that consumed only an excipient has no controlled account to close.
    const api = await controlledSetup();
    const exc = await w.releasedLot('EXCIPIENT');
    const rExc = await w.reserve(exc.lotId, api.batch, '2');
    await w.consume(api.batch, rExc, exc.materialCode, '1');
    expect(await signOffRow(api.batch, 'S-BLEND')).not.toMatch(/EBMR-CSM/);
    // Once the API is dispensed, the account counts the API alone (not the excipient).
    await custody({ kind: 'DISPENSE', lotId: api.lot.lotId, batchId: api.batch.id, quantity: '1' });
    await w.consume(api.batch, api.reservation, api.lot.materialCode, '1');
    expect((await db.app.query<{ b: Json }>('select recipe.controlled_balance($1, $2) as b', [api.batch.id, api.lot.materialCode])).rows[0]?.b).toMatchObject({ dispensed: '1', unit: 'kg' });
  });
});
