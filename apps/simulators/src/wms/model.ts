/**
 * The WMS simulator's routes (Phase 6 slice 6a, builder A; ERP_WMS contract; PR-17, PR-46): goods receipts with their
 * supplier batches, stock moves and lot statuses are published on the WMS feed (each body checked with the contract's
 * payload schema). Before a move the WMS asks the eBMR (a move request the adapter answers with the location rule); a
 * move allowed is made and published; a move posted straight to /stock-moves is one the WMS made without asking (the
 * eBMR then raises its alarm and exception, D-P6a-7). SIMULATOR, DEMO-ONLY.
 *
 *   POST /wms/v1/goods-receipts | /stock-moves | /lot-statuses      201 {sequenceNo, idempotencyKey}
 *   POST /wms/v1/move-requests {lotNumber, fromLocation, toLocation, toLocationKind, quantity}   201 {requestId}
 *   GET  /wms/v1/move-requests                                       {requests: open questions} (the adapter)
 *   POST /wms/v1/move-requests/<id>/answer {allowed, problem}        the eBMR's answer (the adapter)
 *   GET  /wms/v1/move-requests/<id>                                  the question and its answer
 */
import { randomUUID } from 'node:crypto';
import { publisher } from '../erp/model.ts';
import type { ErpWmsFeed } from '../erp/feed.ts';
import type { SimRoutes } from '../erp/server.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS = ['QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS'];

export interface MoveRequest {
  requestId: string;
  lotNumber: string;
  fromLocation: string;
  toLocation: string;
  toLocationKind: string;
  quantity: { value: string; unit: string };
  state: 'OPEN' | 'MOVED' | 'REFUSED';
  problem: string | null;
}

export function wmsRoutes(feed: ErpWmsFeed): SimRoutes & { moves: MoveRequest[] } {
  const moves: MoveRequest[] = [];
  const publish: Record<string, (body: unknown) => { status: number; body: unknown }> = {
    '/goods-receipts': publisher(feed, 'wms.goods_receipt', (p) => String(p['deliveryId'])),
    '/stock-moves': publisher(feed, 'wms.stock_move', (p) => String(p['lotNumber'])),
    '/lot-statuses': publisher(feed, 'wms.lot_status', (p) => String(p['lotNumber'])),
  };
  const moveNow = publisher(feed, 'wms.stock_move', (p) => String(p['lotNumber']));
  return {
    prefix: 'wms',
    title: 'WMS simulator (ERP_WMS feed and move questions)',
    moves,
    route(method, path, _query, body) {
      const p = publish[path];
      if (p && method === 'POST') return p(body);
      if (path === '/move-requests' && method === 'POST') {
        const q = isRecord(body) ? body : {};
        const quantity = isRecord(q['quantity']) ? q['quantity'] : {};
        if (typeof q['lotNumber'] !== 'string' || typeof q['fromLocation'] !== 'string' || typeof q['toLocation'] !== 'string'
            || typeof q['toLocationKind'] !== 'string' || !KINDS.includes(q['toLocationKind']) || typeof quantity['value'] !== 'string' || typeof quantity['unit'] !== 'string') {
          return { status: 400, body: { error: { code: 'SCHEMA', message: `expected {lotNumber, fromLocation, toLocation, toLocationKind (${KINDS.join('|')}), quantity {value, unit}}` } } };
        }
        const m: MoveRequest = {
          requestId: randomUUID(), lotNumber: q['lotNumber'], fromLocation: q['fromLocation'], toLocation: q['toLocation'], toLocationKind: q['toLocationKind'],
          quantity: { value: quantity['value'], unit: quantity['unit'] }, state: 'OPEN', problem: null,
        };
        moves.push(m);
        return { status: 201, body: { requestId: m.requestId } };
      }
      if (path === '/move-requests' && method === 'GET') {
        return { status: 200, body: { requests: moves.filter((m) => m.state === 'OPEN').map((m) => ({ requestId: m.requestId, lotNumber: m.lotNumber, toLocationKind: m.toLocationKind })) }, adapter: true };
      }
      const one = /^\/move-requests\/([0-9a-f-]{36})(\/answer)?$/.exec(path);
      const m = one ? moves.find((x) => x.requestId === one[1]) : undefined;
      if (one && !m) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such move request' } } };
      if (m && !one?.[2] && method === 'GET') return { status: 200, body: m };
      if (m && one?.[2] && method === 'POST') {
        if (!isRecord(body) || typeof body['allowed'] !== 'boolean') return { status: 400, body: { error: { code: 'SCHEMA', message: 'expected {allowed, problem}' } }, adapter: true };
        if (m.state === 'OPEN') {
          if (body['allowed']) {
            const r = moveNow({ lotNumber: m.lotNumber, fromLocation: m.fromLocation, toLocation: m.toLocation, toLocationKind: m.toLocationKind, quantity: m.quantity, movedAt: (BigInt(Date.now()) * 1000n).toString() });
            if (r.status !== 201) return { ...r, adapter: true };
            m.state = 'MOVED';
          } else {
            m.state = 'REFUSED';
            m.problem = typeof body['problem'] === 'string' ? body['problem'] : 'refused by the eBMR';
          }
        }
        return { status: 200, body: { state: m.state }, adapter: true };
      }
      return undefined;
    },
    consoleRows: () => [
      ['Messages published', feed.head().toString()],
      ['Move questions open', moves.filter((m) => m.state === 'OPEN').length.toString()],
      ['Moves refused by the eBMR', moves.filter((m) => m.state === 'REFUSED').length.toString()],
    ],
    state: () => ({ moves }),
  };
}
