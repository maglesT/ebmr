/**
 * Review reproducer F70: a single system administrator can rewrite the least-privilege
 * permission-to-role map at runtime with iam.add_role_permission (0120:550). The function checks
 * only IAM.ROLE_MANAGE (held by SYSTEM_ADMINISTRATOR alone), takes no second approver and no
 * change-control reference, and the only catalogue guard (iam.role_permission_guard, 0120:406)
 * blocks mixing ADMINISTRATION and GMP permissions in one role. So one administrator can:
 *   - add a GMP-WRITE permission (RECORD.LEGAL_HOLD) to a kernel GMP role (OPERATOR), after which
 *     every operator places legal holds, bypassing the DI-17 map shipped in 0700; and
 *   - add a GOVERNANCE permission (PLATFORM.ALARM_CLEAR) to their own SYSTEM_ADMINISTRATOR role,
 *     granting themselves authority without a second approver (DI-18: administrators cannot grant
 *     themselves any authority; every grant of authority needs a second approver).
 *
 * Safe behaviour asserted here: after a lone administrator's call to iam.add_role_permission
 * (whether the call is refused or merely recorded as a pending request awaiting a second person),
 *   (a) an OPERATOR still cannot place a legal hold (EBMR-IAM-040 on RECORD.LEGAL_HOLD), and
 *   (b) the administrator, in the SYSTEM_ADMINISTRATOR role, still does not hold PLATFORM.ALARM_CLEAR.
 * Controls: before the edit the operator is refused and the administrator lacks the permission;
 * a QA reviewer (who holds RECORD.LEGAL_HOLD in the shipped map) places a legal hold, proving the
 * call path works when the permission is legitimately held.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { evaluateAuthority } from '../../src/identity/authority.ts';
import { placeLegalHold } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { seedAdministration, withReason, type SeedAdministration } from '../identity/seed.ts';

let db: TestDatabase;
let adm: SeedAdministration;

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });

const codeOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  if (/permission denied/.test(m)) return 'PERMISSION_DENIED';
  return m.match(/EBMR-[A-Z]+-\d+/)?.[0] ?? `UNEXPECTED: ${m}`;
};

async function outcome<T>(work: () => Promise<T>): Promise<string> {
  try {
    await work();
    return 'ACCEPTED';
  } catch (e) {
    return codeOf(e);
  }
}

/** A fresh operator (seeded through the real identity flow) tries to place a legal hold on a batch. */
async function operatorPlacesHold(tag: string): Promise<string> {
  const operator = await seededTestActor(db, { roleCode: 'OPERATOR', legalName: `F70 Operator ${tag}` });
  return outcome(() => withCommand(db.app, again(operator), (c) => placeLegalHold(c, 'batch', randomUUID(), `F70 ${tag} claim`)));
}

async function adminHoldsAlarmClear(): Promise<boolean> {
  const d = await evaluateAuthority(db.app, {
    personId: adm.admin.personId,
    accountId: adm.admin.accountId,
    permission: 'PLATFORM.ALARM_CLEAR',
    roleCode: 'SYSTEM_ADMINISTRATOR',
  });
  return d.allowed;
}

beforeAll(async () => {
  db = await createTestDatabase();
  adm = await seedAdministration(db);
});

afterAll(async () => {
  await db.drop();
});

describe('F70: one administrator alone cannot rewrite the permission-to-role map', () => {
  it('[DI-18][DI-17][INV-11] a lone administrator cannot give operators a GMP permission, nor give their own role new authority', async () => {
    // Controls on the shipped map.
    const qa = await seededTestActor(db, { roleCode: 'QA_REVIEWER', legalName: 'F70 QA reviewer' });
    const qaHold = await outcome(() => withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', randomUUID(), 'F70 control claim')));
    expect(qaHold).toBe('ACCEPTED');
    expect(await operatorPlacesHold('before')).toBe('EBMR-IAM-040');
    expect(await adminHoldsAlarmClear()).toBe(false);

    const observed: Record<string, unknown> = {};

    // The seeded SYSTEM_ADMINISTRATOR, alone, edits the kernel GMP role OPERATOR.
    observed['adminAddsLegalHoldToOperator'] = await outcome(() =>
      withCommand(db.app, withReason(adm.admin, 'ROLE_CHANGE', 'F70 lone edit'), (c) =>
        c.query("select iam.add_role_permission('OPERATOR', 'RECORD.LEGAL_HOLD')"),
      ),
    );
    // A freshly seeded operator then tries to place a legal hold (GMP action reserved to QA).
    observed['operatorPlacesLegalHoldAfterEdit'] = await operatorPlacesHold('after');

    // The same administrator, alone, extends their own role with a GOVERNANCE permission.
    observed['adminAddsAlarmClearToOwnRole'] = await outcome(() =>
      withCommand(db.app, withReason(adm.admin, 'ROLE_CHANGE', 'F70 self edit'), (c) =>
        c.query("select iam.add_role_permission('SYSTEM_ADMINISTRATOR', 'PLATFORM.ALARM_CLEAR')"),
      ),
    );
    observed['adminHoldsAlarmClearAfterSelfEdit'] = await adminHoldsAlarmClear();

    // Evidence: the live catalogue rows the lone administrator's commands left behind.
    const { rows } = await db.admin.query<{ role_code: string; permission_code: string }>(
      `select role_code, permission_code from iam.role_permission
        where removed_at is null
          and ((role_code = 'OPERATOR' and permission_code = 'RECORD.LEGAL_HOLD')
            or (role_code = 'SYSTEM_ADMINISTRATOR' and permission_code = 'PLATFORM.ALARM_CLEAR'))
        order by role_code`,
    );
    observed['liveCatalogueRowsAddedByLoneAdmin'] = rows.map((r) => `${r.role_code}:${r.permission_code}`);

    // Safe behaviour: whatever the administrator's call returns, the edits do not take effect
    // without a second approver (or are refused outright).
    expect({
      operatorPlacesLegalHoldAfterEdit: observed['operatorPlacesLegalHoldAfterEdit'],
      adminHoldsAlarmClearAfterSelfEdit: observed['adminHoldsAlarmClearAfterSelfEdit'],
      liveCatalogueRowsAddedByLoneAdmin: observed['liveCatalogueRowsAddedByLoneAdmin'],
      _context: observed,
    }).toEqual({
      operatorPlacesLegalHoldAfterEdit: 'EBMR-IAM-040',
      adminHoldsAlarmClearAfterSelfEdit: false,
      liveCatalogueRowsAddedByLoneAdmin: [],
      _context: observed,
    });
  });
});
