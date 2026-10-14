/**
 * The HTTP server of the ERP and WMS simulators (Phase 6 slice 6a, builder A; no third-party dependencies). The eBMR's
 * ERP/WMS adapter worker is its client:
 *
 *   GET  /<erp|wms>/v1/feed?after=N&limit=M     200 {messages, head}: the envelopes after sequence N
 *   GET  /<erp|wms>/v1/heartbeat                200 {head}; 503 while STALE_MIRROR is on
 *   GET  /<erp|wms>/v1/reconciliation?from&to   200 ReconciliationSubmission over [from, to) of source time
 *   ...  the system's own routes (erp/model.ts, wms/model.ts)
 *
 * Control for tests and the demo: POST /api/fault {fault, on, slowMs?}; GET /api/state; GET / a plain-HTML console with
 * a button per fault. LINK_CUT and SLOW act on the feed and on the routes the adapter calls. SIMULATOR, DEMO-ONLY.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FEED_FAULTS, type ErpWmsFeed, type FeedFault } from './feed.ts';

const BODY_LIMIT = 1024 * 1024;

export class SimRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SimRoutes {
  /** 'erp' or 'wms'. */
  prefix: string;
  title: string;
  /** The system's own routes under /<prefix>/v1; undefined when the path is not one of them. `adapter` answers obey LINK_CUT and SLOW. */
  route(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; body: unknown; adapter?: boolean } | undefined;
  consoleRows(): [string, string][];
  state(): unknown;
}

export interface RunningErpWmsSimulator {
  feed: ErpWmsFeed;
  port: number;
  url: string;
  close(): Promise<void>;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0).toString()};`);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WHOLE = /^(0|[1-9][0-9]{0,17})$/;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) throw new SimRefusal(413, 'TOO_LARGE', 'the body is too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new SimRefusal(400, 'SCHEMA', 'the body is not JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startErpWmsSimulator(feed: ErpWmsFeed, routes: SimRoutes, http: { host: string; port: number }): Promise<RunningErpWmsSimulator> {
  const base = `/${routes.prefix}/v1`;

  /** An answer to the adapter with the delivery faults: late (SLOW) or cut off mid-transfer (LINK_CUT). */
  async function deliver(res: ServerResponse, status: number, body: unknown): Promise<void> {
    if (feed.faults.has('SLOW')) await sleep(feed.slowMs);
    const text = JSON.stringify(body);
    if (feed.faults.has('LINK_CUT')) {
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text).toString() });
      res.write(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
      res.socket?.destroy();
      return;
    }
    send(res, status, body);
  }

  function consoleHtml(): string {
    const rows: [string, string][] = [['Head (sequence)', feed.head().toString()], ['Faults on', [...feed.faults].join(', ') || 'none'], ...routes.consoleRows()];
    const table = rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    const buttons = FEED_FAULTS.map((f) => {
      const on = feed.faults.has(f);
      return `<li><button type="button" data-fault="${esc(f)}" data-on="${on ? 'false' : 'true'}">${on ? 'Switch off' : 'Switch on'}</button> ${esc(f)}: <strong>${on ? 'ON' : 'off'}</strong></li>`;
    }).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(routes.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#fff;color:#111}.banner{background:#fde68a;padding:8px 12px;font-weight:700;border-radius:6px}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;font-family:ui-monospace,monospace}button{min-height:44px;margin:4px}</style></head>
<body><p class="banner">SIMULATOR (DEMO-ONLY): ${esc(routes.title)}</p><h1>${esc(routes.title)}</h1>
<table>${table}</table><h2>Faults</h2><ul>${buttons}</ul>
<script>document.querySelectorAll('button[data-fault]').forEach(function(b){b.addEventListener('click',function(){fetch('/api/fault',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fault:b.dataset.fault,on:b.dataset.on==='true'})}).then(function(){location.reload()})})})</script>
</body></html>`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(consoleHtml());
      return;
    }
    if (method === 'GET' && path === '/api/state') return send(res, 200, { head: feed.head().toString(), faults: [...feed.faults], model: routes.state() });
    if (method === 'POST' && path === '/api/fault') {
      const body = await readJson(req);
      if (!isRecord(body) || !FEED_FAULTS.includes(body['fault'] as FeedFault) || typeof body['on'] !== 'boolean') {
        throw new SimRefusal(400, 'SCHEMA', `expected {fault: ${FEED_FAULTS.join('|')}, on: boolean, slowMs?}`);
      }
      if (body['on']) feed.faults.add(body['fault'] as FeedFault);
      else feed.faults.delete(body['fault'] as FeedFault);
      if (typeof body['slowMs'] === 'number' && Number.isInteger(body['slowMs']) && body['slowMs'] >= 0) feed.slowMs = body['slowMs'];
      return send(res, 200, { faults: [...feed.faults] });
    }
    if (!path.startsWith(`${base}/`)) throw new SimRefusal(404, 'NOT_FOUND', `no route ${method} ${path}`);
    const sub = path.slice(base.length);
    if (method === 'GET' && sub === '/feed') {
      const after = url.searchParams.get('after') ?? '0';
      const limit = url.searchParams.get('limit') ?? '100';
      if (!WHOLE.test(after) || !/^[1-9][0-9]{0,3}$/.test(limit)) throw new SimRefusal(400, 'SCHEMA', 'after is a sequence number and limit 1 to 9999');
      return deliver(res, 200, feed.page(BigInt(after), Number(limit)));
    }
    if (method === 'GET' && sub === '/heartbeat') {
      return feed.heartbeatOk() ? send(res, 200, { head: feed.head().toString() }) : send(res, 503, { error: { code: 'STALE_MIRROR', message: 'the synchronisation of the source stopped' } });
    }
    if (method === 'GET' && sub === '/reconciliation') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!WHOLE.test(from) || !WHOLE.test(to) || BigInt(from) >= BigInt(to)) throw new SimRefusal(400, 'SCHEMA', 'from < to, epoch microseconds');
      return deliver(res, 200, feed.reconciliation(BigInt(from), BigInt(to)));
    }
    const body = method === 'POST' ? await readJson(req) : undefined;
    const answer = routes.route(method, sub, url.searchParams, body);
    if (!answer) throw new SimRefusal(404, 'NOT_FOUND', `no route ${method} ${path}`);
    if (answer.adapter) return deliver(res, answer.status, answer.body);
    return send(res, answer.status, answer.body);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof SimRefusal) send(res, error.status, { error: { code: error.code, message: error.message } });
      else send(res, 500, { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(http.port, http.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : http.port;
  return {
    feed,
    port,
    url: `http://${http.host}:${port.toString()}${base}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** host:port from an environment value (loopback by default). */
export function address(value: string | undefined, fallback: string): { host: string; port: number } {
  const text = value && value !== '' ? value : fallback;
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  return { host: m[1] ?? '127.0.0.1', port: Number(m[2]) };
}
