/**
 * The HTTP server of a feed simulator (QMS, LIMS, LMS, CMMS; Phase 6 slice 6a, builder B; no third-party dependencies).
 * The eBMR adapter worker is its client:
 *
 *   GET  /<sys>/v1/feed?after=N&limit=M     200 {messages, head}: the envelopes after sequence N (FeedPage)
 *   GET  /<sys>/v1/heartbeat                200 {head, atUs}; 503 while STALE_MIRROR is on
 *   GET  /<sys>/v1/reconciliation?from&to   200 ReconciliationSubmission over [from, to) of source time
 *   ...  the system's own routes (its plugin)
 *
 * Control for tests and the demo: POST /api/fault {fault, on, slowMs?}; GET /api/state; GET / a plain-HTML console.
 * LINK_CUT and SLOW act on the feed and on the system's read routes (a cut or a late answer). SIMULATOR, DEMO-ONLY.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FEED_FAULTS, type FeedFault, type SystemFeed } from './feed.ts';

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

export interface FeedPlugin {
  /** The path prefix, e.g. 'qms'. */
  prefix: string;
  title: string;
  /** The system's own routes; undefined when the path is not one of them. `read` routes obey LINK_CUT and SLOW. */
  route(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; body: unknown; read?: boolean } | undefined;
  /** Rows for the console: [label, value]. */
  consoleRows(): [string, string][];
  /** The model's state for GET /api/state. */
  state(): unknown;
}

export interface RunningFeedSimulator {
  feed: SystemFeed;
  port: number;
  close(): Promise<void>;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WHOLE = /^(0|[1-9][0-9]{0,17})$/;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startFeedSimulator(feed: SystemFeed, plugin: FeedPlugin, http: { host: string; port: number }): Promise<RunningFeedSimulator> {
  const base = `/${plugin.prefix}/v1`;

  /** A read answer with the delivery faults: late (SLOW) or cut off mid-transfer (LINK_CUT). */
  async function deliver(res: ServerResponse, body: unknown): Promise<void> {
    if (feed.faults.has('SLOW')) await sleep(feed.slowMs);
    const text = JSON.stringify(body);
    if (feed.faults.has('LINK_CUT')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text).toString() });
      res.write(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(text);
  }

  function consoleHtml(): string {
    const rows: [string, string][] = [['Head (sequence)', feed.head().toString()], ['Faults on', [...feed.faults].join(', ') || 'none'], ...plugin.consoleRows()];
    const html = rows
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
      .join('');
    const buttons = FEED_FAULTS.map((f) => `<li>${esc(f)}: ${feed.faults.has(f) ? 'ON' : 'off'}</li>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="2"><title>${esc(plugin.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#fff;color:#111}.banner{background:#fde68a;padding:8px 12px;font-weight:700;border-radius:6px}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;font-family:ui-monospace,monospace}</style></head>
<body><p class="banner">SIMULATOR (DEMO-ONLY): ${esc(plugin.title)}. Switch faults with POST /api/fault {"fault": "...", "on": true}.</p><h1>${esc(plugin.title)}</h1>
<table>${html}</table><h2>Faults</h2><ul>${buttons}</ul></body></html>`;
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
    if (method === 'GET' && path === '/api/state') return send(res, 200, { head: feed.head().toString(), faults: [...feed.faults], model: plugin.state() });
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
    if (method === 'GET' && path === `${base}/feed`) {
      const after = url.searchParams.get('after') ?? '0';
      const limit = url.searchParams.get('limit') ?? '100';
      if (!WHOLE.test(after) || !/^[1-9][0-9]{0,2}$/.test(limit)) throw new SimRefusal(400, 'SCHEMA', 'after is a whole number, limit 1 to 999');
      return deliver(res, feed.page(BigInt(after), Number(limit)));
    }
    if (method === 'GET' && path === `${base}/heartbeat`) {
      if (!feed.heartbeatOk()) throw new SimRefusal(503, 'NO_HEARTBEAT', `the ${feed.system} heartbeat has stopped`);
      return send(res, 200, { head: feed.head().toString() });
    }
    if (method === 'GET' && path === `${base}/reconciliation`) {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!WHOLE.test(from) || !WHOLE.test(to) || BigInt(from) >= BigInt(to)) throw new SimRefusal(400, 'SCHEMA', 'from and to are epoch microseconds, from < to');
      return send(res, 200, feed.reconciliation(BigInt(from), BigInt(to)));
    }
    const body = method === 'POST' || method === 'PUT' ? await readJson(req) : undefined;
    const r = plugin.route(method, path, url.searchParams, body);
    if (!r) throw new SimRefusal(404, 'NOT_FOUND', `${method} ${path} is not a route of this simulator`);
    if (r.read && r.status === 200) return deliver(res, r.body);
    return send(res, r.status, r.body);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof SimRefusal) return send(res, error.status, { error: { code: error.code, message: error.message.slice(0, 500) } });
      send(res, 500, { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(http.port, http.host, () => resolve());
  });
  const a = server.address();
  return {
    feed,
    port: a && typeof a === 'object' ? a.port : http.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** host:port from an environment variable (a loopback default), for the simulators' main files. */
export function listenAddress(value: string | undefined, fallback: string): { host: string; port: number } {
  const text = value && value !== '' ? value : fallback;
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  return { host: m[1] ?? '127.0.0.1', port: Number(m[2]) };
}
