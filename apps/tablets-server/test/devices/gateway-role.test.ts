/**
 * The site gateway's own least-privilege role (DI-17, INV-20; tablets migration 0290).
 *
 * The gateway identity holds SITE_GATEWAY, which carries INTERFACE.WRITE and nothing else. The database, not only the
 * listener, ties the gateway's work to that role: tab.ingest_reading and tab.record_heartbeat take a command of a
 * bound gateway session only when it acts in SITE_GATEWAY (tab.actor_gateway_key, EBMR-DEV-032). A gateway account
 * that also holds a broader role, such as the kernel's SERVICE_ACCOUNT (as on an installation seeded before 0290),
 * cannot send readings or heartbeats in it; one that holds only SERVICE_ACCOUNT cannot send them at all, whatever role
 * the listener picks.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type { ScaleReading } from '@ebmr/integration-sdk/scale';
import { passwordActor } from '@ebmr/test-kit';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { gatewayActor, gatewaySessionOf } from '../../src/features/devices/listener.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { INGEST_READING_SQL, adminActor, enrol, fakeGateway, gatewayService, GW, provenIngestParams, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server);
});

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

/** A fresh login of the fake gateway (roles are read again on every request; a new login starts a new session). */
async function relogin(): Promise<void> {
  await gw.close();
  gw = await fakeGateway(server);
}

/** The actor of the fake gateway's session as the listener builds it (the roles its account holds now), or in `roleCode`. */
async function sessionActor(roleCode?: string): Promise<ActorContext> {
  const hash = createHash('sha256').update(gw.token).digest('hex');
  const { rows } = await server.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
  const s = rows[0]?.r;
  if (!s) throw new Error('test set-up: the fake gateway session did not resolve');
  const actor = gatewayActor(gatewaySessionOf(hash, s), server.config.siteZone, randomUUID());
  return roleCode ? { ...actor, roleCode } : actor;
}

/** The roles the gateway's account holds now, as tab.resolve_gateway_session reports them to the listener. */
async function sessionRoles(): Promise<string[]> {
  const hash = createHash('sha256').update(gw.token).digest('hex');
  const { rows } = await server.db.app.query<{ roles: string[] }>("select tab.resolve_gateway_session($1) -> 'roles' as roles", [hash]);
  return rows[0]?.roles ?? [];
}

const HEARTBEAT = { gatewayTimeUs: '1790584618000000', devices: [{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }], journal: { lastSeq: '0', ackedSeq: '0' } };

const heartbeat = (actor: ActorContext) =>
  withActorCommand(server.db.app, actor, (c) => c.query('select tab.record_heartbeat($1::jsonb) as r', [JSON.stringify(HEARTBEAT)]));

/**
 * tab.ingest_reading in a command of `actor`, with the reading's wait proven as the gateway proves it (a challenge the
 * database issued to the session in SITE_GATEWAY, signed with the gateway key; tablets 0330), so only the role of
 * `actor` can make the difference.
 */
const ingest = async (actor: ActorContext, reading: ScaleReading) => {
  const params = await provenIngestParams(server, await sessionActor('SITE_GATEWAY'), reading);
  return withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, params));
};

/** The stored reading with the role its audit entry records, or nothing. */
async function stored(readingId: string): Promise<{ role: string }[]> {
  const { rows } = await server.db.admin.query<{ role: string }>(
    `select e.payload -> 'actor' ->> 'role_code' as role from tab.device_reading r
       join kernel.audit_event e on e.table_name = 'tab.device_reading' and e.record_id = r.id::text and e.action = 'INSERT'
      where r.id = $1`,
    [readingId],
  );
  return rows;
}

/** When the scale's last heartbeat was stored (null before the first one). */
async function lastHeartbeat(): Promise<string | null> {
  const { rows } = await server.db.admin.query<{ at: string | null }>(
    "select h.reported_at::text as at from tab.instrument_heartbeat h join iam.device d on d.id = h.instrument_device_id where d.code = 'TEST-BAL-01'",
  );
  return rows[0]?.at ?? null;
}

/** Grants the gateway identity a role (the administrator requests it, the process owner approves it); returns the grant. */
async function grantGateway(roleCode: string): Promise<string> {
  const account = gatewayService(server).accountId;
  const admin = await adminActor(server, `DI-17 test: the gateway identity also holds ${roleCode}`);
  const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint, {
    reasonCode: 'TEST_SETUP',
    reasonText: `DI-17 test: the gateway identity also holds ${roleCode}`,
    correlationId: randomUUID(),
  });
  try {
    const grantId = await withCommand(server.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: account, roleCode, reason: 'DI-17 test: a gateway seeded before 0290' }));
    await withCommand(server.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'DI-17 test: a gateway seeded before 0290'));
    return grantId;
  } finally {
    await identity.endSession(server.db.app, admin.sessionId);
    await identity.endSession(server.db.app, owner.sessionId);
  }
}

/** Revokes the gateway identity's live grant of `roleCode` (the administrator). */
async function revokeGateway(roleCode: string): Promise<void> {
  const account = gatewayService(server).accountId;
  const { rows } = await server.db.admin.query<{ id: string }>(
    "select id from iam.role_grant where account_id = $1 and role_code = $2 and status = 'APPROVED' and revoked_at is null",
    [account, roleCode],
  );
  const grantId = rows[0]?.id;
  if (!grantId) throw new Error(`test set-up: the gateway holds no live grant of ${roleCode}`);
  const admin = await adminActor(server, `DI-17 test: the gateway identity no longer holds ${roleCode}`);
  try {
    await withCommand(server.db.app, admin, (c) => identity.revokeRoleGrant(c, grantId, 'DI-17 test: the gateway holds only the broad role'));
  } finally {
    await identity.endSession(server.db.app, admin.sessionId);
  }
}

/** The database's refusal of a gateway command that does not act in SITE_GATEWAY. */
const notGatewayRole = (role: string): RegExp =>
  new RegExp(
    `^EBMR-DEV-032 DI-17: gateway ${GW} sends readings and heartbeats only in the role SITE_GATEWAY \\(interface write and nothing else\\); this command acts as ${role}$`,
  );

describe('the site gateway acts only in its own role (DI-17, INV-20)', () => {
  it('[DI-17][PR-47][IN-24] the gateway identity (SITE_GATEWAY: INTERFACE.WRITE) writes no ERP master data or order: a product permitting reprocessing, a material posted INTERMEDIATE and an order are refused, and nothing is stored (exit review HIGH-1; site-services 0802)', async () => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const writes: [string, Record<string, unknown>][] = [
      ['select site.erp_receive_product($1::jsonb)', { productCode: `GW${tag}`, strength: '500 mg', productName: 'x', reprocessingPermitted: true, betaLactam: false, shelfLifeMonths: 120, erpReference: 'GW' }],
      ['select site.erp_receive_material($1::jsonb)', { materialCode: `GW${tag}`, materialName: 'x', materialKind: 'INTERMEDIATE', unit: 'kg', erpReference: 'GW' }],
      ['select site.erp_receive_order($1::jsonb)', { orderNo: `GW${tag}`, siteCode: 'SITE-1', productCode: `GW${tag}`, strength: '500 mg', batchSize: '1', batchSizeUnit: 'kg', bom: [{ materialCode: `GW${tag}`, quantity: '1', unit: 'kg' }], erpReference: 'GW' }],
    ];
    for (const [sql, p] of writes) {
      await expect(withCommand(server.db.app, await sessionActor(), (c) => c.query(sql, [JSON.stringify(p)]))).rejects.toThrow(/EBMR-IAM-\d{3}.*ERP\.MASTER_WRITE/s);
    }
    const { rows } = await server.db.admin.query<{ n: string }>(
      "select ((select count(*) from site.erp_product where product_code = $1) + (select count(*) from site.erp_material where material_code = $1) + (select count(*) from site.erp_production_order where order_no = $1))::text as n",
      [`GW${tag}`],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('[DI-17][INV-20] the gateway identity holds SITE_GATEWAY alone, and the listener sends its readings and heartbeats in it: each stored reading records that role', async () => {
    expect(await sessionRoles()).toEqual(['SITE_GATEWAY']);
    expect((await sessionActor()).roleCode).toBe('SITE_GATEWAY');
    const r = gw.next();
    const up = await gw.uplink([{ reading: r }]);
    expect(up.status).toBe(200);
    expect(up.body.refused).toBeNull();
    expect(await stored(r.readingId)).toEqual([{ role: 'SITE_GATEWAY' }]);
    expect((await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }])).status).toBe(200);
  });

  it('[DI-17][INV-20] a gateway account that also holds the kernel\'s SERVICE_ACCOUNT (as one seeded before 0290) cannot send a reading or a heartbeat in that role: the database refuses it (EBMR-DEV-032) and stores nothing; in SITE_GATEWAY both are accepted, and the listener picks SITE_GATEWAY', async () => {
    await grantGateway('SERVICE_ACCOUNT');
    await relogin();
    expect(await sessionRoles()).toEqual(['SERVICE_ACCOUNT', 'SITE_GATEWAY']);

    const broad = await sessionActor('SERVICE_ACCOUNT');
    const before = await lastHeartbeat();
    await expect(heartbeat(broad)).rejects.toThrow(notGatewayRole('SERVICE_ACCOUNT'));
    expect(await lastHeartbeat()).toBe(before);
    const r = gw.next();
    await expect(ingest(broad, r)).rejects.toThrow(notGatewayRole('SERVICE_ACCOUNT'));
    expect(await stored(r.readingId)).toEqual([]);

    // The same session in SITE_GATEWAY: the heartbeat and the same reading are accepted.
    const own = await sessionActor('SITE_GATEWAY');
    await heartbeat(own);
    expect(await lastHeartbeat()).not.toBe(before);
    await ingest(own, r);
    expect(await stored(r.readingId)).toEqual([{ role: 'SITE_GATEWAY' }]);

    // Through the listener, holding both roles, the gateway acts in SITE_GATEWAY.
    expect((await sessionActor()).roleCode).toBe('SITE_GATEWAY');
    const next = gw.next();
    const up = await gw.uplink([{ reading: next }]);
    expect(up.body.refused).toBeNull();
    expect(await stored(next.readingId)).toEqual([{ role: 'SITE_GATEWAY' }]);
  });

  it('[DI-17][INV-20] a gateway account that holds only SERVICE_ACCOUNT cannot send readings or heartbeats at all: whatever role the listener acts in, the database refuses the reading, stores nothing and the refusal is alarmed', async () => {
    await revokeGateway('SITE_GATEWAY');
    await relogin();
    expect(await sessionRoles()).toEqual(['SERVICE_ACCOUNT']);

    const r = gw.next();
    // The listener acts only in SITE_GATEWAY, so the kernel refuses a role the account does not hold (EBMR-IAM-108);
    // in SERVICE_ACCOUNT the database would refuse the gateway's work too (EBMR-DEV-032, below). No challenge is issued
    // for an upload (tablets 0330), and that refusal is alarmed ...
    const challenge = await gw.post('/gw/v1/challenge', {});
    expect(challenge.status).toBe(422);
    expect((challenge.body as { error: { code: string } }).error.code).toBe('EBMR-IAM-108');
    const refusedChallenges = await server.db.admin.query<{ code: string }>(
      "select code from tab.device_alarm where kind = 'READING_REFUSED' and reading_id is null and message like 'DI-28: no challenge was issued%'",
    );
    expect(refusedChallenges.rows.map((a) => a.code)).toContain('EBMR-IAM-108');
    // ... and an upload naming any challenge is refused at its first reading the same way.
    const up = await gw.uplink([{ reading: r }], { challengeId: randomUUID() });
    expect(up.body.results).toEqual([]);
    expect(up.body.refused).toMatchObject({ readingId: r.readingId });
    expect(up.body.refused?.code).toMatch(/^EBMR-IAM-108$/);
    expect(await stored(r.readingId)).toEqual([]);
    const { rows } = await server.db.admin.query<{ code: string }>("select code from tab.device_alarm where kind = 'READING_REFUSED' and reading_id = $1", [r.readingId]);
    expect(rows.map((a) => a.code)).toEqual([up.body.refused?.code]);

    const before = await lastHeartbeat();
    expect((await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }])).status).toBe(422);
    expect(await lastHeartbeat()).toBe(before);
    await expect(heartbeat(await sessionActor('SERVICE_ACCOUNT'))).rejects.toThrow(notGatewayRole('SERVICE_ACCOUNT'));
  });
});
