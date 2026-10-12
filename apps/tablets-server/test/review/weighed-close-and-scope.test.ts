/**
 * Slice 1 quick review, findings 1, 7 and 8 on a run with real gateway readings (tablets 1141; recipe-core 0719): a
 * weighed close reads its tare and gross on one balance while the container is open; the person who opened and closed
 * the container is in the batch's involvement set; the readings the close used are in the batch's audit-trail scope.
 * As the application role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { SITE_CODE } from '@ebmr/test-kit';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../src/features/devices/enrol.ts';
import { codeOf } from '../execution/db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { adminActor, fakeGateway, gatewayKey, operatorActor, type FakeGateway } from '../devices/support.ts';

let sbx: ExecServer;
let gw: FakeGateway;
let runId: string;

async function ingest(value: string, purpose: 'TARE' | 'GROSS', device = 'TEST-BAL-01'): Promise<string> {
  const r = gw.next({ value, unit: 'kg', purpose, deviceCode: device, serial: device === 'TEST-BAL-01' ? 'SIM-0001' : 'SIM-0009', raw: `S S ${value.padStart(10)} kg` });
  const res = await gw.uplink([{ reading: r, delayUs: '1000' }]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return r.readingId;
}
async function asOperator<T>(text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await operatorActor(sbx, 'operator1'), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
const open = () => asOperator<{ container_id: string; version: number }>("select plant.open_container($1, 'GRANULATION', 'kg') as r", [runId]);
const close = (c: { container_id: string; version: number }, tare: string, gross: string) =>
  asOperator('select tab.close_container_weighed($1, $2, $3, $4) as r', [c.container_id, tare, gross, c.version]);

beforeAll(async () => {
  sbx = await startExecServer();
  // A second balance in the dispensing room, behind the same gateway.
  await withCommand(sbx.db.app, await adminActor(sbx), (c) =>
    identity.registerDevice(c, {
      code: 'TEST-BAL-09', deviceClass: 'INSTRUMENT', site: SITE_CODE, room: 'DISP-1',
      fingerprint: identity.deviceFingerprint(new TextEncoder().encode(`instrument:${SITE_CODE}:TEST-BAL-09`)), description: 'Second balance in DISP-1 (test)',
    }),
  );
  await enrolGateway(sbx.db.app, await adminActor(sbx), {
    ...DEMO_GATEWAY,
    spki: gatewayKey(sbx).publicKeySpki,
    instruments: [...DEMO_INSTRUMENTS, { deviceCode: 'TEST-BAL-09', serial: 'SIM-0009', unit: 'kg', resolution: '0.001' }],
  });
  gw = await fakeGateway(sbx);
  runId = await importAndIssue(sbx, await sbx.asPersona('issuer'), writePackage(sbx, dcMini()));
}, 300_000);
afterAll(async () => {
  await gw?.close();
  await sbx?.close();
});

describe('weighed close, involvement and scope (slice 1 quick review)', () => {
  it('[DI-30][DI-32] a weighed close reads the tare and the gross on one balance, both received while the container is open; nothing is closed otherwise', async () => {
    const early = await ingest('1.000', 'TARE');
    const c = await open();
    expect(await codeOf(close(c, early, await ingest('6.000', 'GROSS')))).toBe('EBMR-CNT-057');
    expect(await codeOf(close(c, await ingest('1.000', 'TARE'), await ingest('6.000', 'GROSS', 'TEST-BAL-09')))).toBe('EBMR-CNT-056');
    expect((await sbx.db.app.query('select 1 from plant.container_close where container_id = $1', [c.container_id])).rowCount).toBe(0);
    const tare = await ingest('1.000', 'TARE');
    const gross = await ingest('6.000', 'GROSS');
    expect(await close(c, tare, gross)).toMatchObject({ state: 'CLOSED', basis: 'WEIGHED' });

    // INV-35: the person who opened and closed the container is involved in the batch; DI-25: the readings are in scope.
    const involved = (await sbx.db.app.query<{ p: string[] }>('select recipe.batch_involvement($1) as p', [runId])).rows[0]?.p ?? [];
    expect(involved).toContain(personaIn(sbx, 'operator1').personId);
    const scope = (await sbx.db.app.query<{ k: string[] }>('select array_agg(chain_key) as k from recipe.audit_review_scope_chains($1)', [runId])).rows[0]?.k ?? [];
    expect(scope).toEqual(expect.arrayContaining([`output_container:${c.container_id}`, `device_reading:${tare}`, `device_reading:${gross}`]));
  });
});
