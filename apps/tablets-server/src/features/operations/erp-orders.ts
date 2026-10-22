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
import { DEMO_ORDER_TEMPLATES, demoOrder, type DemoOrderKind } from '../execution/seed-demo-orders.ts';
import { asErp } from '../quality/index.ts';

/** The templates "Send a production order" offers. */
export function orderTemplates(): DemoOrderTemplateView[] {
  return DEMO_ORDER_TEMPLATES.map((t) => ({ productCode: t.productCode, productName: t.productName, kind: t.kind, batchSize: t.batchSize, batchSizeUnit: t.batchSizeUnit }));
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
export function prepareProductionOrder(app: AppContext, productCode: string, kind: DemoOrderKind, idempotencyKey: string | null): PreparedOrder {
  const t = DEMO_ORDER_TEMPLATES.find((x) => x.productCode === productCode && x.kind === kind);
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
