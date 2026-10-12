/**
 * The weighed close of an output container (tablets 1111; DI-30 validated electronic means, DI-32, L-30): the net is the
 * gross minus the tare of two scale readings claimed for the close in the person's command, from a balance of the
 * session's room; such a close needs no second person. Proven as the application role, with bypass attempts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { codeOf } from '../execution/db-guards-support.ts';
import { dcMini, importAndIssue, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { enrol, fakeGateway, operatorActor, type FakeGateway } from '../devices/support.ts';

let sbx: ExecServer;
let gw: FakeGateway;
let runId: string;

async function ingest(value: string, purpose: 'TARE' | 'GROSS' = 'GROSS', unit = 'kg'): Promise<string> {
  const r = gw.next({ value, unit, purpose, raw: `S S ${value.padStart(10)} ${unit}` });
  const res = await gw.uplink([{ reading: r, delayUs: '1000' }]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return r.readingId;
}
async function asOperator<T>(text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await operatorActor(sbx, 'operator1'), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
const open = (unit = 'kg') => asOperator<{ container_id: string; version: number; label_code: string }>("select plant.open_container($1, 'GRANULATION', $2) as r", [runId, unit]);

beforeAll(async () => {
  sbx = await startExecServer();
  await enrol(sbx);
  gw = await fakeGateway(sbx);
  runId = await importAndIssue(sbx, await sbx.asPersona('issuer'), writePackage(sbx, dcMini()));
}, 300_000);
afterAll(async () => {
  await gw?.close();
  await sbx?.close();
});

describe('weighed close of an output container (tablets 1111)', () => {
  it('[DI-30][DI-32][L-30] the net is the claimed gross minus the claimed tare in the container\'s unit; the container is usable with no second person', async () => {
    const c = await open();
    const tare = await ingest('1.250', 'TARE');
    const gross = await ingest('13.875');
    const r = await asOperator<{ state: string; basis: string }>('select tab.close_container_weighed($1, $2, $3, $4) as r', [c.container_id, tare, gross, c.version]);
    expect(r).toMatchObject({ state: 'CLOSED', basis: 'WEIGHED' });
    const { rows } = await sbx.db.app.query<{ net: string; basis: string; tare: string; gross: string }>(
      "select net_quantity::text as net, basis, weighing -> 'tare' ->> 'readingId' as tare, weighing -> 'gross' ->> 'readingId' as gross from plant.container_close where container_id = $1",
      [c.container_id],
    );
    expect(rows).toEqual([{ net: '12.625', basis: 'WEIGHED', tare, gross }]);
    expect(await sbx.db.app.query<{ p: string | null }>('select plant.container_usable_problem($1) as p', [c.container_id]).then((x) => x.rows[0]?.p)).toBeNull();
    const uses = await sbx.db.app.query<{ purpose: string }>('select purpose from tab.reading_use where reading_id = any($1::uuid[]) order by purpose', [[tare, gross]]);
    expect(uses.rows.map((u) => u.purpose)).toEqual(['GROSS', 'TARE']);
  });

  it('[DI-30][DI-32] refused: readings used before, a gross not above its tare, a container counted in units, a missing reading; nothing is closed', async () => {
    const c = await open();
    const tare = await ingest('1.000', 'TARE');
    const gross = await ingest('5.000');
    await asOperator('select tab.close_container_weighed($1, $2, $3, $4) as r', [c.container_id, tare, gross, c.version]);
    const again = await open();
    expect(await codeOf(asOperator('select tab.close_container_weighed($1, $2, $3, $4) as r', [again.container_id, tare, gross, again.version]))).toBe('EBMR-DEV-105');
    expect(await codeOf(asOperator('select tab.close_container_weighed($1, $2, $3, $4) as r', [again.container_id, await ingest('2.000', 'TARE'), await ingest('2.000'), again.version]))).toBe('EBMR-CNT-055');
    expect(await codeOf(asOperator('select tab.close_container_weighed($1, $2, $3, $4) as r', [again.container_id, null, await ingest('2.000'), again.version]))).toBe('EBMR-CNT-054');
    const counted = await open('units');
    expect(await codeOf(asOperator('select tab.close_container_weighed($1, $2, $3, $4) as r', [counted.container_id, await ingest('1.000', 'TARE'), await ingest('3.000'), counted.version]))).toBe('EBMR-CNT-054');
    const closed = await sbx.db.app.query('select 1 from plant.container_close where container_id = any($1::uuid[])', [[again.container_id, counted.container_id]]);
    expect(closed.rowCount).toBe(0);
  });

  it('[DI-30] bypass: the application role cannot call the internal close with a forged weighing, nor write the close itself', async () => {
    const c = await open();
    await expect(sbx.db.app.query("select plant.container_close_record($1, 1, $2, 'WEIGHED', '{}'::jsonb, '{}'::jsonb)", [c.container_id, c.version])).rejects.toThrow(/permission denied/);
    await expect(
      sbx.db.app.query("insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) values ($1, 1, gen_random_uuid(), gen_random_uuid(), 'WEIGHED', '{}')", [c.container_id]),
    ).rejects.toThrow(/permission denied/);
  });
});
