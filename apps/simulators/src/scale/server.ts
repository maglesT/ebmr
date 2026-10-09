/**
 * The MT-SICS scale simulator's servers (module C5; no third-party dependencies):
 *  - TCP (default 127.0.0.1:4001): the balance side of MT-SICS: S, SI, T, Z, I4 and @, one CR LF line per answer;
 *  - HTTP control API and plain-HTML console (default 127.0.0.1:4002) for the owner and the tests: place a container,
 *    add 0.5 kg or 5 g, remove everything, zero, tare, switch faults on and off, reset.
 * Faults: OFFLINE (connections dropped and refused), UNSTABLE (never settles), OVERLOAD, SLOW (answers delayed),
 * GARBLED (answers corrupted), SERIAL_MISMATCH (I4 reports another serial), DRIFT (a settled value creeps).
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { LINE_END, LineFramer, formatError, formatSerial, formatStatus, formatWeight, parseCommand, type MtSicsCommand } from '@ebmr/integration-sdk/scale';
import { FAULTS, ScaleModel, type Fault, type ScaleModelOptions } from './model.ts';
import { consoleHtml, loadFormHtml } from './console.ts';

export interface ScaleSimulatorOptions extends ScaleModelOptions {
  tcp: { host: string; port: number };
  http: { host: string; port: number } | null;
  /** Delay of every answer under the SLOW fault (default 3000 ms). */
  slowMs?: number;
  /** How long S, T and Z wait for stability before answering "not executable" (default 4000 ms). */
  stabilityTimeoutMs?: number;
  /** The container "Place container" puts on the pan (default 1.250). */
  containerMass?: string;
}

export interface RunningSimulator {
  model: ScaleModel;
  tcpPort: number;
  httpPort: number | null;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startScaleSimulator(opts: ScaleSimulatorOptions): Promise<RunningSimulator> {
  const model = new ScaleModel(opts);
  const sockets = new Set<Socket>();
  const slowMs = opts.slowMs ?? 3000;
  const stabilityTimeoutMs = opts.stabilityTimeoutMs ?? 4000;
  const containerMass = opts.containerMass ?? '1.250';
  const unit = opts.unit;

  const dropAll = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  const waitStable = async (): Promise<boolean> => {
    const started = Date.now();
    for (;;) {
      const r = model.read(false);
      if (r.kind !== 'WEIGHT' || r.stable) return true;
      if (Date.now() - started >= stabilityTimeoutMs) return false;
      await sleep(50);
    }
  };

  const answer = async (command: MtSicsCommand | null): Promise<string> => {
    switch (command) {
      case 'SI': {
        const r = model.read();
        if (r.kind === 'OVERLOAD') return formatStatus('S', '+');
        if (r.kind === 'UNDERLOAD') return formatStatus('S', '-');
        return formatWeight('S', r.stable ? 'S' : 'D', r.value, unit);
      }
      case 'S': {
        if (!(await waitStable())) return formatStatus('S', 'I');
        const r = model.read();
        if (r.kind === 'OVERLOAD') return formatStatus('S', '+');
        if (r.kind === 'UNDERLOAD') return formatStatus('S', '-');
        return r.stable ? formatWeight('S', 'S', r.value, unit) : formatStatus('S', 'I');
      }
      case 'T': {
        if (!(await waitStable())) return formatStatus('T', 'I');
        const t = model.tareNow();
        return t.status === 'S' ? formatWeight('T', 'S', t.value, unit) : formatStatus('T', t.status);
      }
      case 'Z': {
        if (!(await waitStable())) return formatStatus('Z', 'I');
        return formatStatus('Z', model.zeroNow());
      }
      case 'I4':
      case '@':
        return formatSerial(model.serial);
      default:
        return formatError('ES');
    }
  };

  const tcp: TcpServer = createTcpServer((socket) => {
    if (model.faults.has('OFFLINE')) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    let chain = Promise.resolve();
    const framer = new LineFramer((line) => {
      chain = chain.then(async () => {
        let out = await answer(parseCommand(line));
        if (model.faults.has('SLOW')) await sleep(slowMs);
        if (model.faults.has('GARBLED')) out = model.garble(out);
        if (!socket.destroyed) socket.write(Buffer.from(out + LINE_END, 'latin1'));
      });
    });
    socket.on('data', (chunk) => framer.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });

  const setFault = (fault: Fault, on: boolean) => {
    model.setFault(fault, on);
    if (fault === 'OFFLINE' && on) dropAll();
  };

  let http: HttpServer | null = null;
  if (opts.http) {
    http = createHttpServer((req, res) => {
      void handle(req, res).catch((error: unknown) => sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
    });
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

  /** One control action; the console's forms and the JSON API share it. */
  function act(action: string, input: Record<string, string>): void {
    switch (action) {
      case 'place':
        model.add(input['mass'] ?? containerMass);
        return;
      case 'add':
        model.add(input['mass'] ?? '0.500');
        return;
      case 'set':
        model.set(input['mass'] ?? '0');
        return;
      case 'remove':
        model.removeAll();
        return;
      case 'zero':
        model.zeroNow();
        return;
      case 'tare':
        model.tareNow();
        return;
      case 'reset':
        model.reset();
        return;
      case 'fault': {
        const fault = input['fault'] as Fault;
        if (!(FAULTS as readonly string[]).includes(fault)) throw new Error(`unknown fault ${input['fault'] ?? ''}`);
        setFault(fault, input['on'] !== 'false' && input['on'] !== '0');
        return;
      }
      case 'clear-faults':
        for (const f of FAULTS) setFault(f, false);
        return;
      default:
        throw new Error(`unknown action ${action}`);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://simulator');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(consoleHtml(model.state(), containerMass));
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
    if (req.method === 'GET' && url.pathname === '/console/load') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(loadFormHtml(model.state().unit, url.searchParams.get('problem')));
      return;
    }
    const form = /^\/console\/([a-z-]+)$/.exec(url.pathname);
    if (req.method === 'POST' && form) {
      const params = new URLSearchParams(await readBody(req));
      const action = form[1] ?? '';
      // A typed load that is not a mass goes back to the form with the reason; the pan is left as it was.
      const mass = params.get('mass') ?? '';
      if (action === 'set' && !/^\d{1,3}(\.\d{1,3})?$/.test(mass)) {
        res.writeHead(303, { location: `/console/load?problem=${encodeURIComponent(`"${mass}" is not a mass: type up to three decimals, for example 51.250.`)}` });
        res.end();
        return;
      }
      act(action, Object.fromEntries(params.entries()));
      res.writeHead(303, { location: '/' });
      res.end();
      return;
    }
    sendJson(res, 404, { error: 'not found' });
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
