/**
 * Review reproducer F42: the trust level of occurred_at is whatever the caller says it is.
 *
 * platform.stub_step_entry (kernel 0530) grants the application INSERT on occurred_trust, and the
 * time-model trigger (platform.stub_step_entry_time_model) never checks the claimed trust against the
 * actor's source, the session's device or any instrument reading. platform.is_late_entry treats only
 * USER_CLAIMED and PAPER as late, and platform.time_basis drives time constraints from occurred_at
 * when the trust is DEVICE_SYNCED. So an ordinary person on a UI session, typing a time on a personal
 * terminal, can label it DEVICE_SYNCED and skip the late-entry path entirely.
 *
 * Scenario:
 *   1. A step started 3 h ago; its planned end (the kernel late-entry window) passed 30 min ago.
 *   2. Positive control: an operator (source UI, PERSONAL device, no instrument) back-dates a value
 *      by 170 min as USER_CLAIMED: refused without a reason (EBMR-PLAT-015), and with a reason but
 *      without a supervisor co-signature (EBMR-PLAT-016). So the late-entry rules are meant to apply.
 *   3. Attack: the same operator inserts the same value with the same typed time but labels it
 *      DEVICE_SYNCED.
 *
 * Safe behaviour asserted (DI-27: "client-device clocks and user-typed times are never used as the
 * time of an action"; DI-28/INV-16: a late entry goes only through the late-entry path with a reason,
 * review flag and, beyond the window, a supervisor co-signature): the person-typed DEVICE_SYNCED claim
 * is either refused with a business error, or, if accepted, it is not stored as trusted device time
 * (not DEVICE_SYNCED, time basis RECORDED_AT) and it is flagged as a late entry.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { withTriggersDisabled } from '../platform/helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

interface EntryRow {
  id: string;
  recorded_at: string;
  occurred_at: string | null;
  occurred_trust: string | null;
  time_basis: string;
  time_basis_at: string;
  is_late: boolean;
  late_window_ends_at: string | null;
  late_reason_code: string | null;
  cosignature_id: string | null;
  review_flags: string[];
  entered_by: string;
}

const ENTRY_COLUMNS = `id, recorded_at::text, occurred_at::text, occurred_trust, time_basis, time_basis_at::text, is_late,
  late_window_ends_at::text, late_reason_code, cosignature_id::text, review_flags, entered_by`;

async function newStep(actor: ActorContext): Promise<string> {
  const stepId = await withCommand(db.app, actor, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into platform.stub_step (batch_id, planned_end_at) values ($1, clock_timestamp() - interval '30 minutes') returning id`,
      [randomUUID()],
    );
    return rows[0]?.id ?? '';
  });
  // Test set-up only: the step started 3 hours ago (triggers off for this superuser transaction).
  await withTriggersDisabled(db, (c) => c.query("update platform.stub_step set started_at = started_at - interval '3 hours' where id = $1", [stepId]));
  return stepId;
}

async function addEntry(actor: ActorContext, stepId: string, trust: string, lateReason: string | null = null): Promise<EntryRow> {
  return withCommand(db.app, actor, async (c) => {
    const { rows } = await c.query<EntryRow>(
      `insert into platform.stub_step_entry (step_id, item_no, value, unit, occurred_at, occurred_trust, late_reason_code)
       values ($1, 1, 12.5, 'kg', clock_timestamp() - interval '170 minutes', $2, $3)
       returning ${ENTRY_COLUMNS}`,
      [stepId, trust, lateReason],
    );
    const row = rows[0];
    if (!row) throw new Error('no row');
    return row;
  });
}

describe('F42: trust of a claimed event time is asserted by the caller', () => {
  it('[DI-27][INV-16] a person-typed time labelled DEVICE_SYNCED from a UI session does not skip the late-entry controls', async () => {
    const operator = await seededTestActor(db); // ordinary person, source UI, PERSONAL device
    expect(operator.source).toBe('UI');
    const { rows: dev } = await db.admin.query<{ device_class: string }>('select device_class from iam.device where id = $1', [operator.deviceId]);
    expect(dev[0]?.device_class).toBe('PERSONAL');

    const stepId = await newStep(operator);

    // Positive control: the same back-dated time, honestly labelled as typed by a person.
    await expect(addEntry(operator, stepId, 'USER_CLAIMED')).rejects.toThrow('EBMR-PLAT-015');
    await expect(addEntry(operator, stepId, 'USER_CLAIMED', 'FORGOT_TO_RECORD')).rejects.toThrow('EBMR-PLAT-016');

    // Attack: the same typed time, labelled as a synchronised instrument clock.
    const outcome = await addEntry(operator, stepId, 'DEVICE_SYNCED').then(
      (row) => ({ row, error: undefined as Error | undefined }),
      (error: Error) => ({ row: undefined as EntryRow | undefined, error }),
    );

    if (outcome.error) {
      // Refused: must be a business refusal of the time model, not a set-up mistake.
      expect(outcome.error.message).toMatch(/EBMR-/);
      expect(outcome.error.message).not.toMatch(/EBMR-PLAT-018|EBMR-PLAT-014|EBMR-PLAT-013|EBMR-PLAT-012/);
      return;
    }

    // Accepted: the typed time must not be trusted as device time, and the late-entry path must apply.
    const row = outcome.row as EntryRow;
    const summary = JSON.stringify({
      occurred_trust: row.occurred_trust,
      time_basis: row.time_basis,
      is_late: row.is_late,
      review_flags: row.review_flags,
      late_reason_code: row.late_reason_code,
      cosignature_id: row.cosignature_id,
    });
    expect(row.occurred_trust, `accepted as ${summary}`).not.toBe('DEVICE_SYNCED');
    expect(row.time_basis, `accepted as ${summary}`).toBe('RECORDED_AT');
    expect(row.is_late, `accepted as ${summary}`).toBe(true);
    expect(row.review_flags, `accepted as ${summary}`).toEqual(expect.arrayContaining(['LATE_ENTRY', 'LATE_BEYOND_WINDOW']));
  });
});
