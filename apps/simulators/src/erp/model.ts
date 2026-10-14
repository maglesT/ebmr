/**
 * The ERP simulator's routes (Phase 6 slice 6a, builder A; ERP_WMS contract): the ERP publishes production orders with
 * their BOM, material and product masters and shipments on its feed (each body checked with the contract's payload
 * schema), and receives the eBMR's outbound messages (stock blocks, lot statuses, goods issues, yields), de-duplicated
 * by message id. SIMULATOR, DEMO-ONLY.
 *
 *   POST /erp/v1/production-orders | /materials | /products | /shipments   201 {sequenceNo, idempotencyKey}
 *   POST /erp/v1/outbound {messageId, topic, payload}   200 {erpReference} (the adapter's delivery; LINK_CUT and SLOW apply)
 *   GET  /erp/v1/outbound                               the messages received, in order
 */
import { randomUUID } from 'node:crypto';
import { ERP_WMS } from '@ebmr/integration-sdk/adapter';
import type { ErpWmsFeed } from './feed.ts';
import type { SimRoutes } from './server.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ReceivedOutbound {
  messageId: string;
  topic: string;
  payload: Record<string, unknown>;
  erpReference: string;
  /** How many times the eBMR sent it (redeliveries are acknowledged with the same reference). */
  deliveries: number;
}

/** A publish route checked with the contract: 201 with the envelope's numbers, or 400 naming what is wrong. */
export function publisher(feed: ErpWmsFeed, messageType: string, recordId: (p: Record<string, unknown>) => string) {
  return (body: unknown): { status: number; body: unknown } => {
    const schema = ERP_WMS.inbound[messageType]?.versions['1'];
    const parsed = schema?.safeParse(body);
    if (!parsed?.success) {
      return { status: 400, body: { error: { code: 'SCHEMA', message: parsed ? parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ') : 'unknown type' } } };
    }
    const payload = parsed.data as Record<string, unknown>;
    const env = feed.publish(messageType, recordId(payload), payload);
    return { status: 201, body: { sequenceNo: env.sequenceNo, idempotencyKey: env.idempotencyKey } };
  };
}

export function erpRoutes(feed: ErpWmsFeed): SimRoutes & { outbound: ReceivedOutbound[] } {
  const outbound: ReceivedOutbound[] = [];
  const publish: Record<string, (body: unknown) => { status: number; body: unknown }> = {
    '/production-orders': publisher(feed, 'erp.production_order', (p) => String(p['orderNumber'])),
    '/materials': publisher(feed, 'erp.material_master', (p) => String(p['materialCode'])),
    '/products': publisher(feed, 'erp.product_master', (p) => `${String(p['productCode'])}|${String(p['strength'])}`),
    '/shipments': publisher(feed, 'erp.shipment', (p) => String(p['shipmentId'])),
  };
  return {
    prefix: 'erp',
    title: 'ERP simulator (ERP_WMS feed and outbound)',
    outbound,
    route(method, path, _query, body) {
      const p = publish[path];
      if (p && method === 'POST') return p(body);
      if (path === '/outbound' && method === 'GET') return { status: 200, body: { received: outbound } };
      if (path === '/outbound' && method === 'POST') {
        if (!isRecord(body) || typeof body['messageId'] !== 'string' || typeof body['topic'] !== 'string' || !isRecord(body['payload'])
            || !ERP_WMS.outbound.includes(body['topic'])) {
          return { status: 400, body: { error: { code: 'SCHEMA', message: `expected {messageId, topic (${ERP_WMS.outbound.join('|')}), payload}` } }, adapter: true };
        }
        const seen = outbound.find((o) => o.messageId === body['messageId']);
        if (seen) {
          seen.deliveries += 1;
          return { status: 200, body: { erpReference: seen.erpReference }, adapter: true };
        }
        const entry: ReceivedOutbound = { messageId: body['messageId'], topic: body['topic'], payload: body['payload'], erpReference: `ERP-${randomUUID().slice(0, 8).toUpperCase()}`, deliveries: 1 };
        outbound.push(entry);
        return { status: 200, body: { erpReference: entry.erpReference }, adapter: true };
      }
      return undefined;
    },
    consoleRows: () => [
      ['Messages published', feed.head().toString()],
      ['Outbound messages received', outbound.length.toString()],
      ['Stock blocks received', outbound.filter((o) => o.topic === 'erp.stock_block').length.toString()],
    ],
    state: () => ({ outbound }),
  };
}
