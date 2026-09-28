/**
 * Review reproducer F15: the WITNESSED rule "signed before the next step starts" (DI-35 guard
 * EBMR-ESIG-051, outline 5.5) rests on a boolean the caller supplies. esig.sign(...,
 * p_next_step_started boolean default false) hands the caller's value to esig.check_witness, which
 * refuses only when that value is true. The provider contract (0200) carries no field that tells the
 * database the next step has started, so the database never derives it from the record.
 *
 * Scenario (outline 5.5: WITNESSED means the signer watched the act; a late witness raises an
 * exception instead):
 *   1. Positive control: the witness, at a terminal in the performer's room, witnesses an act right
 *      after it is recorded, before anything else happens. Accepted. This shows the witness holds
 *      the role, is independent of the performer (INV-03) and is at an allowed terminal.
 *   2. The performer records step 1 (a manual reading, no objective evidence) and signs PERFORMED.
 *   3. The performer starts the next step: records step 2 on the same terminal and signs PERFORMED.
 *      Everything is still well inside the 5-minute witness window.
 *   4. The application now asks for a WITNESSED signature on step 1, leaving nextStepStarted out
 *      (the TypeScript wrapper and esig.sign both default it to false).
 *
 * Safe behaviour asserted: step 4 is refused with EBMR-ESIG-051 because the next step has started.
 * With the defect the database accepts the WITNESSED signature, since the only input it consults
 * is the caller's flag (the same attempt with nextStepStarted: true is refused, which shows the
 * rule exists but is decided by the application, not by the enforcement point).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { createStub, ensureSealKey, expectRefused, signStub, testActor } from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

describe('F15: WITNESSED "before the next step" is enforced by the database', () => {
  it('[DI-35][INV-03] a witness after the performer started the next step is refused even when the application omits nextStepStarted', async () => {
    const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-F15', legalName: 'Step Performer' });
    const witness = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-F15', legalName: 'Room Witness' });

    // 1. Positive control: a timely witness on an act whose next step has not started is accepted.
    const control = await createStub(db, performer, { title: 'Control: manual pressure reading', value: '1.20', unit: 'bar' });
    await signStub(db, performer, control, { meaning: 'PERFORMED' });
    const ok = await signStub(db, witness, control, { meaning: 'WITNESSED' });
    const { rows: okRows } = await db.admin.query<{ w: Record<string, unknown> }>('select witness as w from esig.signature where id = $1', [ok.signatureId]);
    expect(okRows[0]?.w).toMatchObject({ room_code: 'ROOM-F15', act_device_id: performer.deviceId });

    // 2. Step 1: the act to be witnessed.
    const step1 = await createStub(db, performer, { title: 'Step 1: manual pressure reading before binder addition', value: '1.35', unit: 'bar' });
    await signStub(db, performer, step1, { meaning: 'PERFORMED' });

    // 3. The performer starts the next step on the same terminal and completes its act.
    const step2 = await createStub(db, performer, { title: 'Step 2: binder solution added', value: '12.503', unit: 'kg' });
    await signStub(db, performer, step2, { meaning: 'PERFORMED' });

    // The record shows step 2 was entered after step 1, on the same terminal, and step 1 is still
    // inside the witness window (so neither EBMR-ESIG-052 nor EBMR-ESIG-053 applies).
    const { rows: facts } = await db.admin.query<{ later: boolean; same_device: boolean; in_window: boolean; step1_state: string }>(
      `select s2.entered_at > s1.entered_at as later,
              s2.entered_device_id = s1.entered_device_id as same_device,
              clock_timestamp() - s1.entered_at < interval '240 seconds' as in_window,
              s1.state as step1_state
         from esig.stub_signable s1, esig.stub_signable s2 where s1.id = $1 and s2.id = $2`,
      [step1, step2],
    );
    expect(facts[0]).toEqual({ later: true, same_device: true, in_window: true, step1_state: 'OPEN' });
    const { rows: s2sig } = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from esig.signature where aggregate_ref = $1 and meaning_code = 'PERFORMED'",
      [`esig_stub:${step2}`],
    );
    expect(s2sig[0]?.n).toBe(1);

    // The flag, when the application happens to pass it, is honoured (the rule exists) ...
    await expectRefused(signStub(db, witness, step1, { meaning: 'WITNESSED', nextStepStarted: true }), 'EBMR-ESIG-051');

    // 4. ... but the database must refuse the late witness on its own: the application omits the
    // flag, exactly as `select esig.sign(ch, ev, 'OPEN')` would.
    await expectRefused(signStub(db, witness, step1, { meaning: 'WITNESSED' }), 'EBMR-ESIG-051', /next step has started/);

    // Nothing was witnessed on step 1.
    const { rows: w1 } = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from esig.signature where aggregate_ref = $1 and meaning_code = 'WITNESSED'",
      [`esig_stub:${step1}`],
    );
    expect(w1[0]?.n).toBe(0);
  });
});
