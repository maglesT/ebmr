/**
 * The LMS adapter's receiving command (kernel 1186; Phase 6 slice 6a, builder B): lms.qualification messages become
 * qualification rows with source LMS through platform.accept_inbound (DI-31), each traced to its message; a stale LMS
 * mirror makes the qualification check at signing fail closed and names the mirror (INV-26; kernel 1181's freshness);
 * the modes never mix (D-P6a-5). Everything runs as the application role through real identities.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { evaluateAuthority, requirePermission } from '../../src/identity/authority.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { ageMirror, count, envelopeFor, nowUs, receive, recordRefusal, registerAdapter, setMirrorMode, syncMirror, type TestAdapter } from './support.ts';

let db: TestDatabase;
let lms: TestAdapter;
let tc: SeededActor;
let op: SeededActor;
let qual: string;
const site = `SITE-L${randomBytes(2).toString('hex')}`;
const personNumber = `EMP-${randomBytes(3).toString('hex').toUpperCase()}`;

const qualification = (status: string, extra: Record<string, unknown> = {}) => ({
  personNumber, qualificationCode: qual, status, validFrom: (BigInt(nowUs()) - 86_400_000_000n).toString(), validTo: null, ...extra,
});
const send = (payload: unknown, o = {}) => receive(db, lms, 'iam.receive_lms_qualification', envelopeFor(lms, 'lms.qualification', payload, o));
const check = () => evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope: { site } });
const liveLms = () => count(db, "select count(*) as n from iam.person_qualification where person_id = $1 and source_code = 'LMS' and withdrawn_at is null", [op.personId]);

beforeAll(async () => {
  db = await createTestDatabase();
  const { admin } = await seedAdministration(db);
  lms = await registerAdapter(db, 'LMS');
  tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', acknowledgeEsig: false });
  op = await seedActor(db, { scope: { site }, acknowledgeEsig: false });
  // The employee number the LMS knows the person by (an administrator's audited correction of the person record).
  await withCommand(db.admin, withReason(admin), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [personNumber, op.personId]));
  qual = `SOP-${randomBytes(3).toString('hex').toUpperCase()}`;
  await withCommand(db.app, withReason(tc), async (c) => {
    await c.query("select iam.create_qualification_type($1, 'Granulation SOP', 'current granulation SOP')", [qual]);
    await c.query("select iam.add_qualification_requirement($1, null, 'STEP.EXECUTE', $2::jsonb, 'SOP training before acting')", [qual, JSON.stringify({ site })]);
  });
}, 120_000);
afterAll(async () => {
  await db.drop();
});

describe('LMS qualifications through the adapter (DI-31, INV-26)', () => {
  it('[DI-31] in STAND_IN an LMS message is refused (the modes never mix) and the refusal is recorded with an alarm', async () => {
    await setMirrorMode(db, 'LMS_QUALIFICATION', 'STAND_IN');
    const env = envelopeFor(lms, 'lms.qualification', qualification('QUALIFIED'));
    await expectRefused(receive(db, lms, 'iam.receive_lms_qualification', env), 'EBMR-LMS-001');
    // The refused transaction rolled back whole: no message, no qualification row.
    expect(await count(db, 'select count(*) as n from platform.inbound_message where idempotency_key = $1', [env['idempotencyKey']])).toBe(0);
    expect(await liveLms()).toBe(0);
    await recordRefusal(db, lms, env, 'WRONG_IDENTITY', 'EBMR-LMS-001');
    expect(await count(db, "select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = 'WRONG_IDENTITY'", [lms.code])).toBe(1);
  });

  it('[DI-31][INV-26] a QUALIFIED message records the qualification with source LMS, traced to its message; a resend changes nothing', async () => {
    await setMirrorMode(db, 'LMS_QUALIFICATION', 'MIRROR');
    await syncMirror(db, lms, 'LMS_QUALIFICATION');
    expect(await check()).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${qual}`] });
    const env = envelopeFor(lms, 'lms.qualification', qualification('QUALIFIED'));
    const r = await receive(db, lms, 'iam.receive_lms_qualification', env);
    expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    const row = (await db.admin.query<{ source_ref: string; recorded_by_person: string }>(
      "select source_ref, recorded_by_person from iam.person_qualification where person_id = $1 and source_code = 'LMS' and withdrawn_at is null", [op.personId])).rows[0]!;
    expect(row.source_ref).toBe(`inbound_message:${String(r['messageId'])}`);
    expect(row.recorded_by_person).toBe(lms.actor.personId);
    expect(await check()).toMatchObject({ allowed: true });
    // The same message again (a retry) is de-duplicated; nothing is applied twice.
    expect(await receive(db, lms, 'iam.receive_lms_qualification', env)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await liveLms()).toBe(1);
    // The same state in a new message changes nothing either.
    expect(await send(qualification('QUALIFIED', { validFrom: (await db.admin.query<{ v: string }>("select (extract(epoch from valid_from) * 1000000)::bigint::text as v from iam.person_qualification where person_id = $1 and source_code = 'LMS' and withdrawn_at is null", [op.personId])).rows[0]!.v }))).toMatchObject({ applied: 'UNCHANGED' });
    expect(await liveLms()).toBe(1);
  });

  it('[DI-31] stale LMS mirror: a step signature is refused and names the mirror', async () => {
    await syncMirror(db, lms, 'LMS_QUALIFICATION');
    expect(await check()).toMatchObject({ allowed: true });
    // The LMS heartbeat stops while the qualification rows stay: after the 60-minute bound the check fails closed.
    await ageMirror(db, 'LMS_QUALIFICATION', 2 * 3600);
    expect(await check()).toMatchObject({ allowed: false, reasons: [`STALE_QUALIFICATION_SOURCE:${qual}`] });
    await expectRefused(withCommand(db.app, op, (c) => requirePermission(c, 'STEP.EXECUTE', { site })), 'EBMR-IAM-040', new RegExp(`STALE_QUALIFICATION_SOURCE:${qual}`));
    const problem = (await db.admin.query<{ p: string | null }>('select iam.lms_mirror_problem() as p')).rows[0]!.p;
    expect(problem).toMatch(/^EBMR-INT-010 the LMS mirror LMS_QUALIFICATION is stale: last synchronised 72\d\d s ago.*call the LMS system owner/);
    await syncMirror(db, lms, 'LMS_QUALIFICATION');
    expect(await check()).toMatchObject({ allowed: true });
  });

  it('[DI-31] REVOKED withdraws the LMS qualification at once; a late (older) state is refused STALE and never overwrites it', async () => {
    const older = nowUs();
    expect(await send(qualification('REVOKED'))).toMatchObject({ applied: 'WITHDRAWN' });
    expect(await liveLms()).toBe(0);
    expect(await check()).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${qual}`] });
    // An out-of-order QUALIFIED with an older LMS timestamp arrives late: it is refused, and the person stays unqualified.
    const late = envelopeFor(lms, 'lms.qualification', qualification('QUALIFIED'), { sourceTimestamp: older });
    await expectRefused(receive(db, lms, 'iam.receive_lms_qualification', late), 'EBMR-LMS-004');
    expect(await liveLms()).toBe(0);
  });

  it('[DI-31] a malformed payload, an unknown person and an unknown qualification are refused; nothing lands', async () => {
    await expectRefused(send({ ...qualification('QUALIFIED'), grade: 'A' }), 'EBMR-LMS-002', /unknown field grade/);
    await expectRefused(send(qualification('QUALIFIED', { validTo: '1' })), 'EBMR-LMS-002', /validTo is after validFrom/);
    await expectRefused(send(qualification('QUALIFIED', { personNumber: 'NOBODY-1' })), 'EBMR-LMS-003');
    await expectRefused(send(qualification('QUALIFIED', { qualificationCode: 'NO-SUCH-SOP' })), 'EBMR-LMS-003');
    expect(await liveLms()).toBe(0);
  });

  it('[DI-31][DI-14] a person cannot use the LMS command, and the application cannot write qualification rows directly', async () => {
    await expectRefused(
      withCommand(db.app, tc, (c) => c.query('select iam.receive_lms_qualification($1::jsonb)', [JSON.stringify(envelopeFor(lms, 'lms.qualification', qualification('QUALIFIED')))])),
      'EBMR-INT-002',
    );
    await expectPermissionDenied(
      withCommand(db.app, tc, (c) => c.query("insert into iam.person_qualification (person_id, qualification_code, source_code, valid_from, recorded_by_person, recorded_by_account) values ($1, $2, 'LMS', now(), $3, $4)", [op.personId, qual, tc.personId, tc.accountId])),
    );
  });
});
