/**
 * DeviceReadingPort.claim (module C5): the committing entry claims scale readings by id inside its own command.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAdmin, openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import type { ClaimedReading, ReadingClaim } from '../../src/platform/ports.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { adminActor, enrol, fakeGateway, operatorActor, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;

const MAX_AGE = 120_000_000n;

async function ingest(overrides: Parameters<FakeGateway['next']>[0] = {}, delayUs: string | null = '1000'): Promise<string> {
  const r = gw.next(overrides);
  const res = await gw.uplink([{ reading: r, delayUs }]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.refused, JSON.stringify(res.body.refused)).toBeNull();
  return r.readingId;
}

async function claimAs(claim: Partial<ReadingClaim> & { readingIds: readonly string[] }, persona = 'operator1'): Promise<ClaimedReading[]> {
  const actor = await operatorActor(server, persona);
  return withActorCommand(server.db.app, actor, (client) =>
    server.built.ctx.deviceReadings.claim(client, { room: 'DISP-1', maxAgeUs: MAX_AGE, purpose: 'GROSS', ...claim }),
  );
}

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server);
});

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

describe('DeviceReadingPort.claim', () => {
  it('[DI-32] a claimed reading yields its value, unit, raw line, device, source time and trust, and is recorded as used once', async () => {
    const id = await ingest({ value: '12.345', raw: 'S S     12.345 kg' });
    const claimed = await claimAs({ readingIds: [id] });
    expect(claimed).toEqual([
      { readingId: id, value: '12.345', unit: 'kg', raw: 'S S     12.345 kg', deviceCode: 'TEST-BAL-01', sourceTimeUs: 1790584618000000n, trust: 'DEVICE_UNSYNCED' },
    ]);
    const use = await server.db.app.query<{ purpose: string; room_code: string }>('select purpose, room_code from tab.reading_use where reading_id = $1', [id]);
    expect(use.rows).toEqual([{ purpose: 'GROSS', room_code: 'DISP-1' }]);
    // The use is audited on the reading's own chain, attributed to the operator (read as the owner: the application role
    // reads the audit trail only through its session-checked functions, tablets 0420).
    const audit = await server.db.admin.query<{ n: string }>(
      `select count(*)::text as n from kernel.audit_event where chain_key = $1 and action = 'INSERT' and table_name = 'tab.reading_use'`,
      [`device_reading:${id}`],
    );
    expect(audit.rows[0]?.n).toBe('1');
  });

  it('[DI-32] a reading that was already used is refused (EBMR-DEV-105)', async () => {
    const id = await ingest();
    await claimAs({ readingIds: [id] });
    await expect(claimAs({ readingIds: [id] })).rejects.toThrow(/EBMR-DEV-105/);
  });

  it('[DI-32] the same id twice in one claim is refused', async () => {
    const id = await ingest();
    await expect(claimAs({ readingIds: [id, id] })).rejects.toThrow(/EBMR-DEV-107/);
  });

  it('[DI-32] an unstable reading is refused; it can never be used as a stable weight', async () => {
    const id = await ingest({ value: '3.210', raw: 'S D      3.210 kg', stable: false, status: 'UNSTABLE' });
    await expect(claimAs({ readingIds: [id] })).rejects.toThrow(/EBMR-DEV-102/);
    const over = await ingest({ value: null, unit: null, raw: 'S +', stable: false, status: 'OVERLOAD' });
    await expect(claimAs({ readingIds: [over] })).rejects.toThrow(/EBMR-DEV-102/);
  });

  it('[DI-28] a stale reading is refused: older than the maximum age, or replayed after a gateway restart (wait unknown)', async () => {
    const waited = await ingest({}, '200000000');
    await expect(claimAs({ readingIds: [waited] })).rejects.toThrow(/EBMR-DEV-104/);
    const replayed = await ingest({}, null);
    await expect(claimAs({ readingIds: [replayed] })).rejects.toThrow(/EBMR-DEV-104/);
    const fresh = await ingest({}, '0');
    await expect(claimAs({ readingIds: [fresh], maxAgeUs: 1n })).rejects.toThrow(/EBMR-DEV-104/);
  });

  it('[DI-20] a reading from a scale in another room is refused, with an alert that survives the refused command', async () => {
    const id = await ingest();
    const before = await asAdmin(server.database, (c) => c.query<{ n: string }>(`select count(*)::text as n from iam.security_alert where kind = 'DEVICE_LOCATION_MISMATCH'`));
    await expect(claimAs({ readingIds: [id], room: 'BLEND-1' }, 'operator2')).rejects.toThrow(/EBMR-DEV-103/);
    const after = await asAdmin(server.database, (c) => c.query<{ n: string }>(`select count(*)::text as n from iam.security_alert where kind = 'DEVICE_LOCATION_MISMATCH'`));
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
    const alarm = await server.db.app.query('select 1 from tab.device_alarm where kind = $1 and reading_id = $2', ['CLAIM_REFUSED', id]);
    expect(alarm.rowCount).toBe(1);
    // Refused: still unused, so the right room can use it.
    await expect(claimAs({ readingIds: [id] })).resolves.toHaveLength(1);
    // A terminal without a room cannot use a reading at all.
    const other = await ingest();
    await expect(claimAs({ readingIds: [other], room: null })).rejects.toThrow(/EBMR-DEV-103/);
  });

  it('[DI-32] a reading taken as a tare cannot be used as a gross weight', async () => {
    const id = await ingest({ purpose: 'TARE' });
    await expect(claimAs({ readingIds: [id], purpose: 'GROSS' })).rejects.toThrow(/EBMR-DEV-106/);
    await expect(claimAs({ readingIds: [id], purpose: 'TARE' })).resolves.toHaveLength(1);
  });

  it('[DI-32] an unknown or malformed reading id is refused', async () => {
    await expect(claimAs({ readingIds: ['0b4f3c1e-1111-4222-8333-444455556666'] })).rejects.toThrow(/EBMR-DEV-101/);
    await expect(claimAs({ readingIds: ['not-a-uuid'] })).rejects.toThrow(/EBMR-DEV-101/);
  });

  it('[DI-32] two connections claiming the same reading at once: exactly one succeeds', async () => {
    const id = await ingest();
    // Both at a DISP-1 kiosk: a claim is only for the room of the session's own terminal (DI-20, review P49).
    const a1 = await operatorActor(server, 'operator1');
    const a2 = await operatorActor(server, 'operator2', 'TEST-KIOSK-DISP-1');
    const port = server.built.ctx.deviceReadings;
    // Hold the first claim's transaction open until the second has started, so they really overlap.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withActorCommand(server.db.app, a1, async (client) => {
      const out = await port.claim(client, { readingIds: [id], room: 'DISP-1', maxAgeUs: MAX_AGE, purpose: 'GROSS' });
      await held;
      return out;
    });
    const second = withActorCommand(server.db.app, a2, (client) => port.claim(client, { readingIds: [id], room: 'DISP-1', maxAgeUs: MAX_AGE, purpose: 'GROSS' }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toMatch(/EBMR-DEV-105/);
    const uses = await server.db.app.query('select 1 from tab.reading_use where reading_id = $1', [id]);
    expect(uses.rowCount).toBe(1);
  });

  it('[DI-31] only a person\'s entry can claim: the gateway identity and the administrator are refused', async () => {
    const id = await ingest();
    const gwActor = await openServiceSession(server.db, server.seed, 'gateway');
    await expect(
      withActorCommand(server.db.app, gwActor, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: MAX_AGE, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-100|EBMR-IAM-04/);
    const admin = await adminActor(server);
    await expect(
      withActorCommand(server.db.app, admin, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: MAX_AGE, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-IAM-042/);
    // Without a command (no validated actor) nothing is claimed.
    await expect(server.db.app.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS')", [id])).rejects.toThrow(/EBMR-IAM-00[12]/);
  });

  it('[INV-40] a kiosk claim runs only in a command that consumed the person\'s fresh tap', async () => {
    const id = await ingest();
    const noTap = await openPersonaSession(server.db, server.seed, 'operator1');
    await expect(
      withActorCommand(server.db.app, noTap, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: MAX_AGE, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-IAM-120/);
  });

  it('[DI-32] the application role can neither write readings nor uses directly (only the checked functions can)', async () => {
    const id = await ingest();
    // server.db.app is this installation's application role (ebmr_sandbox, mirroring ebmr_app).
    await expect(
      server.db.app.query(
        "insert into tab.reading_use (reading_id, purpose, room_code, person_id, account_id, session_id, correlation_id) values ($1, 'GROSS', 'DISP-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        [id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(server.db.app.query("update tab.device_reading set value = '9.999' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(server.db.app.query('delete from tab.device_reading where id = $1', [id])).rejects.toThrow(/permission denied/);
    // Even the owner cannot change a reading: the table is insert-only.
    await expect(asAdmin(server.database, (c) => c.query("update tab.device_reading set value = '9.999' where id = $1", [id]))).rejects.toThrow(/EBMR-AUDIT-004/);
  });
});
