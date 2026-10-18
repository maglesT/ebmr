/**
 * The interface drift interlock (kernel 1350; Phase 7 slice 7c; DI-06 clause 1): on a GMP installation an adapter whose
 * interface is not in the approved system description (kernel 1300) raises the INTERFACE_DRIFT alarm when it is enabled,
 * when it starts and when its refusal is recorded, and every message it sends is refused (EBMR-INT-035) and leaves
 * nothing. Run as the application role through real identities, with the bypass attempts the roles have.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { count, ctxOf, envelopeFor, inboundReason, recordRefusal, registerAdapter, type TestAdapter } from '../integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { describeTestInterfaces, testInterface } from '../support/validation.ts';

let db: TestDatabase;
let admin: SeededActor;
let drifted: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ admin } = await seedAdministration(db));
  drifted = await registerAdapter(db, 'QMS', undefined, { described: false });
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const capa = () => ({ capaNumber: `CAPA-${randomBytes(3).toString('hex')}`, status: 'OPEN', effectivenessDue: null });
const accept = (a: TestAdapter, env: Record<string, unknown>) =>
  withCommand(db.app, ctxOf(a.actor, inboundReason(env)), async (c) =>
    (await c.query<{ r: Record<string, unknown> }>('select platform.accept_inbound_detail($1::jsonb) as r', [JSON.stringify(env)])).rows[0]!.r);
const startCheck = (a: TestAdapter) =>
  withCommand(db.app, ctxOf(a.actor), async (c) => (await c.query<{ p: string | null }>('select platform.check_adapter_start() as p')).rows[0]!.p);
const alarms = (a: TestAdapter, kind = 'INTERFACE_DRIFT') =>
  count(db, 'select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [a.code, kind]);
const messages = (a: TestAdapter) => count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [a.code]);

describe('the interface drift interlock (kernel 1350, DI-06)', () => {
  it('[DI-06] an interface not in the approved system description raises the drift alarm and is refused', async () => {
    // Enabled (registered ACTIVE) without a description: the drift alarm fires in the same transaction.
    expect(await alarms(drifted)).toBe(1);
    const { rows } = await db.admin.query<{ severity: string; at: string }>(
      "select severity, details ->> 'at' as at from platform.integration_alarm where adapter_code = $1 and kind = 'INTERFACE_DRIFT'", [drifted.code]);
    expect(rows).toEqual([{ severity: 'CRITICAL', at: 'REGISTERED' }]);
    // Its start is refused, with the alarm.
    expect(await startCheck(drifted)).toMatch(/^EBMR-INT-035 interface drift: adapter QMS-[0-9A-F]{6} \(QMS\) is not in the approved system description/);
    expect(await alarms(drifted)).toBe(2);
    // Its message is refused before anything of it is read, and leaves nothing.
    const env = envelopeFor(drifted, 'qms.capa', capa());
    await expectRefused(accept(drifted, env), 'EBMR-INT-035');
    await expectRefused(withCommand(db.app, ctxOf(drifted.actor, inboundReason(env)), (c) => c.query('select platform.accept_inbound($1::jsonb)', [JSON.stringify(env)])), 'EBMR-INT-035');
    // A malformed envelope too: the drift is what the refusal names.
    await expectRefused(accept(drifted, { nonsense: true }), 'EBMR-INT-035');
    expect(await messages(drifted)).toBe(0);
    // The adapter records the refusal (ACK_RULE) in any class it chooses: the database raises it as INTERFACE_DRIFT.
    await recordRefusal(db, drifted, env, 'WRONG_IDENTITY', 'EBMR-INT-035 refused');
    expect(await alarms(drifted)).toBe(3);
    expect(await alarms(drifted, 'WRONG_IDENTITY')).toBe(0);
    const ex = await db.admin.query<{ kind: string; error_class: string; alarm_kind: string }>(
      `select e.kind, e.error_class, a.kind as alarm_kind from platform.inbound_exception e join platform.integration_alarm a on a.id = e.alarm_id
        where e.adapter_code = $1`, [drifted.code]);
    expect(ex.rows).toEqual([{ kind: 'REFUSED', error_class: 'WRONG_IDENTITY', alarm_kind: 'INTERFACE_DRIFT' }]);

    // Described by the system owner under an approved change record: its start and its messages are taken.
    await describeTestInterfaces(db, [testInterface(drifted.code, 'QMS')]);
    expect(await startCheck(drifted)).toBeNull();
    expect(await accept(drifted, envelopeFor(drifted, 'qms.capa', capa()))).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await messages(drifted)).toBe(1);
    expect(await alarms(drifted)).toBe(3);

    // Withdrawn from the description: refused again, and the refusal's alarm says why.
    await describeTestInterfaces(db, [{ ...testInterface(drifted.code, 'QMS'), status: 'WITHDRAWN' }]);
    expect(await startCheck(drifted)).toMatch(/^EBMR-INT-035 .* is withdrawn from the approved system description/);
    await expectRefused(accept(drifted, envelopeFor(drifted, 'qms.capa', capa())), 'EBMR-INT-035');
    expect(await messages(drifted)).toBe(1);
  });

  it('[DI-06] an adapter blocked and enabled again without a description raises the drift alarm; a described one does not', async () => {
    const other = await registerAdapter(db, 'CMMS', undefined, { described: false });
    const described = await registerAdapter(db, 'CMMS');
    expect(await alarms(other)).toBe(1);
    expect(await alarms(described)).toBe(0);
    for (const a of [other, described]) {
      await withCommand(db.app, withReason(admin), (c) => c.query("select iam.set_integration_adapter_status($1, 'BLOCKED', 'link maintenance')", [a.id]));
      await withCommand(db.app, withReason(admin), (c) => c.query("select iam.set_integration_adapter_status($1, 'ACTIVE', 'link restored')", [a.id]));
    }
    expect(await alarms(other)).toBe(2);
    const { rows } = await db.admin.query<{ at: string }>(
      "select details ->> 'at' as at from platform.integration_alarm where adapter_code = $1 and kind = 'INTERFACE_DRIFT' order by raised_at", [other.code]);
    expect(rows.map((r) => r.at)).toEqual(['REGISTERED', 'ENABLED']);
    expect(await alarms(described)).toBe(0);
    expect(await startCheck(described)).toBeNull();
  });

  it('[DI-06] the drift check cannot be bypassed: the application and the adapter neither describe an interface nor silence the alarm', async () => {
    const a = await registerAdapter(db, 'LIMS', undefined, { described: false });
    // The adapter cannot describe its own interface (CONFIG.SYSTEM_DESCRIPTION is the system owner's), nor can the
    // application role write the description, the alarm or the check's helper.
    await expectRefused(
      withCommand(db.app, ctxOf(a.actor), (c) => c.query('select platform.describe_interface($1::jsonb)', [JSON.stringify(testInterface(a.code, 'LIMS'))])),
      'EBMR-IAM-040',
    );
    await expectPermissionDenied(db.app.query(
      "insert into platform.system_interface (adapter_code, source_system, endpoint_host, transport, signed_feed, status) values ($1, 'LIMS', '127.0.0.1', 'LOOPBACK', false, 'DESCRIBED')", [a.code]));
    await expectPermissionDenied(db.app.query("delete from platform.integration_alarm where adapter_code = $1", [a.code]));
    await expectPermissionDenied(db.app.query("update platform.integration_alarm set kind = 'STALE' where adapter_code = $1", [a.code]));
    await expectPermissionDenied(db.app.query('select platform.interface_drift_problem(d) from iam.integration_adapter d where d.code = $1', [a.code]));
    // Without the adapter's identity there is no start check and no message.
    await expectRefused(withCommand(db.app, withReason(admin), (c) => c.query('select platform.check_adapter_start()')), 'EBMR-INT-002');
    expect(await alarms(a)).toBe(1);
    expect(await messages(a)).toBe(0);
  });
});
