/**
 * The inbound adapter framework, rule by rule (SQL mutation group "inbound-adapters-and-mirrors": kernel 1180, 1181,
 * 1182 and 1186). The scenario tests (inbound/inbound.test.ts, inbound/overrides-and-lms-mirror.test.ts,
 * integrations/lms-inbound.test.ts) show the framework working; these take each rule the Phase 6 mutation run found
 * unproven to the input where it alone decides, and assert the exact answer:
 *  - the adapter registry: an adapter is registered ACTIVE, none of its identifying columns changes, a decommissioned
 *    adapter never changes again, a status change needs a reason and a known adapter, and only an actor whose source
 *    is INTEGRATION acts as an adapter (an integration account acting as SYSTEM is not one) (DI-20);
 *  - the envelope's limits (the last source timestamp before the year 10000, a payload of exactly 1 MiB), a refusal's
 *    text and its source timestamp at the same limit, and an acknowledgment of an unknown alarm (DI-31);
 *  - reconciliation: each malformed report alone is refused; the period is [from, to) for accepted messages and for
 *    refusals; only this adapter's REFUSED rows that carry a key and a hash count as received, de-duplicated resends
 *    never; and a matching count with another checksum is a mismatch (DI-31);
 *  - the caught-up proof of a mirror synchronisation (kernel 1182; INV-26, INV-38): where the check starts (the same
 *    adapter's proven head, not another adapter's or another class's; the adapter's own first held number, counting
 *    only its own refusals), the head itself when it is the only number to check, what counts as held (this adapter's
 *    REFUSED rows only) and which acknowledged alarm covers a hole (this adapter's SEQUENCE_GAP alarm whose range holds
 *    the whole hole);
 *  - the LMS qualification source: the heartbeat in STAND_IN and the mirror in MIRROR, each fresh up to and including
 *    its bound (INV-26), and the LMS payload's limits and the receiving command's supersession rules (one person and
 *    qualification at a time; a state with the same LMS time as the applied one is refused) (DI-31).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { expectRefused, testActor } from '../identity/helpers.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import {
  count, ctxOf, envelopeFor, nowUs, receive, recordRefusal, registerAdapter, setMirrorMode, sha256, syncMirror,
  type Administration, type EnvelopeOptions, type TestAdapter,
} from '../integrations/support.ts';

let db: TestDatabase;
let admin: SeededActor;
let owner: SeededActor;
let given: Administration;

/** The last instant the envelope's source timestamp may name: 9999-12-31 23:59:59.999999 UTC in epoch microseconds. */
const MAX_US = '253402300799999999';

interface Outcome {
  messageId: string;
  outcome: string;
  sequenceStatus: string;
  alarmId: string | null;
}

beforeAll(async () => {
  db = await createTestDatabase();
  ({ admin, owner } = await seedAdministration(db));
  given = { admin, owner };
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const cmms = () => registerAdapter(db, 'CMMS', given);
const accept = async (a: TestAdapter, o: EnvelopeOptions = {}, envelope?: Record<string, unknown>): Promise<Outcome & { envelope: Record<string, unknown> }> => {
  const e = envelope ?? envelopeFor(a, 'cmms.calibration', { n: randomUUID() }, o);
  const r = await withCommand(db.app, ctxOf(a.actor), async (c) =>
    (await c.query<{ r: Outcome }>('select platform.accept_inbound_detail($1::jsonb) as r', [JSON.stringify(e)])).rows[0]!.r);
  return { ...r, envelope: e };
};
const send = async (a: TestAdapter, ...numbers: number[]): Promise<(Outcome & { envelope: Record<string, unknown> })[]> => {
  const out: (Outcome & { envelope: Record<string, unknown> })[] = [];
  for (const n of numbers) out.push(await accept(a, { sequenceNo: n.toString() }));
  return out;
};
const refuse = (a: TestAdapter, o: EnvelopeOptions = {}, payload: unknown = { n: randomUUID() }): Promise<string> =>
  recordRefusal(db, a, envelopeFor(a, 'cmms.calibration', payload, o), 'MALFORMED', 'EBMR-INT-001 test refusal');
const sync = (a: TestAdapter, head: string, cls = 'CMMS_CALIBRATION') =>
  withCommand(db.app, ctxOf(a.actor), (c) => c.query('select platform.record_mirror_sync($1, $2)', [cls, head]));
const acknowledge = async (alarmId: string | null): Promise<void> => {
  // A CMMS gap (a blocking mirror's adapter) is acknowledged by QA or the system owner (kernel 1320, 6jc-R11).
  const qa = await testActor(db, { roleCode: 'QA_REVIEWER' });
  await withCommand(db.app, ctxOf(qa), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [alarmId, 'the missing numbers were test orders cancelled at the source']));
};
const forget = (cls: string) => db.admin.query('delete from platform.mirror_sync where data_class = $1', [cls]);
const mark = async (cls: string): Promise<string | undefined> =>
  (await db.admin.query<{ h: string }>('select source_head::text as h from platform.mirror_sync where data_class = $1', [cls])).rows[0]?.h;

describe('the adapter registry (DI-20)', () => {
  it('[DI-20] an adapter is registered ACTIVE and none of its identifying columns ever changes, even for the database owner', async () => {
    const a = await cmms();
    await expectRefused(
      db.admin.query(
        `insert into iam.integration_adapter (code, source_system, account_id, device_id, status, description, registered_by_person)
         values ($1, 'CMMS', $2, $3, 'BLOCKED', 'born blocked', $4)`,
        [`X-${randomBytes(3).toString('hex').toUpperCase()}`, admin.accountId, a.actor.deviceId, admin.personId],
      ),
      'EBMR-INT-016',
      /registered ACTIVE/,
    );
    const other = await testActor(db);
    // registered_at is a database time (kernel 0500 keeps its stored value on update), so it is not listed here.
    for (const [column, value] of [
      ['id', randomUUID()],
      ['code', `Y-${randomBytes(3).toString('hex').toUpperCase()}`],
      ['account_id', other.accountId],
      ['device_id', other.deviceId ?? randomUUID()],
      ['registered_by_person', other.personId],
      ['description', 'another description'],
    ] as const) {
      await expectRefused(db.admin.query(`update iam.integration_adapter set ${column} = $2 where id = $1`, [a.id, value]), 'EBMR-INT-016', /never change/);
    }
    // A status change alone goes through, and keeps every identifying column.
    await withCommand(db.app, withReason(admin), (c) => c.query("select iam.set_integration_adapter_status($1, 'BLOCKED', 'link under investigation')", [a.id]));
    expect((await db.admin.query('select code, status from iam.integration_adapter where id = $1', [a.id])).rows[0]).toEqual({ code: a.code, status: 'BLOCKED' });
  });

  it('[DI-20] a status change names a reason and a known adapter; a decommissioned adapter never changes again', async () => {
    const a = await cmms();
    const setStatus = (id: string, status: string, reason: string) =>
      withCommand(db.app, withReason(admin), (c) => c.query('select iam.set_integration_adapter_status($1, $2, $3)', [id, status, reason]));
    await expectRefused(setStatus(a.id, 'BLOCKED', '  '), 'EBMR-IAM-004');
    await expectRefused(setStatus(randomUUID(), 'BLOCKED', 'no such adapter'), 'EBMR-INT-016', /unknown integration adapter/);
    await setStatus(a.id, 'DECOMMISSIONED', 'host retired');
    await expectRefused(setStatus(a.id, 'ACTIVE', 'bring it back'), 'EBMR-INT-016', /decommissioned/);
    expect((await db.admin.query<{ status: string }>('select status from iam.integration_adapter where id = $1', [a.id])).rows[0]?.status).toBe('DECOMMISSIONED');
  });

  it('[DI-20] the adapter\'s own integration account acting as SYSTEM is not an adapter', async () => {
    const a = await cmms();
    const e = envelopeFor(a, 'cmms.calibration', { n: 1 });
    await expectRefused(
      withCommand(db.app, ctxOf(a.actor, { source: 'SYSTEM' }), (c) => c.query('select platform.accept_inbound_detail($1::jsonb)', [JSON.stringify(e)])),
      'EBMR-INT-002',
      /source SYSTEM/,
    );
    expect(await count(db, 'select count(*) as n from platform.inbound_message where adapter_id = $1', [a.id])).toBe(0);
  });
});

describe('envelope limits, refusals and alarms (DI-31)', () => {
  const problem = async (e: unknown): Promise<string | null> =>
    (await db.admin.query<{ p: string | null }>('select platform.inbound_envelope_problem($1::jsonb) as p', [JSON.stringify(e)])).rows[0]!.p;

  it('[DI-31] the last source timestamp before the year 10000 and a payload of exactly 1 MiB are accepted; one more is refused', async () => {
    const a = await cmms();
    expect(await problem(envelopeFor(a, 'cmms.calibration', { n: 1 }, { sourceTimestamp: MAX_US }))).toBeNull();
    expect(await problem(envelopeFor(a, 'cmms.calibration', { n: 1 }, { sourceTimestamp: (BigInt(MAX_US) + 1n).toString() }))).toMatch(/after the year 9999/);
    const overhead = Number((await db.admin.query<{ n: string }>(`select octet_length(('{"a": ""}'::jsonb)::text) as n`)).rows[0]!.n);
    const exact = { a: 'x'.repeat(1048576 - overhead) };
    expect(await problem(envelopeFor(a, 'cmms.calibration', exact))).toBeNull();
    expect(await problem(envelopeFor(a, 'cmms.calibration', { a: `${exact.a}x` }))).toMatch(/exceeds 1048576 bytes/);
  });

  it('[DI-31] a refusal needs its text, and keeps a source timestamp up to the year-9999 limit and none beyond it', async () => {
    const a = await cmms();
    await expectRefused(
      withCommand(db.app, ctxOf(a.actor), (c) => c.query("select platform.record_inbound_refusal('{}'::jsonb, 'MALFORMED', '  ')")),
      'EBMR-INT-014',
      /refusal's text/,
    );
    const ts = async (sourceTimestamp: string): Promise<string | null> => {
      const id = await refuse(a, { sourceTimestamp });
      return (await db.admin.query<{ t: string | null }>("select to_char(source_timestamp at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as t from platform.inbound_exception where id = $1", [id])).rows[0]!.t;
    };
    // Kept (the conversion goes through double precision, so this far from now it lands on the next microsecond).
    expect(await ts(MAX_US)).toMatch(/^(9999-12-31 23:59:59|10000-01-01 00:00:00)\./);
    expect(await ts('999999999999999999')).toBeNull();
  });

  it('[DI-31] acknowledging an alarm that does not exist is refused by name', async () => {
    const operator = await testActor(db);
    const id = randomUUID();
    await expectRefused(
      withCommand(db.app, ctxOf(operator), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [id, 'looked at it'])),
      'EBMR-INT-007',
      new RegExp(`unknown integration alarm ${id}`),
    );
  });
});

describe('reconciliation (DI-31)', () => {
  const T0 = 1_900_000_000_000_000n;
  const T1 = T0 + 60_000_000n;
  const report = (a: TestAdapter, r: unknown) =>
    withCommand(db.app, ctxOf(a.actor), async (c) => (await c.query<{ id: string }>('select platform.record_reconciliation($1::jsonb) as id', [JSON.stringify(r)])).rows[0]!.id);

  it('[DI-31] each malformed report alone is refused; a period ending at the year-9999 limit is not', async () => {
    const a = await cmms();
    const ok = { periodFrom: '0', periodTo: '60000000', sourceCount: '0', sourceChecksum: sha256('') };
    for (const bad of [
      [ok],
      { ...ok, extra: '1' },
      { ...ok, periodFrom: 'x' },
      { ...ok, periodTo: '1e9' },
      { ...ok, sourceCount: '-1' },
      { ...ok, sourceChecksum: 'ABC' },
      { ...ok, periodFrom: '60000000' },
      { ...ok, periodTo: (BigInt(MAX_US) + 1n).toString() },
    ]) {
      await expectRefused(report(a, bad), 'EBMR-INT-015');
    }
    expect(await report(a, { ...ok, periodTo: MAX_US })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-31] the period is [from, to) for messages and refusals; only this adapter\'s keyed REFUSED rows count as received, resends never', async () => {
    const a = await cmms();
    const other = await cmms();
    const at = (t: bigint) => ({ sourceTimestamp: t.toString() });
    await accept(a, at(T0 - 1n));
    const m1 = await accept(a, at(T0));
    const m2 = await accept(a, at(T0 + 1_000_000n));
    await accept(a, at(T1));
    // A resend of m2 inside the period: de-duplicated (kind DEDUPLICATED, with m2's key and hash).
    expect((await accept(a, {}, { ...m2.envelope, sequenceNo: '90', sourceTimestamp: (T0 + 2_000_000n).toString() })).outcome).toBe('DUPLICATE');
    // Refusals: at the period's start (in), at its end (out), with a key that is not one (no key: not received), and one more inside.
    const refusal = (o: EnvelopeOptions) => {
      const e = envelopeFor(a, 'cmms.calibration', { r: randomUUID() }, o);
      return recordRefusal(db, a, e, 'MALFORMED', 'test refusal').then(() => e);
    };
    const r1 = await refusal(at(T0));
    await refusal(at(T1));
    await refusal({ ...at(T0 + 3_000_000n), idempotencyKey: 'not a key' });
    const r5 = await refusal(at(T0 + 4_000_000n));
    // The other adapter's message and refusal in the same period are not this adapter's.
    await accept(other, at(T0 + 5_000_000n));
    await refuse(other, at(T0 + 5_000_000n));

    const received = [m1.envelope, m2.envelope, r1, r5].map((e) => `${String(e['idempotencyKey'])}|${String(e['payloadHash'])}`)
      .sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    const checksum = sha256(received.join('\n'));
    const row = async (id: string): Promise<Record<string, unknown> | undefined> =>
      (await db.admin.query<Record<string, unknown>>('select received_count::text as received, received_checksum as checksum, accepted_count::text as accepted, refused_count::text as refused, matched, alarm_id is not null as alarm from platform.reconciliation_report where id = $1', [id])).rows[0];
    const period = { periodFrom: T0.toString(), periodTo: T1.toString() };
    expect(await row(await report(a, { ...period, sourceCount: '4', sourceChecksum: checksum })))
      .toEqual({ received: '4', checksum, accepted: '2', refused: '2', matched: true, alarm: false });
    // The same count with another checksum (a message the source sent differently) is a mismatch with its alarm.
    expect(await row(await report(a, { ...period, sourceCount: '4', sourceChecksum: sha256('another content') })))
      .toEqual({ received: '4', checksum, accepted: '2', refused: '2', matched: false, alarm: true });
  });
});

describe('a mirror is marked fresh only when its adapter is caught up (kernel 1182; INV-26, INV-38)', () => {
  it('[DI-31][INV-26] an unknown data class is refused by name', async () => {
    const a = await cmms();
    await expectRefused(sync(a, '0', 'NO_SUCH_CLASS'), 'EBMR-INT-011', /NO_SUCH_CLASS/);
  });

  it('[DI-31][INV-26] after a proof at head 0 the check starts at 1: an adapter whose first message is 3 has not received 1 and 2', async () => {
    await forget('CMMS_CALIBRATION');
    const a = await cmms();
    await sync(a, '0');
    expect(await mark('CMMS_CALIBRATION')).toBe('0');
    await send(a, 3);
    await expectRefused(sync(a, '3'), 'EBMR-INT-024', /holds no message for 2 sequence number\(s\) up to the source's 3 \(the first is 1\)/);
    expect(await mark('CMMS_CALIBRATION')).toBe('0');
  });

  it('[DI-31][INV-26] another adapter\'s proven head does not shorten this adapter\'s check', async () => {
    await forget('CMMS_CALIBRATION');
    const before = await cmms();
    await send(before, 1, 2, 3, 4, 5);
    await sync(before, '5');
    const a = await cmms();
    await send(a, 1, 3, 6);
    await expectRefused(sync(a, '6'), 'EBMR-INT-024', /holds no message for 3 sequence number\(s\) up to the source's 6 \(the first is 2\)/);
    expect(await mark('CMMS_CALIBRATION')).toBe('5');
  });

  it('[DI-31][INV-26] when the head is the only number left to check, it is checked', async () => {
    await forget('CMMS_CALIBRATION');
    const a = await cmms();
    await send(a, 1, 2, 3);
    await sync(a, '3');
    expect((await send(a, 5))[0]?.sequenceStatus).toBe('GAP');
    await expectRefused(sync(a, '4'), 'EBMR-INT-024', /holds no message for 1 sequence number\(s\) up to the source's 4 \(the first is 4\)/);
    expect(await mark('CMMS_CALIBRATION')).toBe('3');
  });

  it('[DI-31][INV-26] a range the same adapter proved stays proved: a late message below its first number does not reopen it', async () => {
    // The check starts at the adapter's first held number, or after the head this class was last proven caught up to by
    // the same adapter (kernel 1182): numbers below the first held one are the source's history before the adapter.
    await forget('CMMS_CALIBRATION');
    const a = await cmms();
    await send(a, 5);
    await sync(a, '5');
    expect((await send(a, 2))[0]?.sequenceStatus).toBe('LATE');
    await sync(a, '5');
    expect(await mark('CMMS_CALIBRATION')).toBe('5');
  });

  it('[DI-31][INV-26] the first held number is the adapter\'s own: its accepted messages and its own refusals, not resends and not another adapter\'s refusals', async () => {
    await forget('CMMS_CALIBRATION');
    const other = await cmms();
    await refuse(other, { sequenceNo: '1' });
    const a = await cmms();
    const [first] = await send(a, 5, 6);
    // The first message resent under number 2: de-duplicated, recorded with number 2, but not a number the adapter holds.
    expect((await accept(a, {}, { ...first!.envelope, sequenceNo: '2' })).outcome).toBe('DUPLICATE');
    await sync(a, '6');
    expect(await mark('CMMS_CALIBRATION')).toBe('6');
    // An adapter whose own refusal holds number 1 and whose first message is 3 is missing 2.
    const b = await cmms();
    await refuse(b, { sequenceNo: '1' });
    await send(b, 3);
    await expectRefused(sync(b, '3'), 'EBMR-INT-024', /holds no message for 1 sequence number\(s\) up to the source's 3 \(the first is 2\)/);
  });

  it('[DI-31][INV-26] a hole is filled only by this adapter\'s numbers and covered only by its own acknowledged gap alarm over the whole hole', async () => {
    const other = await cmms();
    const [, wide] = await send(other, 1, 101);
    expect(wide?.sequenceStatus).toBe('GAP');
    await acknowledge(wide!.alarmId);
    await refuse(other, { sequenceNo: '4' });
    await refuse(other, { sequenceNo: '5' });
    const a = await cmms();
    const [, , , late] = await send(a, 1, 2, 3, 6);
    expect(late?.sequenceStatus).toBe('GAP');
    await expectRefused(sync(a, '6'), 'EBMR-INT-024', /holds no message for 2 sequence number\(s\) up to the source's 6 \(the first is 4\)/);
    // Its own gap alarm, acknowledged by a person, covers the hole.
    await acknowledge(late!.alarmId);
    await sync(a, '6');
    expect(await mark('CMMS_CALIBRATION')).toBe('6');
  });
});

describe('the LMS qualification source (INV-26, DI-31)', () => {
  let lms: TestAdapter;
  let tc: SeededActor;
  let qual: string;
  const people: { id: string; number: string }[] = [];
  const fresh = async (at: string): Promise<boolean | null> =>
    (await db.admin.query<{ f: boolean | null }>(`select iam.qualification_source_fresh('LMS', ${at}) as f`)).rows[0]!.f;

  beforeAll(async () => {
    lms = await registerAdapter(db, 'LMS', given);
    tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', acknowledgeEsig: false });
    qual = `SOP-${randomBytes(3).toString('hex').toUpperCase()}`;
    await withCommand(db.app, withReason(tc), (c) => c.query("select iam.create_qualification_type($1, 'Packing SOP', 'current packing SOP')", [qual]));
    for (let i = 0; i < 2; i += 1) {
      const p = await seedActor(db, { acknowledgeEsig: false });
      const number = `EMP-${randomBytes(3).toString('hex').toUpperCase()}`;
      await withCommand(db.admin, withReason(admin), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [number, p.personId]));
      people.push({ id: p.personId, number });
    }
  }, 120_000);

  it('[INV-26] in STAND_IN the LMS heartbeat rules, fresh up to and including its bound; the generic mirror is not read', async () => {
    await setMirrorMode(db, 'LMS_QUALIFICATION', 'STAND_IN', given);
    await forget('LMS_QUALIFICATION');
    await withCommand(db.app, withReason(tc), (c) => c.query("select iam.record_mirror_heartbeat('LMS')"));
    expect(await fresh('clock_timestamp()')).toBe(true);
    const edge = "(select h.last_synced_at + make_interval(secs => iam.policy_int('qualification.mirror_max_staleness_seconds')) from iam.mirror_heartbeat h where h.source_code = 'LMS')";
    expect(await fresh(edge)).toBe(true);
    expect(await fresh(`${edge} + interval '1 microsecond'`)).toBe(false);
  });

  it('[INV-26] in MIRROR the LMS mirror rules, fresh up to and including its bound', async () => {
    await setMirrorMode(db, 'LMS_QUALIFICATION', 'MIRROR', given);
    await syncMirror(db, lms, 'LMS_QUALIFICATION');
    const edge = "(select m.last_synced_at + make_interval(secs => platform.setting_numeric('integration.mirror_max_age_s.lms_qualification')::bigint) from platform.mirror_sync m where m.data_class = 'LMS_QUALIFICATION')";
    expect(await fresh(edge)).toBe(true);
    expect(await fresh(`${edge} + interval '1 microsecond'`)).toBe(false);
  });

  it('[DI-31] each LMS payload rule alone decides, at its limits', async () => {
    const problem = async (p: unknown): Promise<string | null> =>
      (await db.admin.query<{ p: string | null }>('select iam.lms_qualification_payload_problem($1::jsonb) as p', [p === null ? null : JSON.stringify(p)])).rows[0]!.p;
    const ok = { personNumber: 'EMP-1', qualificationCode: 'SOP-1', status: 'QUALIFIED', validFrom: '1000', validTo: null };
    expect(await problem(ok)).toBeNull();
    expect(await problem(null)).toBe('the payload is not an object');
    expect(await problem({ ...ok, personNumber: 123 })).toMatch(/^personNumber/);
    expect(await problem({ ...ok, qualificationCode: 123 })).toMatch(/^qualificationCode/);
    expect(await problem({ ...ok, validFrom: 5 })).toMatch(/^validFrom/);
    expect(await problem({ ...ok, validFrom: '999999999999999999' })).toMatch(/^validFrom/);
    expect(await problem({ ...ok, validFrom: MAX_US })).toBeNull();
    expect(await problem({ ...ok, validTo: '2000' })).toBeNull();
    expect(await problem({ ...ok, validTo: MAX_US })).toBeNull();
    expect(await problem({ ...ok, validTo: '999999999999999999' })).toMatch(/^validTo is UTC epoch microseconds/);
    expect(await problem({ ...ok, validTo: 5 })).toMatch(/^validTo is UTC epoch microseconds/);
    expect(await problem({ ...ok, validTo: '1000' })).toBe('validTo is after validFrom');
  });

  it('[DI-31] the receiving command takes lms.qualification only, supersedes one person\'s qualification only, and refuses a state as old as the applied one', async () => {
    const [p1, p2] = people as [{ id: string; number: string }, { id: string; number: string }];
    const msg = (person: string, status: string, extra: Record<string, unknown> = {}) =>
      ({ personNumber: person, qualificationCode: qual, status, validFrom: '1700000000000000', validTo: null, ...extra });
    const take = (payload: unknown, o: EnvelopeOptions = {}) => receive(db, lms, 'iam.receive_lms_qualification', envelopeFor(lms, 'lms.qualification', payload, o));
    const live = async (person: string) =>
      (await db.admin.query<{ to: string | null }>(
        "select to_char(valid_to at time zone 'UTC', 'YYYY-MM-DD') as to from iam.person_qualification where person_id = $1 and qualification_code = $2 and source_code = 'LMS' and withdrawn_at is null",
        [person, qual])).rows;

    await expectRefused(receive(db, lms, 'iam.receive_lms_qualification', envelopeFor(lms, 'cmms.calibration', msg(p1.number, 'QUALIFIED'))), 'EBMR-LMS-002', /not cmms.calibration/);
    expect(await take(msg(p2.number, 'QUALIFIED'))).toMatchObject({ applied: 'RECORDED' });
    expect(await take(msg(p1.number, 'QUALIFIED'))).toMatchObject({ applied: 'RECORDED' });
    // The same start with an end date is a new state: recorded with its end, the open-ended row withdrawn.
    expect(await take(msg(p1.number, 'QUALIFIED', { validTo: '1800000000000000' }))).toMatchObject({ applied: 'RECORDED' });
    expect(await live(p1.id)).toEqual([{ to: '2027-01-15' }]);
    expect(await live(p2.id)).toEqual([{ to: null }]);
    // A state with the same LMS time as the one applied is not newer: refused, nothing changes.
    const ts = nowUs();
    expect(await take(msg(p1.number, 'QUALIFIED', { validTo: '1900000000000000' }), { sourceTimestamp: ts })).toMatchObject({ applied: 'RECORDED' });
    await expectRefused(take(msg(p1.number, 'REVOKED'), { sourceTimestamp: ts }), 'EBMR-LMS-004');
    expect(await live(p1.id)).toEqual([{ to: '2030-03-17' }]);
    // REVOKED withdraws this person's qualification only.
    expect(await take(msg(p1.number, 'REVOKED'))).toMatchObject({ applied: 'WITHDRAWN' });
    expect(await live(p1.id)).toEqual([]);
    expect(await live(p2.id)).toEqual([{ to: null }]);
  });
});

describe('platform.gap_needs_owner_or_qa (kernel 1320; D-P7-1 item 4)', () => {
  it('[DI-31] an alarm id that names no integration alarm needs neither the process owner nor QA', async () => {
    expect((await db.admin.query<{ r: boolean }>('select platform.gap_needs_owner_or_qa(gen_random_uuid()) as r')).rows[0]!.r).toBe(false);
  });
});
