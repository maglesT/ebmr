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
 * A refusal answers {error:{code, message}} (L3Error). Control for tests and the demo: POST /api/fault
 * {fault:"UNAVAILABLE", on} makes every /l3 route answer 503; GET / is a plain-HTML console. SIMULATOR, DEMO-ONLY.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PoolRequest, SerialEventsRequest } from '@ebmr/integration-sdk/serialisation';
import { L3Refusal, L3Stub, type L3StubOptions } from './model.ts';

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
<p>${faults.has('UNAVAILABLE') ? 'UNAVAILABLE (answers 503)' : 'Available'}; ${stub.decommissionTasks().length} decommissioning task(s) open.</p>
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
      if (!isRecord(body) || body['fault'] !== 'UNAVAILABLE' || typeof body['on'] !== 'boolean') return refuse(res, 400, 'SCHEMA', 'expected {fault:"UNAVAILABLE", on}');
      if (body['on']) faults.add('UNAVAILABLE');
      else faults.delete('UNAVAILABLE');
      return send(res, 200, { faults: [...faults] });
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
    if (method === 'GET' && path === '/l3/v1/decommission-tasks') return send(res, 200, { tasks: stub.decommissionTasks() });
    const m = /^\/l3\/v1\/pools\/([^/]+)\/(events|report|reject)$/.exec(path);
    if (!m) return refuse(res, 404, 'NOT_FOUND', 'not found');
    const poolId = decodeURIComponent(m[1] ?? '');
    const what = m[2];
    if (what === 'report' && method === 'GET') return send(res, 200, stub.report(poolId));
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
