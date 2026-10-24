/**
 * "Send a production order" (Phase 7 slice 7k; requirement R5 of the hosted-demo trials; DEMO-ONLY): the ERP simulator's
 * one order of a demo product, posted to this demo GMP installation as the ERP interface, under a new order number. It
 * replaces the hosted demo's post-demo-order script. The act is recorded first (tab.record_demo_act, tablets 1571:
 * refused on a GMP installation that is not a demo one, EBMR-OPS-010, then PLATFORM.OPERATE); the order then goes through
 * the ERP's own login (its DEMO-ONLY service key from the set-up's seed file in the keys directory) and the database's
 * site.erp_receive_order, exactly as the ERP import route takes one. Nothing is posted when the act is refused.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoOrderTemplateView, SentOrderView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { DEMO_ORDER_TEMPLATES, demoOrder, type DemoOrderKind, type DemoOrderTemplate } from '../execution/seed-demo-orders.ts';
import { asErp } from '../quality/index.ts';

/**
 * Slice 7o (decision (d) of the lead; R4, R8): besides the demo products, an order of every product whose current master
 * version is APPROVED and holds an ACTIVE market authorisation (a company's own product made on screen), for the
 * family's first approved batch size, its BOM the master's own scaled from the master's reference size in exact decimals
 * (the database compares them at planning, recipe-core 0602). Read from the database each time; a demo template wins.
 */
export async function authorisedTemplates(app: AppContext): Promise<DemoOrderTemplate[]> {
  const { rows } = await app.pools.app.query<{ product_code: string; strength: string; product_name: string; kind: DemoOrderKind; size: string; unit: string; bom: { materialCode: string; quantity: string; unit: string }[] | null }>(
    `select f.product_code, f.strength, f.product_name, f.record_kind as kind, f.batch_sizes -> 0 -> 'quantity' ->> 'value' as size, f.batch_sizes -> 0 -> 'quantity' ->> 'unit' as unit,
            (select jsonb_agg(jsonb_build_object('materialCode', b ->> 'material',
                     'quantity', trim_scale((b -> 'quantity' ->> 'value')::numeric * (f.batch_sizes -> 0 -> 'quantity' ->> 'value')::numeric
                                            / (c.content -> 'header' -> 'batchSizes' -> 0 -> 'quantity' ->> 'value')::numeric)::text,
                     'unit', b -> 'quantity' ->> 'unit') order by b ->> 'material')
               from jsonb_array_elements(case when jsonb_typeof(c.content -> 'bom') = 'array' then c.content -> 'bom' else '[]'::jsonb end) b) as bom
       from recipe.mbr_family f
       join recipe.mbr_version v on v.family_id = f.id and recipe.version_state(v.id) = 'APPROVED'
       join lateral (select mc.content from recipe.mbr_content mc where mc.version_id = v.id order by mc.revision desc limit 1) c on true
      where f.edition = 'tablets'
        and exists (select 1 from recipe.market_authorisation a where a.version_id = v.id and recipe.market_authorisation_state(a.id) = 'ACTIVE')
        and (c.content -> 'header' -> 'batchSizes' -> 0 -> 'quantity' ->> 'value') ~ '^[0-9]+(\\.[0-9]+)?$'
        and (c.content -> 'header' -> 'batchSizes' -> 0 -> 'quantity' ->> 'value')::numeric > 0
      order by f.product_code, f.record_kind`,
  );
  const out: DemoOrderTemplate[] = [];
  for (const r of rows) {
    if (DEMO_ORDER_TEMPLATES.some((t) => t.productCode === r.product_code && t.kind === r.kind)) continue;
    if (out.some((t) => t.productCode === r.product_code && t.kind === r.kind)) continue;
    out.push({ productCode: r.product_code, strength: r.strength, productName: r.product_name, kind: r.kind, batchSize: r.size, batchSizeUnit: r.unit, bom: r.bom ?? [] });
  }
  return out;
}

async function allTemplates(app: AppContext): Promise<DemoOrderTemplate[]> {
  return [...DEMO_ORDER_TEMPLATES, ...(await authorisedTemplates(app))];
}

/** The templates "Send a production order" offers. */
export async function orderTemplates(app: AppContext): Promise<DemoOrderTemplateView[]> {
  return (await allTemplates(app)).map((t) => ({ productCode: t.productCode, productName: t.productName, kind: t.kind, batchSize: t.batchSize, batchSizeUnit: t.batchSizeUnit }));
}

const notConfigured = (why: string) =>
  refusal(409, {
    code: 'ERP_SIMULATOR_NOT_CONFIGURED',
    kind: 'NOT_ALLOWED',
    whatHappened: 'The production order was not sent.',
    why,
    whatYouCanDo: ['Set the demo up again (pnpm demo:setup, or Demo data on this screen): it writes the ERP interface\'s DEMO-ONLY key into the keys directory.'],
    whoCanHelp: ['The system administrator'],
  });

/** The ERP interface's DEMO-ONLY login from the set-up's seed file (`<keys directory>/gmp-seed.json`). */
function erpLogin(app: AppContext): { loginName: string; serviceKey: string; fingerprint: string } {
  const dir = app.config.keysDir;
  const file = dir ? join(dir, 'gmp-seed.json') : null;
  if (!file || !existsSync(file)) throw notConfigured('This server has no seed file of the demo set-up in its keys directory (EBMR_KEYS_DIR or EBMR_DEMO_KEYS_FILE).');
  const seed = JSON.parse(readFileSync(file, 'utf8')) as { services?: { key: string; loginName: string; serviceKey: string; terminal: string }[]; terminals?: { code: string; fingerprint: string }[] };
  const erp = seed.services?.find((s) => s.key === 'erpInterface');
  const terminal = erp ? seed.terminals?.find((t) => t.code === erp.terminal) : undefined;
  if (!erp || !terminal) throw notConfigured('The seed file of the demo set-up names no ERP interface.');
  return { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminal.fingerprint };
}

export interface PreparedOrder {
  view: SentOrderView;
  order: Record<string, unknown>;
  login: { loginName: string; serviceKey: string; fingerprint: string };
}

/**
 * The order to send for `productCode` and `kind`, and the ERP's login, checked before anything is recorded (an unknown
 * template or a server without the demo set-up's seed file is refused first). The order number follows the request's
 * idempotency key, so a resend names the same order.
 */
export async function prepareProductionOrder(app: AppContext, productCode: string, kind: DemoOrderKind, idempotencyKey: string | null): Promise<PreparedOrder> {
  const t = (await allTemplates(app)).find((x) => x.productCode === productCode && x.kind === kind);
  if (!t) {
    throw refusal(422, {
      code: 'ERP_ORDER_UNKNOWN',
      kind: 'INVALID_INPUT',
      whatHappened: 'The production order was not sent.',
      why: `The ERP simulator has no ${kind.toLowerCase()} order of product ${productCode}.`,
      whatYouCanDo: ['Choose one of the orders the screen offers.'],
    });
  }
  const login = erpLogin(app);
  const tail = idempotencyKey ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 8) : randomUUID().slice(0, 8);
  const orderNo = `PO-SIM-${tail.toUpperCase()}`;
  return { view: { orderNo, productCode: t.productCode, kind: t.kind, batchSize: t.batchSize, batchSizeUnit: t.batchSizeUnit }, order: demoOrder(t, orderNo), login };
}

/** Posts a prepared order as the ERP interface (site.erp_receive_order, the ERP import route's own path). */
export async function postProductionOrder(app: AppContext, p: PreparedOrder): Promise<SentOrderView> {
  await asErp(app, p.login, (c) => c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(p.order)]));
  return p.view;
}
