/**
 * The printer simulator's servers (Phase 3 slice 4a; no third-party dependencies), one process per simulated printer:
 *  - TCP (default 127.0.0.1:4031): the printer side of `ebmr.sim-printer.v1` (JSON lines, see
 *    @ebmr/integration-sdk/printer sim-protocol.ts): hello, load, clear, read, events; one answer per request, in order;
 *  - HTTP control API and plain-HTML console (default 127.0.0.1:4032): start and stop the line, challenge the reader
 *    or the vision system, switch faults on and off, reset (a power cycle).
 * OFFLINE drops and refuses connections; the other faults act in the model.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { JsonLineFramer, SimProtocolError, encodeSimLine } from '@ebmr/integration-sdk/process';
import { SIM_PRINTER_PROTOCOL, parseSimPrinterRequest, type SimPrinterRequest } from '@ebmr/integration-sdk/printer';
import { PRINTER_FAULTS, PrinterModel, type PrinterFault, type PrinterModelOptions, type PrinterModelState } from './model.ts';

export interface PrinterSimulatorOptions extends PrinterModelOptions {
  tcp: { host: string; port: number };
  http: { host: string; port: number } | null;
}

export interface RunningPrinterSimulator {
  model: PrinterModel;
  tcpPort: number;
  httpPort: number | null;
  close(): Promise<void>;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function button(action: string, label: string, fields: Record<string, string> = {}): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<form method="post" action="/console/${esc(action)}">${hidden}<button type="submit">${esc(label)}</button></form>`;
}

/** The console (plain HTML, forms only, refreshes every second). SIMULATOR: not a real printer. */
export function printerConsoleHtml(state: PrinterModelState, problem: string | null = null): string {
  const job = state.job
    ? `<table><tbody><tr><td>Job</td><td>${esc(state.job.jobId)}</td></tr><tr><td>Layout</td><td>${esc(state.job.layoutRef)}</td></tr>${Object.entries(state.job.fields)
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p>No job loaded.</p>';
  const faults = PRINTER_FAULTS.map((f) => {
    const on = state.faults.includes(f);
    return `<li>${esc(f)}: <strong>${on ? 'ON' : 'off'}</strong> ${button('fault', on ? `Clear ${f}` : `Inject ${f}`, { fault: f, on: on ? 'false' : 'true' })}</li>`;
  }).join('');
  const events = state.recent.map((e) => `<li>#${esc(e.no)} ${esc(e.kind)} ${esc(e.value)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="1">
<title>Printer simulator</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; max-width: 760px; background: #fff; color: #111; }
  .banner { background: #fde68a; padding: 8px 12px; font-weight: 700; border-radius: 6px; }
  .alarm { color: #7f1d1d; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; }
  td { border-bottom: 1px solid #ddd; padding: 4px 8px; font-family: ui-monospace, monospace; }
  form { display: inline-block; margin: 4px; }
  button { font-size: 16px; padding: 8px 14px; min-height: 44px; }
  ul { list-style: none; padding: 0; }
</style>
</head>
<body>
<p class="banner">SIMULATOR (DEMO-ONLY): a simulated line printer, not real equipment.</p>
<h1>Printer simulator ${esc(state.serial)}</h1>
${problem ? `<p class="alarm" role="alert">${esc(problem)}</p>` : ''}
<p>${state.running ? 'Running' : 'Stopped'}, boot ${esc(state.boot)}, scan ${esc(state.scan)}, printed ${esc(state.printed)}</p>
${button('start', 'Start line')}${button('stop', 'Stop line')}${button('reset', 'Power cycle')}
<h2>Loaded job</h2>
${job}
<h2>Challenges</h2>
${button('challenge', 'Challenge the code reader', { target: 'READER' })}${button('challenge', 'Challenge the vision system', { target: 'VISION' })}
<h2>Faults</h2>
<ul>${faults}</ul>
${button('clear-faults', 'Clear all faults')}
<h2>Latest events</h2>
<ul>${events}</ul>
</body>
</html>`;
}

export async function startPrinterSimulator(opts: PrinterSimulatorOptions): Promise<RunningPrinterSimulator> {
  const model = new PrinterModel(opts);
  const sockets = new Set<Socket>();

  const dropAll = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  const answer = (request: SimPrinterRequest): unknown => {
    switch (request.op) {
      case 'hello':
        return { id: request.id, ok: true, protocol: SIM_PRINTER_PROTOCOL, serial: model.serial, boot: model.boot };
      case 'load':
        if (model.faults.has('STALE')) return { id: request.id, ok: false, error: 'STALE', message: 'the controller does not respond' };
        return { id: request.id, ok: true, echo: model.load(request.job) };
      case 'clear':
        model.clear();
        return { id: request.id, ok: true };
      case 'read':
        return { id: request.id, ok: true, ...model.status() };
      case 'events':
        return { id: request.id, ok: true, ...model.events(BigInt(request.after)) };
    }
  };

  const tcp: TcpServer = createTcpServer((socket) => {
    if (model.faults.has('OFFLINE')) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    const write = (message: unknown) => {
      if (!socket.destroyed) socket.write(Buffer.from(encodeSimLine(message), 'latin1'));
    };
    const framer = new JsonLineFramer(
      (line) => {
        let request: SimPrinterRequest;
        try {
          request = parseSimPrinterRequest(line);
        } catch (error) {
          const id = /"id":"([0-9]{1,18})"/.exec(line)?.[1] ?? '0';
          write({ id, ok: false, error: 'BAD_REQUEST', message: error instanceof SimProtocolError ? error.message : 'not a request' });
          return;
        }
        write(answer(request));
      },
      () => socket.destroy(),
    );
    socket.on('data', (chunk) => framer.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });

  const setFault = (fault: PrinterFault, on: boolean) => {
    model.setFault(fault, on);
    if (fault === 'OFFLINE' && on) dropAll();
  };

  function act(action: string, input: Record<string, string>): void {
    switch (action) {
      case 'start':
        model.start();
        return;
      case 'stop':
        model.stop();
        return;
      case 'reset':
        model.reset();
        dropAll(); // a power cycle ends every connection
        return;
      case 'challenge': {
        const r = model.challenge(input['target'] ?? '');
        if (!r.ok) throw new Error(r.message);
        return;
      }
      case 'fault': {
        const fault = input['fault'] as PrinterFault;
        if (!(PRINTER_FAULTS as readonly string[]).includes(fault)) throw new Error(`unknown fault ${input['fault'] ?? ''}`);
        setFault(fault, input['on'] !== 'false' && input['on'] !== '0');
        return;
      }
      case 'clear-faults':
        for (const f of PRINTER_FAULTS) setFault(f, false);
        return;
      default:
        throw new Error(`unknown action ${action}`);
    }
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://simulator');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(printerConsoleHtml(model.state(), url.searchParams.get('problem')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, model.state());
    const api = /^\/api\/([a-z-]+)$/.exec(url.pathname);
    if (req.method === 'POST' && api) {
      const text = await readBody(req);
      const input = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      act(api[1] ?? '', Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])));
      return sendJson(res, 200, model.state());
    }
    const form = /^\/console\/([a-z-]+)$/.exec(url.pathname);
    if (req.method === 'POST' && form) {
      const params = new URLSearchParams(await readBody(req));
      try {
        act(form[1] ?? '', Object.fromEntries(params.entries()));
        res.writeHead(303, { location: '/' });
      } catch (error) {
        res.writeHead(303, { location: `/?problem=${encodeURIComponent(error instanceof Error ? error.message : String(error))}` });
      }
      res.end();
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  let http: HttpServer | null = null;
  if (opts.http) {
    http = createHttpServer((req, res) => {
      void handle(req, res).catch((error: unknown) => sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
    });
  }

  await new Promise<void>((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen(opts.tcp.port, opts.tcp.host, () => resolve());
  });
  if (http) {
    const h = http;
    await new Promise<void>((resolve, reject) => {
      h.once('error', reject);
      h.listen(opts.http?.port ?? 0, opts.http?.host ?? '127.0.0.1', () => resolve());
    });
  }
  const portOf = (s: TcpServer | HttpServer | null): number | null => {
    const a = s?.address();
    return a && typeof a === 'object' ? a.port : null;
  };
  return {
    model,
    tcpPort: portOf(tcp) ?? opts.tcp.port,
    httpPort: portOf(http),
    async close() {
      dropAll();
      await new Promise<void>((r) => tcp.close(() => r()));
      if (http) {
        http.closeAllConnections();
        await new Promise<void>((r) => http?.close(() => r()));
      }
    },
  };
}
