/**
 * The inbound adapter framework (kernel 1180; Phase 6 slice 6a-0): integration identities (DI-20, DI-14), the
 * receiving function platform.accept_inbound (DI-31: validation, de-duplication, sequence alarms, whole-message
 * commit), refusals with alarms, reconciliation, and the fail-closed mirror guard (INV-26, INV-38). Everything runs as
 * the application role through real identities; bypass attempts go through the same pool.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { requestRoleGrant } from '../../src/identity/admin.ts';
import { heldHead } from '../integrations/support.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { expectPermissionDenied, expectRefused, testActor } from '../identity/helpers.ts';
import { seedAdministration, seedAuthn, seedServiceActor, withReason, type SeededActor } from '../identity/seed.ts';

let db: TestDatabase;
let admin: SeededActor;
let owner: SeededActor;
let erp: SeededActor;
let lms: SeededActor;
const ERP = `ERP-${randomBytes(3).toString('hex').toUpperCase()}`;
const LMS = `LMS-${randomBytes(3).toString('hex').toUpperCase()}`;

const ctxOf = (a: SeededActor, extra: Partial<ActorContext> = {}): ActorContext => {
  const { seed: _seed, ...c } = a;
  void _seed;
  return { ...c, correlationId: randomUUID(), ...extra };
};

async function register(actor: SeededActor, code: string, system: string): Promise<string> {
  return withCommand(db.app, withReason(admin), async (c) => {
    const { rows } = await c.query<{ id: string }>('select iam.register_integration_adapter($1, $2, $3, $4, $5) as id', [
      code, system, actor.accountId, actor.deviceId, `test adapter ${code}`,
    ]);
    return rows[0]?.id ?? '';
  });
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
let seq = 0;
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const payload = { orderNumber: `PO-${seq.toString()}`, productCode: 'P1', plannedQuantity: { value: '100.0', unit: 'kg' }, bom: [], plannedStart: '1760000000000000' };
  return {
    sourceSystem: 'ERP_WMS',
    messageType: 'erp.production_order',
    sourceRecordId: payload.orderNumber,
    sourceTimestamp: '1760000000000000',
    sequenceNo: seq.toString(),
    idempotencyKey: `k-${randomUUID()}`,
    schemaVersion: '1',
    payloadHash: sha(JSON.stringify(payload)),
    payload,
    ...over,
  };
}

interface Outcome {
  messageId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE';
  sequenceStatus: string;
  alarmId: string | null;
}
const accept = (e: unknown, actor: SeededActor = erp): Promise<Outcome> =>
  withCommand(db.app, ctxOf(actor), async (c) => (await c.query<{ r: Outcome }>('select platform.accept_inbound_detail($1::jsonb) as r', [JSON.stringify(e)])).rows[0]?.r as Outcome);

const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.admin.query<{ n: string }>(sql, params)).rows[0]?.n ?? -1);
const messages = (): Promise<number> => count('select count(*) as n from platform.inbound_message where adapter_code = $1', [ERP]);
const alarms = (): Promise<number> => count('select count(*) as n from platform.integration_alarm where adapter_code = $1', [ERP]);

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  ({ admin, owner } = await seedAdministration(db));
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', name: 'ERP adapter 1' });
  lms = await seedServiceActor(db, { kind: 'INTEGRATION', name: 'LMS adapter 1' });
  await register(erp, ERP, 'ERP_WMS');
  await register(lms, LMS, 'LMS');
}, 120_000);
afterAll(async () => {
  await db.drop();
});

describe('integration identities (DI-20, DI-14)', () => {
  it('[DI-20] an unregistered adapter identity is refused', async () => {
    const stranger = await seedServiceActor(db, { kind: 'INTEGRATION', name: 'Unregistered adapter' });
    await expectRefused(accept(envelope(), stranger), 'EBMR-INT-002');
    const person = await testActor(db);
    await expectRefused(accept(envelope(), person), 'EBMR-INT-002');
    // A registered adapter that is blocked is refused too, and so is a refusal it tries to record.
    const blocked = await seedServiceActor(db, { kind: 'INTEGRATION', name: 'Blocked adapter' });
    const id = await register(blocked, `BLK-${randomBytes(3).toString('hex').toUpperCase()}`, 'ERP_WMS');
    await withCommand(db.app, withReason(admin), (c) => c.query("select iam.set_integration_adapter_status($1, 'BLOCKED', 'link compromised')", [id]));
    await expectRefused(accept(envelope(), blocked), 'EBMR-INT-002');
    await expectRefused(
      withCommand(db.app, ctxOf(blocked), (c) => c.query("select platform.record_inbound_refusal('{}'::jsonb, 'MALFORMED', 'x')")),
      'EBMR-INT-002',
    );
  });

  it('[DI-20] only an INTEGRATION account on an active SERVER device is registered, by the device administrator, once per account', async () => {
    const person = await testActor(db);
    const code = () => `X-${randomBytes(3).toString('hex').toUpperCase()}`;
    const reg = (by: SeededActor, account: string, device: string) =>
      withCommand(db.app, withReason(by), (c) => c.query('select iam.register_integration_adapter($1, $2, $3, $4, $5)', [code(), 'QMS', account, device, 'test']));
    await expectRefused(reg(admin, person.accountId, erp.deviceId), 'EBMR-INT-012');
    const spare = await seedServiceActor(db, { kind: 'INTEGRATION', name: 'Spare adapter' });
    await expectRefused(reg(admin, spare.accountId, person.deviceId), 'EBMR-INT-012');
    await expectRefused(reg(owner, spare.accountId, spare.deviceId), 'EBMR-IAM-040');
    await expect(reg(admin, erp.accountId, erp.deviceId)).rejects.toThrow(/integration_adapter_one_per_account/);
    // The registry is the adapter's identity: the application cannot touch it, and its account, device and system never change.
    await expectPermissionDenied(
      withCommand(db.app, withReason(admin), (c) => c.query("update iam.integration_adapter set source_system = 'QMS' where code = $1", [ERP])),
    );
    await expectRefused(db.admin.query("update iam.integration_adapter set source_system = 'QMS' where code = $1", [ERP]), 'EBMR-INT-016');
  });

  it('[DI-31][DI-14] an integration identity cannot sign', async () => {
    // No role that signs or acknowledges can be granted to it,
    await expectRefused(
      withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId: erp.accountId, roleCode: 'OPERATOR', reason: 'try to let the ERP sign' })),
      'EBMR-IAM-035',
      /DI-14/,
    );
    // it cannot authenticate for a signature with its service key,
    await expect(
      authenticate(seedAuthn(db), { method: 'SERVICE_KEY', identifier: erp.seed.loginName, secret: erp.seed.password, deviceFingerprint: erp.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: randomUUID() }),
    ).rejects.toThrow(/EBMR-IAM-\d{3}/);
    // it cannot acknowledge an alarm (an ACKNOWLEDGE act), not even one about its own feed,
    await accept(envelope());
    const r = await accept(envelope({ sequenceNo: (seq + 50).toString() }));
    seq += 50;
    expect(r.alarmId).not.toBeNull();
    await expectRefused(
      withCommand(db.app, withReason(erp), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [r.alarmId, 'self-acknowledged'])),
      'EBMR-PLAT-006',
    );
    // and it cannot write a signature row directly.
    await expectPermissionDenied(withCommand(db.app, ctxOf(erp), (c) => c.query("insert into esig.signature (id) values (gen_random_uuid())")));
  });
});

describe('platform.accept_inbound (DI-31)', () => {
  it('[DI-31] an accepted message keeps its source system, record id, source time, raw payload and hash, in the audit trail', async () => {
    const e = envelope();
    const r = await accept(e);
    expect(r.outcome).toBe('ACCEPTED');
    const { rows } = await db.app.query(
      `select source_system, message_type, source_record_id, (extract(epoch from source_timestamp) * 1000000)::bigint::text as ts, sequence_no::text as seq,
              idempotency_key, payload_hash, payload from platform.inbound_message where id = $1`,
      [r.messageId],
    );
    expect(rows[0]).toEqual({
      source_system: 'ERP_WMS', message_type: 'erp.production_order', source_record_id: e['sourceRecordId'], ts: '1760000000000000', seq: e['sequenceNo'],
      idempotency_key: e['idempotencyKey'], payload_hash: e['payloadHash'], payload: e['payload'],
    });
    expect(await count("select count(*) as n from kernel.audit_event where chain_key = $1 and record_id = $2", [`integration_adapter:${ERP}`, r.messageId])).toBe(1);
    // The uuid form returns the same message for a resend.
    const again = await withCommand(db.app, ctxOf(erp), async (c) => (await c.query<{ id: string }>('select platform.accept_inbound($1::jsonb) as id', [JSON.stringify(e)])).rows[0]?.id);
    expect(again).toBe(r.messageId);
  });

  it('[DI-31] a malformed envelope, a wrong source system and an unknown message type or version are refused and leave nothing', async () => {
    const before = [await messages(), await alarms()];
    const { idempotencyKey: _k, ...missing } = envelope();
    void _k;
    await expectRefused(accept(missing), 'EBMR-INT-001', /fields/);
    await expectRefused(accept({ ...envelope(), sequenceNo: 7 }), 'EBMR-INT-001', /sequenceNo/);
    await expectRefused(accept({ ...envelope(), extra: 'x' }), 'EBMR-INT-001');
    await expectRefused(accept({ ...envelope(), payloadHash: 'ABC' }), 'EBMR-INT-001', /payloadHash/);
    await expectRefused(accept({ ...envelope(), payload: [1] }), 'EBMR-INT-001', /payload/);
    await expectRefused(accept('not an object'), 'EBMR-INT-001');
    await expectRefused(accept({ ...envelope(), sourceSystem: 'QMS', messageType: 'qms.capa' }), 'EBMR-INT-003', /speaks for ERP_WMS/);
    await expectRefused(accept({ ...envelope(), messageType: 'erp.unknown_thing' }), 'EBMR-INT-004');
    await expectRefused(accept({ ...envelope(), schemaVersion: '2' }), 'EBMR-INT-004');
    expect([await messages(), await alarms()]).toEqual(before);
  });

  it('[DI-31] a resent message is de-duplicated by its idempotency key; the same key with other content is refused', async () => {
    const e = envelope();
    const first = await accept(e);
    const resend = await accept({ ...e, sequenceNo: (seq + 1).toString() });
    expect(resend).toMatchObject({ messageId: first.messageId, outcome: 'DUPLICATE' });
    expect(await count("select count(*) as n from platform.inbound_exception where message_id = $1 and kind = 'DEDUPLICATED'", [first.messageId])).toBe(1);
    expect(await count('select count(*) as n from platform.inbound_message where idempotency_key = $1', [e['idempotencyKey']])).toBe(1);
    await expectRefused(accept({ ...e, payloadHash: sha('other content') }), 'EBMR-INT-005');
  });

  it('[DI-31] a sequence gap and a late message are accepted with an integration alarm; a sequence number already taken is refused', async () => {
    const base = seq + 1;
    seq = base;
    expect((await accept(envelope({ sequenceNo: base.toString() }))).alarmId).toBeNull();
    const gap = await accept(envelope({ sequenceNo: (base + 3).toString() }));
    expect(gap).toMatchObject({ outcome: 'ACCEPTED', sequenceStatus: 'GAP' });
    const late = await accept(envelope({ sequenceNo: (base + 1).toString() }));
    expect(late).toMatchObject({ outcome: 'ACCEPTED', sequenceStatus: 'LATE' });
    const { rows } = await db.app.query<{ kind: string; details: Record<string, string> }>(
      'select kind, details from platform.integration_alarm where id = any($1) order by raised_at',
      [[gap.alarmId, late.alarmId]],
    );
    expect(rows).toEqual([
      { kind: 'SEQUENCE_GAP', details: { expected: String(base + 1), received: String(base + 3), missingFrom: String(base + 1), missingTo: String(base + 2) } },
      { kind: 'OUT_OF_ORDER', details: { highestBefore: String(base + 3), received: String(base + 1) } },
    ]);
    await expectRefused(accept(envelope({ sequenceNo: (base + 3).toString() })), 'EBMR-INT-006');
    seq = base + 3;
  });

  it('[DI-31] a message is committed whole or not at all: when the receiving command fails, no message and no alarm remain', async () => {
    const before = [await messages(), await alarms()];
    const e = envelope({ sequenceNo: (seq + 10).toString() });
    seq += 10;
    await expect(
      withCommand(db.app, ctxOf(erp), async (c) => {
        const { rows } = await c.query<{ r: Outcome }>('select platform.accept_inbound_detail($1::jsonb) as r', [JSON.stringify(e)]);
        expect(rows[0]?.r.sequenceStatus).toBe('GAP');
        throw new Error('link cut while the payload was being applied');
      }),
    ).rejects.toThrow(/link cut/);
    expect([await messages(), await alarms()]).toEqual(before);
    // The adapter retries the same envelope (same key): accepted once.
    expect((await accept(e)).outcome).toBe('ACCEPTED');
  });

  it('[DI-31] a refusal is recorded with its alarm in its own command; a person acknowledges the alarm once, with a note', async () => {
    const bad: Record<string, unknown> = { ...envelope(), payload: 'garbled' };
    const id = await withCommand(db.app, ctxOf(erp), async (c) =>
      (await c.query<{ id: string }>("select platform.record_inbound_refusal($1::jsonb, 'MALFORMED', 'EBMR-INT-001 payload must be a JSON object') as id", [JSON.stringify(bad)])).rows[0]?.id ?? '');
    const { rows } = await db.app.query<{ alarm_id: string; kind: string; error_class: string; idempotency_key: string }>(
      'select alarm_id, kind, error_class, idempotency_key from platform.inbound_exception where id = $1', [id]);
    expect(rows[0]).toMatchObject({ kind: 'REFUSED', error_class: 'MALFORMED', idempotency_key: bad['idempotencyKey'] });
    await expectRefused(
      withCommand(db.app, ctxOf(erp), (c) => c.query("select platform.record_inbound_refusal('{}'::jsonb, 'TRANSPORT', 'timeout')")),
      'EBMR-INT-014',
    );
    const operator = await testActor(db);
    const ack = (note: string) => withCommand(db.app, ctxOf(operator), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [rows[0]?.alarm_id, note]));
    await expectRefused(ack('  '), 'EBMR-INT-008');
    await ack('ERP team informed; order re-sent');
    await expectRefused(ack('again'), 'EBMR-INT-007');
    expect(await count('select count(*) as n from platform.integration_alarm_ack where alarm_id = $1 and acknowledged_by = $2', [rows[0]?.alarm_id, operator.personId])).toBe(1);
  });

  it('[DI-31] reconciliation matches when the source count and checksum agree, and alarms when a message is missing', async () => {
    const from = '1800000000000000';
    const to = '1800000060000000';
    const sent = [envelope({ sourceTimestamp: '1800000001000000' }), envelope({ sourceTimestamp: '1800000002000000' })];
    for (const e of sent) await accept(e);
    const lines = sent.map((e) => `${String(e['idempotencyKey'])}|${String(e['payloadHash'])}`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const report = (n: number, checksum: string) =>
      withCommand(db.app, ctxOf(erp), async (c) =>
        (await c.query<{ id: string }>('select platform.record_reconciliation($1::jsonb) as id', [JSON.stringify({ periodFrom: from, periodTo: to, sourceCount: String(n), sourceChecksum: checksum })])).rows[0]?.id ?? '');
    const ok = await report(2, sha(lines.join('\n')));
    const lost = await report(3, sha([...lines, `zz|${'0'.repeat(64)}`].join('\n')));
    const { rows } = await db.app.query<{ id: string; matched: boolean; received_count: string; alarm: boolean }>(
      'select id, matched, received_count::text, alarm_id is not null as alarm from platform.reconciliation_report where id = any($1)', [[ok, lost]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.matched, r.received_count, r.alarm]]))).toEqual({ [ok]: [true, '2', false], [lost]: [false, '2', true] });
  });

  it('[DI-31] the application role writes none of the inbound tables directly, and an accepted message never changes', async () => {
    const ctx = ctxOf(erp);
    for (const sql of [
      "insert into platform.inbound_message (adapter_id) values (gen_random_uuid())",
      'update platform.inbound_message set payload = \'{}\'::jsonb',
      'delete from platform.integration_alarm',
      'insert into platform.integration_alarm_ack (alarm_id) values (gen_random_uuid())',
      "update iam.integration_adapter set status = 'ACTIVE'",
      "insert into platform.mirror_sync (data_class) values ('LMS_QUALIFICATION')",
      "insert into platform.inbound_schema (source_system) values ('ERP_WMS')",
    ]) {
      await expectPermissionDenied(withCommand(db.app, ctx, (c) => c.query(sql)));
    }
    await expectRefused(db.admin.query("update platform.inbound_message set payload = '{}'::jsonb where adapter_code = $1", [ERP]), 'EBMR-AUDIT-004');
  });
});

describe('fail-closed mirrors (DI-31, INV-26, INV-38)', () => {
  const fresh = (cls: string, actor: SeededActor = erp) =>
    withCommand(db.app, ctxOf(actor), async (c) => (await c.query<{ f: Record<string, unknown> }>('select platform.mirror_fresh_or_raise($1) as f', [cls])).rows[0]?.f);
  const setMode = (cls: string, mode: string) =>
    withCommand(db.app, underChange(withReason(owner)), (c) => c.query('select platform.set_setting($1, $2)', [`integration.mode.${cls.toLowerCase()}`, mode]));
  const sync = async (cls: string, actor: SeededActor, code = LMS) => {
    const head = await heldHead(db, code);
    return withCommand(db.app, ctxOf(actor), (c) => c.query('select platform.record_mirror_sync($1, $2)', [cls, head]));
  };

  it('[DI-31] mirror_fresh_or_raise refuses a stale MIRROR and names it, and passes in STAND_IN', async () => {
    expect(await fresh('LMS_QUALIFICATION')).toMatchObject({ mode: 'STAND_IN', stale: false, asOfUs: null, boundSeconds: null });
    await setMode('LMS_QUALIFICATION', 'MIRROR');
    await expectRefused(fresh('LMS_QUALIFICATION'), 'EBMR-INT-010', /LMS mirror LMS_QUALIFICATION is stale: it has never synchronised.*3600 s/);
    await sync('LMS_QUALIFICATION', lms);
    expect(await fresh('LMS_QUALIFICATION')).toMatchObject({ mode: 'MIRROR', stale: false, boundSeconds: '3600', ageSeconds: '0' });
    // The heartbeat stops while the data stays: two hours later the mirror fails closed and says how old it is.
    await db.admin.query("update platform.mirror_sync set last_synced_at = last_synced_at - interval '2 hours' where data_class = 'LMS_QUALIFICATION'");
    await expectRefused(fresh('LMS_QUALIFICATION'), 'EBMR-INT-010', /LMS mirror LMS_QUALIFICATION is stale: last synchronised 720\d s ago/);
    await setMode('LMS_QUALIFICATION', 'STAND_IN');
    expect(await fresh('LMS_QUALIFICATION')).toMatchObject({ mode: 'STAND_IN', stale: false });
  });

  it('[DI-31] a stale non-blocking mirror (quantity on hand) is flagged, not refused; an unknown class is refused', async () => {
    await setMode('WMS_STOCK', 'MIRROR');
    expect(await fresh('WMS_STOCK')).toMatchObject({ mode: 'MIRROR', blocking: false, stale: true, boundSeconds: '86400' });
    await expectRefused(fresh('NO_SUCH_CLASS'), 'EBMR-INT-011');
    await expectRefused(setMode('WMS_STOCK', 'BOTH'), 'EBMR-PLAT-021');
  });

  /** A second ERP_WMS adapter with a feed of its own (sequence numbers from 1), so earlier tests leave no gaps on it. */
  const freshFeed = async () => {
    const actor = await seedServiceActor(db, { kind: 'INTEGRATION', name: `ERP adapter ${randomUUID().slice(0, 6)}` });
    const code = `ERP-${randomBytes(3).toString('hex').toUpperCase()}`;
    await register(actor, code, 'ERP_WMS');
    const send = (n: number) => accept(envelope({ sequenceNo: n.toString() }), actor);
    // A gap on a blocking mirror's adapter is acknowledged by QA or the system owner (kernel 1320, 6jc-R11).
    const acknowledgeGap = async (alarmId: string | null, by?: SeededActor) => {
      const qa = by ?? await testActor(db, { roleCode: 'QA_REVIEWER' });
      await withCommand(db.app, ctxOf(qa), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [alarmId, 'message 4 was a test order cancelled in the ERP']));
    };
    const syncAt = (head: string) => withCommand(db.app, ctxOf(actor), (c) => c.query("select platform.record_mirror_sync('ERP_LOT_STATUS', $1)", [head]));
    const mark = async () => (await db.admin.query<{ h: string | null }>("select source_head::text as h from platform.mirror_sync where data_class = 'ERP_LOT_STATUS'")).rows[0]?.h;
    return { send, syncAt, mark, acknowledgeGap };
  };
  const ageLotStatus = () => db.admin.query("update platform.mirror_sync set last_synced_at = last_synced_at - interval '2 hours' where data_class = 'ERP_LOT_STATUS'");

  it('[DI-31] a heartbeat from an adapter behind the source does not refresh its mirror', async () => {
    await setMode('ERP_LOT_STATUS', 'MIRROR');
    try {
      const feed = await freshFeed();
      await db.admin.query("delete from platform.mirror_sync where data_class = 'ERP_LOT_STATUS'");
      await feed.send(1);
      await feed.send(2);
      // The source has published 3; the adapter holds 2: the heartbeat is refused and the mirror stays stale.
      await expectRefused(feed.syncAt('3'), 'EBMR-INT-019', /behind its source: it holds sequence 2, the ERP_WMS source is at 3/);
      await expectRefused(fresh('ERP_LOT_STATUS'), 'EBMR-INT-010', /it has never synchronised/);
      // A heartbeat names the source's mark; one that is not a sequence number is refused.
      await expectRefused(feed.syncAt(''), 'EBMR-INT-018');
      await expectRefused(feed.syncAt('-1'), 'EBMR-INT-018');
      // Message 4 arrives before 3 (a gap with its alarm): the highest number held reaches the head, but 3 is missing.
      expect((await feed.send(4)).sequenceStatus).toBe('GAP');
      await expectRefused(feed.syncAt('4'), 'EBMR-INT-024', /holds no message for 1 sequence number\(s\) up to the source's 4 \(the first is 3\)/);
      await expectRefused(fresh('ERP_LOT_STATUS'), 'EBMR-INT-010');
      // Fresh once 3 arrives; a later heartbeat of an adapter that fell behind keeps the old time, so the mirror ages.
      await feed.send(3);
      await feed.syncAt('4');
      await ageLotStatus();
      await expectRefused(feed.syncAt('6'), 'EBMR-INT-019');
      await expectRefused(fresh('ERP_LOT_STATUS'), 'EBMR-INT-010', /last synchronised 720\d s ago/);
      expect(await feed.mark()).toBe('4');
    } finally {
      await setMode('ERP_LOT_STATUS', 'STAND_IN');
    }
  });

  it('[DI-31] a synchronisation from an adapter caught up with its source refreshes its mirror and keeps the source mark; a gap counts once a person acknowledges it', async () => {
    await setMode('ERP_LOT_STATUS', 'MIRROR');
    try {
      const feed = await freshFeed();
      // A source that has published nothing: caught up with nothing held.
      await feed.syncAt('0');
      expect(await fresh('ERP_LOT_STATUS')).toMatchObject({ mode: 'MIRROR', stale: false, ageSeconds: '0' });
      for (const n of [1, 3, 2]) await feed.send(n);
      await ageLotStatus();
      // The late 2 filled the gap: every number up to the head is held, so the heartbeat refreshes the mirror.
      await feed.syncAt('3');
      expect(await fresh('ERP_LOT_STATUS')).toMatchObject({ mode: 'MIRROR', stale: false, ageSeconds: '0' });
      expect(await feed.mark()).toBe('3');
      // Message 4 never comes (the worker pages on from its highest number, so it is never asked again): the mirror is
      // not refreshed until a person acknowledges the gap alarm with a note.
      const gap = await feed.send(5);
      expect(gap.sequenceStatus).toBe('GAP');
      await expectRefused(feed.syncAt('5'), 'EBMR-INT-024', /\(the first is 4\)/);
      await feed.acknowledgeGap(gap.alarmId);
      await feed.syncAt('5');
      expect(await feed.mark()).toBe('5');
      // The application can neither write the mark itself nor call the old form that named no mark.
      await expectPermissionDenied(withCommand(db.app, ctxOf(erp), (c) => c.query("update platform.mirror_sync set source_head = 99 where data_class = 'ERP_LOT_STATUS'")));
      await expect(withCommand(db.app, ctxOf(erp), (c) => c.query("select platform.record_mirror_sync('ERP_LOT_STATUS')"))).rejects.toThrow(/does not exist/);
    } finally {
      await setMode('ERP_LOT_STATUS', 'STAND_IN');
    }
  });

  it('[DI-31] a sequence gap on a blocking mirror\'s adapter is acknowledged by the system owner or QA only; an operator\'s acknowledgment no longer marks the mirror fresh (6jc-R11)', async () => {
    await setMode('ERP_LOT_STATUS', 'MIRROR');
    try {
      const feed = await freshFeed();
      await feed.syncAt('0');
      await feed.send(1);
      const gap = await feed.send(3);
      expect(gap.sequenceStatus).toBe('GAP');
      const ack = (who: SeededActor, alarmId: string | null) =>
        withCommand(db.app, ctxOf(who), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [alarmId, 'message 2 was a cancelled order']));
      // ALARM.ACKNOWLEDGE is not enough: the operator and the shift supervisor are refused, the administrator first of all.
      const [operator, supervisor] = await Promise.all([testActor(db), testActor(db, { roleCode: 'SHIFT_SUPERVISOR' })]);
      await expectRefused(ack(operator, gap.alarmId), 'EBMR-PLAT-006', /ALARM\.ACKNOWLEDGE_GAP/);
      await expectRefused(ack(supervisor, gap.alarmId), 'EBMR-PLAT-006', /ALARM\.ACKNOWLEDGE_GAP/);
      await expectRefused(ack(admin, gap.alarmId), 'EBMR-IAM-042');
      // Nobody accounted for message 2, so the mirror is not refreshed over it.
      await expectRefused(feed.syncAt('3'), 'EBMR-INT-024', /\(the first is 2\)/);
      // The application cannot write an acknowledgment itself.
      await expectPermissionDenied(withCommand(db.app, ctxOf(operator), (c) => c.query(
        "insert into platform.integration_alarm_ack (alarm_id, adapter_code, note, acknowledged_by, acknowledged_role) values ($1, 'x', 'n', $2, 'OPERATOR')", [gap.alarmId, operator.personId])));
      // The system owner acknowledges it; then the mirror is fresh again.
      await feed.acknowledgeGap(gap.alarmId, owner);
      await feed.syncAt('3');
      expect(await fresh('ERP_LOT_STATUS')).toMatchObject({ mode: 'MIRROR', stale: false });
      expect(await count("select count(*) as n from platform.integration_alarm_ack where alarm_id = $1 and acknowledged_role = 'PROCESS_OWNER'", [gap.alarmId])).toBe(1);
      // QA acknowledges the next one.
      const next = await feed.send(5);
      await feed.acknowledgeGap(next.alarmId);
      expect(await count("select count(*) as n from platform.integration_alarm_ack where alarm_id = $1 and acknowledged_role = 'QA_REVIEWER'", [next.alarmId])).toBe(1);
    } finally {
      await setMode('ERP_LOT_STATUS', 'STAND_IN');
    }
    // A gap on an adapter whose system feeds no blocking mirror (a LIMS) stays the operator's to acknowledge.
    const lims = await seedServiceActor(db, { kind: 'INTEGRATION', name: `LIMS adapter ${randomUUID().slice(0, 6)}` });
    const limsCode = `LIMS-${randomBytes(3).toString('hex').toUpperCase()}`;
    const limsId = await register(lims, limsCode, 'LIMS');
    // (The alarm is a fixture, triggers off: a LIMS feed of its own is not needed to raise one.)
    const fx = await db.admin.connect();
    let rows: { id: string }[];
    try {
      await fx.query('begin');
      await fx.query('set local session_replication_role = replica');
      ({ rows } = await fx.query<{ id: string }>(
        "insert into platform.integration_alarm (adapter_id, adapter_code, kind, severity, details) values ($1, $2, 'SEQUENCE_GAP', 'MAJOR', '{\"missingFrom\": \"2\", \"missingTo\": \"2\"}') returning id",
        [limsId, limsCode]));
      await fx.query('commit');
    } finally {
      fx.release();
    }
    expect((await db.app.query<{ b: boolean }>('select platform.gap_needs_owner_or_qa($1) as b', [rows[0]?.id])).rows[0]?.b).toBe(false);
    const operator = await testActor(db);
    await withCommand(db.app, ctxOf(operator), (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [rows[0]?.id, 'LIMS resent result 2']));
  });

  it('[DI-31] only an adapter of the mirrored system records its synchronisation', async () => {
    await expectRefused(sync('LMS_QUALIFICATION', erp), 'EBMR-INT-013');
    const person = await testActor(db);
    await expectRefused(sync('LMS_QUALIFICATION', person), 'EBMR-INT-002');
  });
});
