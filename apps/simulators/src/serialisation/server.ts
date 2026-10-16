/**
 * The serialisation L3 stub's HTTP server (Phase 3 slice 4a; no third-party dependencies; default 127.0.0.1:4041).
 * The tablets server is its client:
 *
 *   POST /l3/v1/pools                     PoolRequest -> 201 PoolResponse (200 for a repeat of the same request)
 *   POST /l3/v1/pools/:poolId/events      SerialEventsRequest -> 200 {accepted}; refused whole: 404, 409, 422
 *   GET  /l3/v1/pools/:poolId/report      200 PoolReport
 *   POST /l3/v1/pools/:poolId/reject      {reason} -> 201 DecommissionTask (D-S4-3; 200 for a repeat)
 *   GET  /l3/v1/decommission-tasks        200 {tasks}
 *   GET  /l3/v1/pools                     200 {pools}: summaries (the console and the tests)
 *
 * Phase 6 slice 6c (the L3/L4 simulator; PR-42, D-P6c-1):
 *   GET  /l3/v1/feed?after=N&limit=M      200 {messages, head}: the L3 feed the eBMR's L3 adapter pulls
 *   GET  /l3/v1/heartbeat                 200 {head}; 503 while STALE_REPORT (or STALE_MIRROR) is on
 *   GET  /l3/v1/reconciliation?from&to    200 ReconciliationSubmission over [from, to) of source time
 *   GET  /l3/v1/serials/:serial           200 SerialQueryAnswer; 404 for an unknown serial
 *   POST /l3/v1/aggregations              {poolId, parentId, childCount, action?} -> 201, published as l3.aggregation
 *   POST /l3/v1/decommission-tasks/:id/done   -> 200 DecommissionTask DONE, published as l3.decommission_task
 *   POST /l3/v1/pools/:poolId/profile     {lot?, expiry?}: what the L3 profile carries for the pool's serials
 *
 * A refusal answers {error:{code, message}} (L3Error). Control for tests and the demo: POST /api/fault {fault, on}:
 * UNAVAILABLE makes every /l3 route answer 503; the L3 faults (model.ts L3_FAULTS) and the feed's content and delivery
 * faults (DUPLICATE, OUT_OF_ORDER, MALFORMED, WRONG_BATCH, STALE_VALUE) switch the same way; GET / is a plain-HTML
 * console. SIMULATOR, DEMO-ONLY.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PoolRequest, SerialEventsRequest } from '@ebmr/integration-sdk/serialisation';
import type { FeedFault } from '../system-feed/feed.ts';
import { L3_FAULTS, L3Refusal, L3Stub, type L3Fault, type L3StubOptions } from './model.ts';

/** The feed faults the L3 simulator switches as they are (the delivery of its feed). */
const L3_FEED_FAULTS = ['DUPLICATE', 'OUT_OF_ORDER', 'MALFORMED', 'WRONG_BATCH', 'STALE_VALUE'] as const;
const WHOLE = /^(0|[1-9][0-9]{0,17})$/;

export interface L3StubServerOptions extends L3StubOptions {
  http: { host: string; port: number };
}

export interface RunningL3Stub {
  stub: L3Stub;
  port: number;
  faults: Set<'UNAVAILABLE'>;
  close(): Promise<void>;
}

const BODY_LIMIT = 4 * 1024 * 1024;
const REASON = /^[\x20-\x7E]{1,500}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }): string => e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) throw new BadRequest('the body is too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new BadRequest('the body is not JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message: message.slice(0, 500) } });
}

export async function startL3Stub(opts: L3StubServerOptions): Promise<RunningL3Stub> {
  const stub = new L3Stub(opts);
  const faults = new Set<'UNAVAILABLE'>();

  function consoleHtml(): string {
    const rows = stub
      .summaries()
      .map((p) => `<tr><td>${esc(p.poolId)}</td><td>${esc(p.packagingOrder)}</td><td>${esc(p.market)}</td><td>${esc(p.report.counts.issued)}</td><td>${esc(p.report.counts.COMMISSIONED)}</td><td>${esc(p.report.unexplained)}</td><td>${p.rejected ? 'REJECTED' : ''}</td></tr>`)
      .join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="2"><title>L3 serialisation stub</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#fff;color:#111}.banner{background:#fde68a;padding:8px 12px;font-weight:700;border-radius:6px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;font-family:ui-monospace,monospace}</style></head>
<body><p class="banner">SIMULATOR (DEMO-ONLY): a stub of the site's L3 serialisation system.</p><h1>L3 serialisation stub</h1>
<p>${faults.has('UNAVAILABLE') ? 'UNAVAILABLE (answers 503)' : 'Available'}; ${stub.decommissionTasks().filter((t) => t.state === 'OPEN').length} decommissioning task(s) open; feed head ${esc(stub.feed.head().toString())}; faults on: ${esc([...stub.faults, ...stub.feed.faults].join(', ') || 'none')}.</p>
<table><thead><tr><th>Pool</th><th>Packaging order</th><th>Market</th><th>Issued</th><th>Commissioned</th><th>Unexplained</th><th></th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://l3');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(consoleHtml());
      return;
    }
    if (method === 'POST' && path === '/api/fault') {
      const body = await readJson(req);
      const fault = isRecord(body) ? body['fault'] : undefined;
      const on = isRecord(body) ? body['on'] : undefined;
      if (typeof on !== 'boolean' || typeof fault !== 'string') return refuse(res, 400, 'SCHEMA', `expected {fault: UNAVAILABLE|${L3_FAULTS.join('|')}|${L3_FEED_FAULTS.join('|')}, on}`);
      if (fault === 'UNAVAILABLE') {
        if (on) faults.add('UNAVAILABLE');
        else faults.delete('UNAVAILABLE');
      } else if ((L3_FAULTS as readonly string[]).includes(fault)) {
        stub.setFault(fault as L3Fault, on);
      } else if ((L3_FEED_FAULTS as readonly string[]).includes(fault)) {
        if (on) stub.feed.faults.add(fault as FeedFault);
        else stub.feed.faults.delete(fault as FeedFault);
      } else {
        return refuse(res, 400, 'SCHEMA', `unknown fault ${fault.slice(0, 40)}`);
      }
      return send(res, 200, { faults: [...faults, ...stub.faults, ...stub.feed.faults] });
    }
    if (!path.startsWith('/l3/v1/')) return refuse(res, 404, 'NOT_FOUND', 'not found');
    if (faults.has('UNAVAILABLE')) return refuse(res, 503, 'UNAVAILABLE', 'the L3 system is unavailable');

    if (method === 'POST' && path === '/l3/v1/pools') {
      const body = PoolRequest.safeParse(await readJson(req));
      if (!body.success) return refuse(res, 400, 'SCHEMA', issues(body.error));
      const before = stub.summaries().length;
      const pool = stub.issue(body.data);
      return send(res, stub.summaries().length > before ? 201 : 200, pool);
    }
    if (method === 'GET' && path === '/l3/v1/pools') return send(res, 200, { pools: stub.summaries() });
    if (method === 'GET' && path === '/l3/v1/feed') {
      const after = url.searchParams.get('after') ?? '0';
      const limit = url.searchParams.get('limit') ?? '100';
      if (!WHOLE.test(after) || !/^[1-9][0-9]{0,2}$/.test(limit)) return refuse(res, 400, 'SCHEMA', 'after is a whole number, limit 1 to 999');
      return send(res, 200, stub.feed.page(BigInt(after), Number(limit)));
    }
    if (method === 'GET' && path === '/l3/v1/heartbeat') {
      if (!stub.feed.heartbeatOk()) return refuse(res, 503, 'NO_HEARTBEAT', 'the L3 heartbeat has stopped');
      return send(res, 200, { head: stub.feed.head().toString() });
    }
    if (method === 'GET' && path === '/l3/v1/reconciliation') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!WHOLE.test(from) || !WHOLE.test(to) || BigInt(from) >= BigInt(to)) return refuse(res, 400, 'SCHEMA', 'from and to are epoch microseconds, from < to');
      return send(res, 200, stub.feed.reconciliation(BigInt(from), BigInt(to)));
    }
    if (method === 'POST' && path === '/l3/v1/aggregations') {
      const body = await readJson(req);
      if (!isRecord(body) || typeof body['poolId'] !== 'string' || typeof body['parentId'] !== 'string' || typeof body['childCount'] !== 'string'
          || (body['action'] !== undefined && body['action'] !== 'ADD' && body['action'] !== 'DELETE')) {
        return refuse(res, 400, 'SCHEMA', 'expected {poolId, parentId, childCount, action?}');
      }
      return send(res, 201, stub.aggregate({ poolId: body['poolId'], parentId: body['parentId'], childCount: body['childCount'], ...(body['action'] ? { action: body['action'] as 'ADD' | 'DELETE' } : {}) }));
    }
    const done = /^\/l3\/v1\/decommission-tasks\/([^/]+)\/done$/.exec(path);
    if (done && method === 'POST') return send(res, 200, stub.completeTask(decodeURIComponent(done[1] ?? '')));
    const serial = /^\/l3\/v1\/serials\/([^/]+)$/.exec(path);
    if (serial && method === 'GET') return send(res, 200, stub.query(decodeURIComponent(serial[1] ?? '')));
    if (method === 'GET' && path === '/l3/v1/decommission-tasks') return send(res, 200, { tasks: stub.decommissionTasks() });
    const m = /^\/l3\/v1\/pools\/([^/]+)\/(events|report|reject|profile)$/.exec(path);
    if (!m) return refuse(res, 404, 'NOT_FOUND', 'not found');
    const poolId = decodeURIComponent(m[1] ?? '');
    const what = m[2];
    if (what === 'report' && method === 'GET') return send(res, 200, stub.report(poolId));
    if (what === 'profile' && method === 'POST') {
      const body = await readJson(req);
      const lot = isRecord(body) ? body['lot'] : undefined;
      const expiry = isRecord(body) ? body['expiry'] : undefined;
      if ((lot !== undefined && (typeof lot !== 'string' || !/^[\x20-\x7E]{1,64}$/.test(lot))) || (expiry !== undefined && (typeof expiry !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(expiry)))) {
        return refuse(res, 400, 'SCHEMA', 'expected {lot?, expiry? (YYYY-MM)}');
      }
      stub.setProfile(poolId, { ...(lot ? { lot } : {}), ...(expiry ? { expiry } : {}) });
      return send(res, 200, { poolId });
    }
    if (what === 'events' && method === 'POST') {
      const body = SerialEventsRequest.safeParse(await readJson(req));
      if (!body.success) return refuse(res, 400, 'SCHEMA', issues(body.error));
      return send(res, 200, { accepted: stub.applyEvents(poolId, body.data.events).toString() });
    }
    if (what === 'reject' && method === 'POST') {
      const body = await readJson(req);
      const reason = isRecord(body) && Object.keys(body).length === 1 ? body['reason'] : undefined;
      if (typeof reason !== 'string' || !REASON.test(reason)) return refuse(res, 400, 'SCHEMA', 'expected {reason}');
      const before = stub.decommissionTasks().length;
      const task = stub.reject(poolId, reason);
      return send(res, stub.decommissionTasks().length > before ? 201 : 200, task);
    }
    return refuse(res, 405, 'METHOD', `${method} is not allowed on ${path}`);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof L3Refusal) return refuse(res, error.status, error.code, error.message);
      if (error instanceof BadRequest) return refuse(res, 400, 'SCHEMA', error.message);
      refuse(res, 500, 'INTERNAL', error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.http.port, opts.http.host, () => resolve());
  });
  const a = server.address();
  return {
    stub,
    port: a && typeof a === 'object' ? a.port : opts.http.port,
    faults,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
