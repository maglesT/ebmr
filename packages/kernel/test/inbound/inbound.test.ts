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
    withCommand(db.app, withReason(owner), (c) => c.query('select platform.set_setting($1, $2)', [`integration.mode.${cls.toLowerCase()}`, mode]));
  const sync = (cls: string, actor: SeededActor) => withCommand(db.app, ctxOf(actor), (c) => c.query('select platform.record_mirror_sync($1)', [cls]));

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

  it('[DI-31] only an adapter of the mirrored system records its synchronisation', async () => {
    await expectRefused(sync('LMS_QUALIFICATION', erp), 'EBMR-INT-013');
    const person = await testActor(db);
    await expectRefused(sync('LMS_QUALIFICATION', person), 'EBMR-INT-002');
  });
});
