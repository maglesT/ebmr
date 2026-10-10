/**
 * The process simulators' servers (Phase 3 slice 3a; no third-party dependencies), one process per simulated press
 * or coater:
 *  - TCP (default 127.0.0.1:4011 press, 4021 coater): the controller side of `ebmr.sim-process.v1` (JSON lines, see
 *    @ebmr/integration-sdk/process sim-protocol.ts): hello, read, write; one answer per request, in order;
 *  - HTTP control API and plain-HTML console (default 127.0.0.1:4012 / 4022) for the owner and the tests: start and
 *    stop, change a setpoint by hand, switch faults on and off, reset.
 * Faults (model.ts): OFFLINE drops and refuses connections; GARBLED corrupts every answer; STALE, DRIFT, ALARM and
 * SETPOINT_MISMATCH act in the model.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { JsonLineFramer, SIM_PROCESS_PROTOCOL, SimProtocolError, encodeSimLine, parseSimRequest, type SimRequest } from '@ebmr/integration-sdk/process';
import { FAULTS, ProcessModel, type Fault, type ProcessModelOptions } from './model.ts';
import { consoleHtml } from './console.ts';

export interface ProcessSimulatorOptions extends ProcessModelOptions {
  tcp: { host: string; port: number };
  http: { host: string; port: number } | null;
}

export interface RunningProcessSimulator {
  model: ProcessModel;
  tcpPort: number;
  httpPort: number | null;
  close(): Promise<void>;
}

export async function startProcessSimulator(opts: ProcessSimulatorOptions): Promise<RunningProcessSimulator> {
  const model = new ProcessModel(opts);
  const sockets = new Set<Socket>();

  const dropAll = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  const answer = (request: SimRequest): unknown => {
    switch (request.op) {
      case 'hello':
        return { id: request.id, ok: true, protocol: SIM_PROCESS_PROTOCOL, serial: model.serial, equipment: model.equipment };
      case 'read':
        return { id: request.id, ok: true, ...model.sample() };
      case 'write': {
        const r = model.write(request.tag, request.value);
        return r.ok ? { id: request.id, ok: true } : { id: request.id, ok: false, error: r.error, message: r.message };
      }
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
      let line = encodeSimLine(message).slice(0, -1);
      if (model.faults.has('GARBLED')) line = model.garble(line);
      if (!socket.destroyed) socket.write(Buffer.from(`${line}\n`, 'latin1'));
    };
    const framer = new JsonLineFramer(
      (line) => {
        let request: SimRequest;
        try {
          request = parseSimRequest(line);
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

  const setFault = (fault: Fault, on: boolean) => {
    model.setFault(fault, on);
    if (fault === 'OFFLINE' && on) dropAll();
  };

  /** One control action; the console's forms and the JSON API share it. */
  function act(action: string, input: Record<string, string>): void {
    switch (action) {
      case 'start':
        model.start();
        return;
      case 'stop':
        model.stop();
        return;
      case 'setpoint': {
        const r = model.write(input['tag'] ?? '', input['value'] ?? '');
        if (!r.ok) throw new Error(r.message);
        return;
      }
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
      res.end(consoleHtml(model.state(), url.searchParams.get('problem')));
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
