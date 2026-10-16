/**
 * Review reproducer F72: a denied platform permission (EBMR-PLAT-006) leaves no stored authority
 * evaluation, so the failed check is not logged (DI-17, DI-19, INV-26).
 *
 * iam.platform_authority (packages/kernel/sql/0710_authorization_scope_and_platform.sql) stores the
 * evaluation with iam.evaluate_authority inside the command; platform.authorize (0500) then raises
 * EBMR-PLAT-006 and the whole command, including the stored evaluation, rolls back. withGuardedCommand
 * (packages/kernel/src/identity/authority.ts) re-logs only EBMR-IAM-040 / EBMR-IAM-041 refusals outside
 * the rolled-back transaction, not EBMR-PLAT-006.
 *
 * Scenario:
 *   1. control: an OPERATOR attempts records.place_legal_hold through withGuardedCommand; it is refused
 *      with EBMR-IAM-040 and a denied evaluation of RECORD.LEGAL_HOLD is stored for that person
 *      (the documented "a failed check blocks the action and is logged" path works);
 *   2. the same kind of OPERATOR attempts platform.set_setting('time.drift_alarm_threshold_s', '5')
 *      (with a reason, so the refusal comes from the authority check) through withGuardedCommand;
 *   3. and platform.register_time_source(...) through withGuardedCommand.
 *
 * Safe behaviour asserted: steps 2 and 3 are refused with EBMR-PLAT-006 AND each refusal is logged:
 * iam.authority_evaluation holds at least one row, all denied, for PLATFORM.SETTINGS_CHANGE and
 * PLATFORM.TIME_SOURCE_MANAGE for that person. The setting itself is unchanged.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../../src/db/command.ts';
import { withGuardedCommand } from '../../src/identity/authority.ts';
import { placeLegalHold } from '../../src/records/retention-store.ts';
import { seedActor, seedAdministration, withReason } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  await seedAdministration(db);
});
afterAll(async () => {
  await db.drop();
});

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });

async function evaluations(personId: string, permission: string): Promise<{ allowed: boolean }[]> {
  const { rows } = await db.app.query<{ allowed: boolean }>(
    'select allowed from iam.authority_evaluation where person_id = $1 and permission_code = $2',
    [personId, permission],
  );
  return rows;
}

describe('F72: a refused platform permission (EBMR-PLAT-006) is logged like any failed authority check', () => {
  it('[DI-17][INV-26] an operator refused a setting change or a time-source registration leaves a stored denied evaluation', async () => {
    // 1. Control: an iam.require_permission refusal (EBMR-IAM-040) is re-logged by withGuardedCommand.
    const control = await seedActor(db, { roleCode: 'OPERATOR', acknowledgeEsig: false });
    await expect(
      withGuardedCommand(db.app, again(control), (c) => placeLegalHold(c, 'batch', randomUUID(), 'claim')),
    ).rejects.toThrow(/EBMR-IAM-040 .*RECORD\.LEGAL_HOLD/);
    const holdLog = await evaluations(control.personId, 'RECORD.LEGAL_HOLD');
    expect(holdLog.length).toBeGreaterThanOrEqual(1);
    expect(holdLog.every((r) => !r.allowed)).toBe(true);

    const operator = await seedActor(db, { roleCode: 'OPERATOR', acknowledgeEsig: false });
    const before = (await db.app.query<{ v: string }>("select platform.setting_text('time.drift_alarm_threshold_s') as v")).rows[0]?.v;

    // 2. Weakening the drift-alarm threshold is refused by the platform authority check ...
    await expect(
      withGuardedCommand(db.app, underChange(withReason(operator, 'CHANGE_CONTROL', 'CC-F72')), (c) =>
        c.query("select platform.set_setting('time.drift_alarm_threshold_s', '5')"),
      ),
    ).rejects.toThrow(/EBMR-PLAT-006 permission platform\.settings\.change denied: .*PLATFORM\.SETTINGS_CHANGE/);
    const after = (await db.app.query<{ v: string }>("select platform.setting_text('time.drift_alarm_threshold_s') as v")).rows[0]?.v;
    expect(after).toBe(before);

    // 3. ... and so is registering a time source.
    await expect(
      withGuardedCommand(db.app, again(operator), (c) =>
        c.query("select platform.register_time_source($1, 'NTP', 'ntp.example', 'NPL India', gen_random_uuid(), 'VAL-TS-F72')", [
          `F72 ${randomBytes(3).toString('hex')}`,
        ]),
      ),
    ).rejects.toThrow(/EBMR-PLAT-006 .*PLATFORM\.TIME_SOURCE_MANAGE/);

    // Each failed check must be logged (DI-17 "a failed check blocks the action and is logged"; INV-26).
    const settingLog = await evaluations(operator.personId, 'PLATFORM.SETTINGS_CHANGE');
    const timeSourceLog = await evaluations(operator.personId, 'PLATFORM.TIME_SOURCE_MANAGE');
    expect({ settingsChange: settingLog.length >= 1, timeSourceManage: timeSourceLog.length >= 1 }).toEqual({
      settingsChange: true,
      timeSourceManage: true,
    });
    expect([...settingLog, ...timeSourceLog].every((r) => !r.allowed)).toBe(true);
  });
});
