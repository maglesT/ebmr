/**
 * Output containers, Phase 4 slice 1b (recipe-core 0740, 0741): a typed net quantity is checked by a second person before
 * the container is used (DI-30), and QA releases a held container only once what held it is explained: the hold's
 * exceptions dispositioned and their deviations concluded (L-30, INV-41, PR-49). Every command runs as the application
 * role inside a validated command; the bypass tests attack the tables and the state engine directly.
 *
 * Batches, exception register rows and deviation records are arranged by the superuser with triggers off
 * (asTimeTraveller), as test setup only; the rules under test are the container commands' and the release guard's.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commands } from '@ebmr/kernel';
import { errorCode } from '../../../kernel/src/commands/errors.ts';
import { asSuperuserTransaction, asTimeTraveller, challengeFor, expectPermissionDenied, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as oc from '../../src/containers/index.ts';
import * as plant from '../../src/plant/index.ts';

let db: TestDatabase;
let operator: SeededActor;
let verifier: SeededActor;
let qa: SeededActor;
let steward: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator' });
  verifier = await seedActor(db, { roleCode: 'VERIFIER', legalName: 'Vera Verifier' });
  qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Qamar QA' });
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Sana Steward' });
}, 180_000);
afterAll(async () => {
  await db.drop();
});

let serial = 0;
interface Batch {
  id: string;
}

async function newBatch(): Promise<Batch> {
  const id = randomUUID();
  const number = `TEST-${randomUUID().slice(0, 8).toUpperCase()}${serial++}`;
  const hash = createHash('sha256').update(id).digest('hex');
  const product = { code: 'ATV-40', name: 'Atorvastatin tablets', strength: '40 mg' };
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
  return { id };
}

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

const open = (b: Batch, press?: string): Promise<oc.ContainerRef> =>
  run(db, operator, (c) => oc.openContainer(c, { batchId: b.id, stage: 'COMPRESSION', unit: 'kg', ...(press ? { pressCode: press } : {}) }));
const closeTyped = (ref: oc.ContainerRef, qty = '12.500'): Promise<oc.ContainerRef> => run(db, operator, (c) => oc.closeContainer(c, ref.containerId, qty, ref.version));
async function status(ref: oc.ContainerRef): Promise<oc.ContainerStatus> {
  const s = await oc.containerStatus(db.app, ref.containerId);
  if (!s) throw new Error('no container');
  return s;
}
async function signOn(who: SeededActor, ref: oc.ContainerRef, meaning: string): Promise<string> {
  const ch = await challengeFor(db, who, ref.containerId, { meaning, aggregateType: 'output_container' });
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  return (await signWith(db, who, ch.challengeId, ev, { expectedState: (await status(ref)).state })).signatureId;
}
async function verifyNet(who: SeededActor, ref: oc.ContainerRef): Promise<void> {
  const sig = await signOn(who, ref, oc.CONTAINER_NET_VERIFY_MEANING);
  await run(db, who, (c) => oc.verifyContainerClose(c, ref.containerId, sig));
}
const charge = (b: Batch, label: string) => run(db, operator, (c) => oc.chargeContainer(c, b.id, 'COATING', label));
let pressSerial = 0;
async function press(): Promise<string> {
  const n = `${pressSerial++}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const classCode = `CL-PRESS-${n}`;
  await run(db, steward, (c) => plant.defineEquipmentClass(c, { code: classCode, kind: 'PROCESS', description: 'Rotary tablet press', cleanHold: '72 hours', dirtyHold: '48 hours', calibrationRequired: false }));
  const code = `PRESS-${n}`;
  await run(db, steward, (c) => plant.defineEquipment(c, { code, name: `Press ${code}`, classCode }));
  return code;
}

describe('a typed net quantity is checked by a second person (recipe-core 0740)', () => {
  it('[DI-30][L-30] a typed close leaves the container unusable and unreleasable until a second person verifies it with their VERIFIED signature', async () => {
    const b = await newBatch();
    const ref = await closeTyped(await open(b), '9.750');
    expect(ref.state).toBe('CLOSED');
    expect((await status(ref)).usableProblem).toMatch(/typed net quantity .* has not been verified by a second person/);
    await expectRefused(charge(b, ref.labelCode), 'EBMR-CNT-042', /second person/);
    expect(await oc.containerReleaseProblem(db.app, ref.containerId)).toMatch(/EBMR-CNT-050/);
    await verifyNet(verifier, ref);
    expect((await status(ref)).usableProblem).toBeNull();
    const { rows } = await db.app.query<{ basis: string; person_id: string }>(
      'select x.basis, v.person_id from plant.container_close x join plant.container_close_verification v on v.container_id = x.container_id where x.container_id = $1',
      [ref.containerId],
    );
    expect(rows).toEqual([{ basis: 'TYPED', person_id: verifier.personId }]);
    // The signed content shows the net, its basis and the closer. Who verified it is the verification's own record (the row
    // above and its VERIFIED signature), not part of the content that signature stands over (issue #95, INV-09).
    const content = (await db.admin.query<{ c: { content: Record<string, unknown> } }>('select plant.output_container_content($1) as c', [ref.containerId])).rows[0]?.c.content;
    expect(content).toMatchObject({ net_quantity: '9.750', close_basis: 'TYPED', closed_by: operator.personId });
    expect(content).not.toHaveProperty('net_verified_by');
    await expectRefused(verifyNet(await seedActor(db, { roleCode: 'VERIFIER', legalName: 'Val Second' }), ref), 'EBMR-CNT-046');
    expect((await charge(b, ref.labelCode)).netQuantity).toBe('9.750');
  });

  it('[DI-30][INV-03] the closer never verifies their own close: refused by the signature service, the command and the row guard', async () => {
    const b = await newBatch();
    const ref = await closeTyped(await open(b), '4.000');
    // The closer (an operator, a performer in the signed content) cannot sign VERIFIED on it.
    await expect(verifyNet(operator, ref)).rejects.toThrow();
    // A closer who holds STEP.VERIFY as well: the command refuses them even with another person's signature in hand.
    const both = await seedActor(db, { roleCode: 'VERIFIER', legalName: 'Bo Both' });
    await asTimeTraveller(db, 'update plant.container_close set person_id = $2 where container_id = $1', [ref.containerId, both.personId]);
    const sig = await signOn(verifier, ref, oc.CONTAINER_NET_VERIFY_MEANING);
    await expectRefused(run(db, both, (c) => oc.verifyContainerClose(c, ref.containerId, sig)), 'EBMR-CNT-048');
    // Bypass: the application role cannot write the verification; an owner-level write naming the closer is refused by the guard.
    await expectPermissionDenied(
      db.app.query('insert into plant.container_close_verification (container_id, signature_id, person_id, account_id) values ($1, $2, $3, $3)', [ref.containerId, sig, verifier.personId]),
    );
    await expect(
      asSuperuserTransaction(db, async (c) => {
        await c.query('set local role ebmr_owner');
        await c.query('insert into plant.container_close_verification (container_id, signature_id, person_id, account_id) values ($1, $2, $3, $3)', [ref.containerId, sig, both.personId]);
      }),
    ).rejects.toThrow(/EBMR-CNT-048/);
    // ... and one whose signature is not the verifier's own.
    await expect(
      asSuperuserTransaction(db, async (c) => {
        await c.query('set local role ebmr_owner');
        await c.query('insert into plant.container_close_verification (container_id, signature_id, person_id, account_id) values ($1, $2, $3, $3)', [ref.containerId, sig, qa.personId]);
      }),
    ).rejects.toThrow(/EBMR-CNT-049/);
    expect((await status(ref)).usableProblem).toMatch(/second person/);
  });

  it('[DI-30] the application role cannot write a close with a forged basis nor call the internal close; a close without a basis is refused by the table', async () => {
    const b = await newBatch();
    const ref = await open(b);
    await expectPermissionDenied(
      db.app.query("insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) values ($1, 1, $2, $2, 'WEIGHED', '{}')", [ref.containerId, operator.personId]),
    );
    await expectPermissionDenied(db.app.query("select plant.container_close_record($1, 1, 1, 'WEIGHED', '{}'::jsonb, '{}'::jsonb)", [ref.containerId]));
    await expect(
      asTimeTraveller(db, 'insert into plant.container_close (container_id, net_quantity, person_id, account_id) values ($1, 1, gen_random_uuid(), gen_random_uuid())', [ref.containerId]),
    ).rejects.toThrow(/container_close_basis_given/);
  });
});

describe('QA releases a held container only once its hold is explained (recipe-core 0741)', () => {
  async function exception(b: Batch, id: string, step: string | null, type = 'IPC_CHECK_FAILED', severity = 'ACTION'): Promise<void> {
    await asTimeTraveller(
      db,
      `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, title, raising_step_key, raising_step, raised_at, raised_at_us,
                                              raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
       values ($1, $2, 1, $3, 'OUT_OF_LIMIT', $5, 'x', $4, $4, clock_timestamp(), 0, 'OP1', gen_random_uuid(), true, false, $5 <> 'ALERT', false, false, 'DEVIATION', '{}', gen_random_uuid())`,
      [b.id, id, type, step, severity],
    );
  }
  async function act(b: Batch, id: string, kind: 'DISPOSITIONED' | 'DEVIATION_LINKED', ref?: string): Promise<void> {
    await asTimeTraveller(
      db,
      `insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, deviation_ref, note, correlation_id)
       values ($1, $2, $3, 2, gen_random_uuid(), gen_random_uuid(), 'QA', case when $3 = 'DISPOSITIONED' then 'DEVIATION_RAISED' end,
               case when $3 = 'DISPOSITIONED' then gen_random_uuid() end, $4, 'test arrangement', gen_random_uuid())`,
      [b.id, id, kind, ref ?? null],
    );
  }
  async function deviation(state: 'OPEN' | 'UNDER_INVESTIGATION' | 'CLOSED' | 'CANCELLED'): Promise<string> {
    const id = randomUUID();
    const serialNo = 10000 + serial++;
    const ref = `DEV-SITE-1-2026-${String(serialNo)}`;
    await asTimeTraveller(
      db,
      `insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id)
       values ($1, $2, 'SITE-1', 2026, $3, 'DEVIATION', 'IPC failure', 'MAJOR', 'weight outside the action limit', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [id, ref, serialNo],
    );
    if (state === 'UNDER_INVESTIGATION') await asTimeTraveller(db, "insert into site.deviation_event (deviation_id, event, person_id, account_id) values ($1, 'INVESTIGATION_STARTED', gen_random_uuid(), gen_random_uuid())", [id]);
    if (state === 'CLOSED') await closeDeviation(ref);
    if (state === 'CANCELLED') await asTimeTraveller(db, "insert into site.deviation_event (deviation_id, event, reason, person_id, account_id) values ($1, 'CANCELLED', 'raised in error', gen_random_uuid(), gen_random_uuid())", [id]);
    return ref;
  }
  const closeDeviation = (ref: string) =>
    asTimeTraveller(db, "insert into site.deviation_event (deviation_id, event, signature_id, person_id, account_id) select id, 'CLOSED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from site.deviation where ref = $1", [ref]);
  /** A verified closed container of a new batch, held by a check with `reference`. */
  async function heldBy(result: oc.IpcResult, reference: string): Promise<{ b: Batch; ref: oc.ContainerRef }> {
    const b = await newBatch();
    const p = await press();
    const ref = await closeTyped(await open(b, p));
    await verifyNet(verifier, ref);
    await run(db, operator, (c) => oc.recordIpcCheck(c, { batchId: b.id, pressCode: p, result, reference }));
    const s = await status(ref);
    expect(s.state).toBe('HELD');
    return { b, ref: { ...ref, state: s.state, version: s.version } };
  }
  /** QA's release signature, made once per container (a second one would be refused, EBMR-ESIG-042). */
  const sigs = new Map<string, string>();
  const release = async (ref: oc.ContainerRef) => {
    const sig = sigs.get(ref.containerId) ?? (await signOn(qa, ref, oc.CONTAINER_RELEASE_MEANING));
    sigs.set(ref.containerId, sig);
    return run(db, qa, (c) => oc.releaseContainer(c, ref.containerId, ref.version, sig));
  };

  it('[L-30][INV-41] refused while the hold\'s exception is open; released once it is dispositioned and its deviation concluded or closed', async () => {
    const { b, ref } = await heldBy('FAIL', 'TB11:p-ipc@:1');
    await exception(b, 'EX-1', 'p-ipc@');
    await expectRefused(release(ref), 'EBMR-CNT-052', /exception EX-1 \(IPC_CHECK_FAILED\) of step p-ipc@ is still open/);
    const dev = await deviation('UNDER_INVESTIGATION');
    await act(b, 'EX-1', 'DEVIATION_LINKED', dev);
    await act(b, 'EX-1', 'DISPOSITIONED');
    await expectRefused(release(ref), 'EBMR-CNT-053', new RegExp(`deviation ${dev} linked to exception EX-1 is UNDER_INVESTIGATION`));
    // An open exception of another step, or an ALERT of the same step, does not hold this container back.
    await exception(b, 'EX-2', 'p-other@');
    await exception(b, 'EX-3', 'p-ipc@', 'IPC_MANUAL_ENTRY', 'ALERT');
    await closeDeviation(dev);
    expect(await oc.containerReleaseProblem(db.app, ref.containerId)).toBeNull();
    expect((await release(ref)).state).toBe('RELEASED_BY_QA');
  });

  it('[L-30][PR-49] a linked deviation that is open, cancelled or names no record keeps the container held', async () => {
    for (const linked of [await deviation('OPEN'), await deviation('CANCELLED'), 'DEV-NOWHERE-2026-00001']) {
      const { b, ref } = await heldBy('FAIL', 'TB11:p-ipc@:1');
      await exception(b, 'EX-1', 'p-ipc@');
      await act(b, 'EX-1', 'DEVIATION_LINKED', linked);
      await act(b, 'EX-1', 'DISPOSITIONED');
      await expectRefused(release(ref), 'EBMR-CNT-053', /released once the investigation is concluded/);
    }
  });

  it('[L-30][INV-41] a hold whose check names no step of the register waits for every open exception of the batch', async () => {
    const { b, ref } = await heldBy('FAIL', 'L-29: batch data changed after set-up of print job 7');
    await exception(b, 'EX-9', 'p-anywhere@');
    await expectRefused(release(ref), 'EBMR-CNT-052', /EX-9/);
    await act(b, 'EX-9', 'DISPOSITIONED');
    expect((await release(ref)).state).toBe('RELEASED_BY_QA');
  });

  it('[L-30][TB-11] a hold the sweeper\'s alarm recorded is not explained until the step records the missed check, then its disposition', async () => {
    const { b, ref } = await heldBy('MISSED', 'TB11:p-ipc@:OVERDUE:1800000000000000');
    await expectRefused(release(ref), 'EBMR-CNT-051', /the step has not recorded the missed check yet/);
    await exception(b, 'EX-M', 'p-ipc@', 'IPC_CHECK_MISSED');
    await expectRefused(release(ref), 'EBMR-CNT-052', /EX-M/);
    await act(b, 'EX-M', 'DISPOSITIONED');
    expect((await release(ref)).state).toBe('RELEASED_BY_QA');
  });

  it('[L-30][INV-41] bypass: a RELEASE through platform.transition called directly is refused the same way', async () => {
    const { b, ref } = await heldBy('FAIL', 'TB11:p-ipc@:1');
    await exception(b, 'EX-1', 'p-ipc@');
    const sig = await signOn(qa, ref, oc.CONTAINER_RELEASE_MEANING);
    await expectRefused(
      run(db, qa, async (c) => {
        try {
          await c.query("select platform.transition('output_container', 'output_container', $1, 'RELEASE', $2, jsonb_build_object('signature_id', $3::text))", [ref.containerId, ref.version, sig]);
        } catch (e) {
          throw commands.asKernelError(e);
        }
      }),
      'EBMR-CNT-052',
    );
    expect((await status(ref)).state).toBe('HELD');
  });
});
