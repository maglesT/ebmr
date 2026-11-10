/**
 * R5 (Phase 7 slice 7k): "Send a production order" on the simulators' console posts one order of a demo product to a demo
 * GMP installation as the ERP interface (its DEMO-ONLY login from the set-up's seed file in the keys directory), each a
 * recorded demo act; a resend of the same request names the same order and posts nothing again; an installation that is
 * not a demo one refuses it in the database before anything is posted. N-2: the order's own refusal by the database after
 * the demo act committed is a refusal (4xx naming why), not SAVED_NOT_SHOWN (platform/db/commands.ts withScopedCommand).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { prepareProductionOrder } from '../../src/features/operations/erp-orders.ts';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const O = routes.operations;
const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** A demo GMP server whose keys directory holds its set-up's seed file (as pnpm demo:setup writes it). */
async function demoServer(withSeed: boolean): Promise<TestServer> {
  const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-7k-keys-'));
  const s = await startServer('GMP', { demoMarker: true, env: { EBMR_KEYS_DIR: keysDir, EBMR_DEMO: '1' } });
  servers.push(s);
  if (withSeed) writeFileSync(join(keysDir, 'gmp-seed.json'), JSON.stringify(s.seed));
  return s;
}

const ordersOf = async (s: TestServer, orderNo: string): Promise<{ product: string; size: string; unit: string }[]> =>
  (await s.db.admin.query<{ product: string; size: string; unit: string }>('select product_code as product, batch_size::text as size, batch_size_unit as unit from site.erp_production_order where order_no = $1', [orderNo])).rows;

describe('R5: the ERP simulator sends a production order to a demo GMP installation', () => {
  it('[DI-05][DI-17] the administrator sends a processing order of a demo product: posted as the ERP interface under a new number, the act recorded; a resend names the same order and posts nothing again', async () => {
    const s = await demoServer(true);
    const admin = await loginOf(s, await grantedPerson(s, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    const view = valueOf(await admin.call(O.simulators));
    expect(view.orderTemplates?.map((t) => `${t.productCode}:${t.kind}`)).toEqual(['PCM500:PROCESSING', 'GBT01-250:PROCESSING', 'GBT02-100:PROCESSING', 'GBT02-100:PACKAGING']);
    const key = randomUUID();
    const body = { productCode: 'GBT02-100', kind: 'PACKAGING' as const, reason: 'a second bottle order for the demo' };
    const sent = valueOf(await admin.call(O.sendProductionOrder, { body, idempotencyKey: key }));
    expect(sent).toMatchObject({ productCode: 'GBT02-100', kind: 'PACKAGING', batchSize: '3000', batchSizeUnit: '{tbl}' });
    expect(sent.orderNo).toMatch(/^PO-SIM-[0-9A-F]{8}$/);
    expect(await ordersOf(s, sent.orderNo)).toEqual([{ product: 'GBT02-100', size: '3000', unit: '{tbl}' }]);
    expect(valueOf(await admin.call(O.sendProductionOrder, { body, idempotencyKey: key })).orderNo).toBe(sent.orderNo);
    expect(await ordersOf(s, sent.orderNo)).toHaveLength(1);
    const other = valueOf(await admin.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PROCESSING', reason: 'another batch' } }));
    expect(other.orderNo).not.toBe(sent.orderNo);
    expect(await ordersOf(s, other.orderNo)).toEqual([{ product: 'PCM500', size: '60.000', unit: 'kg' }]);
    const acts = (await s.db.admin.query<{ act: string; target: string; by: string }>('select act, target, person_id::text as by from tab.demo_act order by recorded_at, id')).rows;
    expect(acts.map((a) => `${a.act} ${a.target}`)).toEqual(['ERP_ORDER_SENT GBT02-100:PACKAGING', 'ERP_ORDER_SENT PCM500:PROCESSING']);
    // A product or kind the simulator has no order of is refused, and so is another role (PLATFORM.OPERATE).
    expect(refusalOf(await admin.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PACKAGING', reason: 'x' } }))).toMatchObject({ status: 422, code: 'ERP_ORDER_UNKNOWN' });
    const qa = await s.asPersona('approver');
    expect(refusalOf(await qa.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PROCESSING', reason: 'x' } }))?.code).toBe('EBMR-IAM-040');
  }, 180_000);


  it('[DI-05] without the demo set-up\'s seed file the server says so and records nothing; a GMP installation that is not a demo one refuses it in the database', async () => {
    const bare = await demoServer(false);
    const admin = await loginOf(bare, await grantedPerson(bare, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    expect(refusalOf(await admin.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PROCESSING', reason: 'x' } }))).toMatchObject({ status: 409, code: 'ERP_SIMULATOR_NOT_CONFIGURED' });
    expect((await bare.db.admin.query('select 1 from tab.demo_act')).rowCount).toBe(0);
    const gmp = await startServer('GMP');
    servers.push(gmp);
    const gmpAdmin = await loginOf(gmp, await grantedPerson(gmp, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    expect(valueOf(await gmpAdmin.call(O.simulators)).orderTemplates).toBeUndefined();
    expect(refusalOf(await gmpAdmin.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PROCESSING', reason: 'x' } }))).toMatchObject({ status: 403, code: 'EBMR-OPS-010' });
  }, 180_000);
});

describe('N-2 (owner retest, 10 November 2026): an order the database refuses', () => {
  const refuseOrders = async (s: TestServer, after: number): Promise<void> => {
    // A test-only trigger stands in for the database's refusal of the owner's order (EBMR-SITE-176). The sequence is not
    // rolled back, so `after` lets that many inserts through first (the check's own, rolled back).
    await s.db.admin.query('create sequence public.n2_orders');
    await s.db.admin.query(`create function public.n2_refuse_order() returns trigger language plpgsql security definer as $f$
      begin
        if nextval('public.n2_orders') > ${after} then
          raise exception using errcode = 'P0001', message = 'EBMR-SITE-176 a material appears once in the BOM of an order (D-S5-4)';
        end if;
        return new;
      end $f$`);
    await s.db.admin.query('create trigger n2_refuse_order before insert on site.erp_production_order for each row execute function public.n2_refuse_order()');
  };
  const acts = async (s: TestServer): Promise<number> => (await s.db.admin.query('select 1 from tab.demo_act')).rowCount ?? 0;

  it('[DI-05] an order the database refuses is refused before the demo act is recorded: 422 naming the database\'s reason, nothing saved', async () => {
    const s = await demoServer(true);
    const admin = await loginOf(s, await grantedPerson(s, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    await refuseOrders(s, 0);
    const key = randomUUID();
    const first = await prepareProductionOrder(s.built.ctx, 'PCM500', 'PROCESSING', key);
    const r = refusalOf(await admin.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PROCESSING', reason: 'a refused order' }, idempotencyKey: key }));
    expect(r).toMatchObject({ status: 422, code: 'ERP_ORDER_REFUSED', whatHappened: 'The production order was not sent; nothing was saved.' });
    expect(r?.why).toContain('EBMR-SITE-176');
    expect(r?.why).toContain('a material appears once in the BOM of an order');
    expect(JSON.stringify(r)).not.toContain('Saved; the result could not be shown');
    expect(await ordersOf(s, first.view.orderNo)).toHaveLength(0);
    expect(await acts(s)).toBe(0);
  }, 180_000);

  it('[DI-05] a refusal after an earlier part of the request committed says the earlier part was saved and this part refused, never "nothing was saved"', async () => {
    const s = await demoServer(true);
    const admin = await loginOf(s, await grantedPerson(s, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    await refuseOrders(s, 1);
    const key = randomUUID();
    const first = await prepareProductionOrder(s.built.ctx, 'PCM500', 'PROCESSING', key);
    const r = refusalOf(await admin.call(O.sendProductionOrder, { body: { productCode: 'PCM500', kind: 'PROCESSING', reason: 'refused after the act' }, idempotencyKey: key }));
    expect(r).toMatchObject({ status: 422, code: 'EBMR-SITE-176' });
    expect(r?.whatHappened).toMatch(/^Part of this request was saved before this part was refused; the refused part was not saved\./);
    expect(r?.why).toContain('a material appears once in the BOM of an order');
    expect(JSON.stringify(r)).not.toMatch(/Saved; the result could not be shown|Nothing was saved/);
    expect(await ordersOf(s, first.view.orderNo)).toHaveLength(0);
    expect(await acts(s)).toBe(1);
  }, 180_000);
});

describe('R3.13: the DEMO-ONLY credential card on the operations screen', () => {
  it('[DI-05][DI-14] a demo installation shows its set-up\'s administrators (this set-up\'s passwords) and every demo persona with how and where they sign in; any other installation refuses it', async () => {
    const s = await demoServer(true);
    const reader = await s.asPersona('operator1');
    const card = valueOf(await reader.call(O.credentialCard));
    expect(card.installation).toBe('GMP');
    expect(card.entries.filter((e) => e.bootstrap).map((e) => [e.loginName, e.password])).toEqual([
      [s.seed.bootstrap.admin.loginName, s.seed.bootstrap.admin.password],
      [s.seed.bootstrap.owner.loginName, s.seed.bootstrap.owner.password],
    ]);
    const personas = s.seed.personas.filter((p) => p.set === 0);
    expect(card.entries.filter((e) => !e.bootstrap).map((e) => e.loginName)).toEqual(personas.map((p) => p.loginName));
    for (const p of personas) {
      const e = card.entries.find((x) => x.loginName === p.loginName);
      expect(e).toMatchObject(
        p.kiosk ? { method: 'BADGE_PIN', badgeUid: p.badgeUid, pin: p.pin, password: null, terminal: p.homeTerminal } : { method: 'PASSWORD', password: p.password, badgeUid: null, terminal: p.homeTerminal },
      );
    }
    const gmp = await startServer('GMP');
    servers.push(gmp);
    expect(refusalOf(await (await gmp.asPersona('operator1')).call(O.credentialCard))).toMatchObject({ status: 403, code: 'DEMO_ONLY' });
    const sbx = await startServer('SANDBOX');
    servers.push(sbx);
    expect(refusalOf(await (await sbx.asPersona('operator1')).call(O.credentialCard))).toMatchObject({ status: 403, code: 'DEMO_ONLY' });
  }, 180_000);
});
