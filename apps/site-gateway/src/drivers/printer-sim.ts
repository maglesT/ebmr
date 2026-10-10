/**
 * Printer driver (Phase 3 slice 4a, G-21, K-20) for line printers speaking `ebmr.sim-printer.v1` (the printer
 * simulator; a stand-in for a coder's own protocol): one TCP connection per printer, LF-framed JSON lines, one
 * outstanding request at a time (a queue), a timeout per request, reconnection with exponential back-off.
 *
 * DI-20: at every connect the driver asks `hello` for the serial number (and the printer's boot, which numbers its
 * events); another serial than the configured one is refused (state SERIAL_MISMATCH, alarm, connection closed;
 * checked again at the next attempt). A timed-out request or a garbled line closes the connection, so a late or
 * corrupted answer is never taken as the answer to a later request. A garbled line is never interpreted.
 */
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { JsonLineFramer, SimProtocolError, encodeSimLine } from '@ebmr/integration-sdk/process';
import {
  parseSimPrinterAnswer,
  type SimPrinterAnswer,
  type SimPrinterEvent,
  type SimPrinterJob,
  type SimPrinterRequest,
  type SimPrinterStatus,
} from '@ebmr/integration-sdk/printer';
import type { DeviceState } from '@ebmr/integration-sdk/scale';
import type { GatewayClock } from '../clock.ts';

export interface PrinterDriverOptions {
  code: string;
  host: string;
  port: number;
  expectedSerial: string;
  clock: GatewayClock;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
}

export type DriverError = 'OFFLINE' | 'SERIAL_MISMATCH' | 'TIMEOUT' | 'PROTOCOL' | 'REFUSED';

/** A request without its id (distributed over the ops). */
type RequestBody = SimPrinterRequest extends infer R ? (R extends SimPrinterRequest ? Omit<R, 'id'> : never) : never;

type Failure = { ok: false; error: DriverError; message: string };
export type StatusResult = { ok: true; status: SimPrinterStatus; receivedWallUs: bigint; serial: string; boot: string } | Failure;
export type LoadResult = { ok: true; echo: SimPrinterJob; receivedWallUs: bigint } | Failure;
export type ClearResult = { ok: true } | Failure;
export type EventsResult = { ok: true; events: SimPrinterEvent[]; more: boolean; boot: string; receivedWallUs: bigint; serial: string } | Failure;

export interface PrinterDriverAlarm {
  kind: 'SERIAL_MISMATCH' | 'PROTOCOL_ERROR' | 'TIMEOUT' | 'DISCONNECTED';
  deviceCode: string;
  message: string;
  details: Record<string, string>;
}

type Outcome = { ok: true; answer: SimPrinterAnswer; receivedWallUs: bigint } | { ok: false; error: DriverError; message: string };

interface Queued {
  request: RequestBody;
  resolve: (o: Outcome) => void;
}

/** Events: 'state' (DeviceState), 'alarm' (PrinterDriverAlarm). */
export class PrinterSimDriver extends EventEmitter {
  state: DeviceState = 'CONNECTING';
  /** The serial verified with hello on the current connection (null while not verified). */
  serial: string | null = null;
  /** The printer's boot reported by hello on the current connection (null while not verified). */
  boot: string | null = null;
  /** The serial the device reported when it was refused (SERIAL_MISMATCH). */
  reportedSerial: string | null = null;
  private socket: Socket | null = null;
  private readonly framer: JsonLineFramer;
  private pending: { request: SimPrinterRequest; resolve: (o: Outcome) => void; timer: NodeJS.Timeout } | null = null;
  private readonly queue: Queued[] = [];
  private stopped = false;
  private nextId = 0n;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;

  constructor(readonly options: PrinterDriverOptions) {
    super();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2000;
    this.backoffInitialMs = options.backoffInitialMs ?? 250;
    this.backoffMaxMs = options.backoffMaxMs ?? 5000;
    this.backoff = this.backoffInitialMs;
    this.framer = new JsonLineFramer(
      (line) => this.onLine(line),
      (fragment) => this.onGarbage(fragment),
    );
  }

  get code(): string {
    return this.options.code;
  }

  start(): void {
    this.stopped = false;
    this.connectNow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.drop('stopped', false);
    await Promise.resolve();
  }

  /** Reads the printer's status: scan counter, running, the job held and the units printed on it. */
  async read(): Promise<StatusResult> {
    const boot = this.boot;
    const o = await this.request({ op: 'read' });
    if (!o.ok) return o;
    if (!o.answer.ok) return { ok: false, error: 'REFUSED', message: `${this.code} refused the read: ${o.answer.message}` };
    if (!('scan' in o.answer)) return { ok: false, error: 'PROTOCOL', message: `${this.code}: not a status` };
    return { ok: true, status: o.answer, receivedWallUs: o.receivedWallUs, serial: this.serial ?? this.options.expectedSerial, boot: boot ?? '0' };
  }

  /** Loads a job (the record's variable data as given); the printer answers with its echo of what it now holds. */
  async load(job: SimPrinterJob): Promise<LoadResult> {
    const o = await this.request({ op: 'load', job });
    if (!o.ok) return o;
    if (!o.answer.ok) return { ok: false, error: 'REFUSED', message: `${this.code} refused the job: ${o.answer.error} ${o.answer.message}` };
    if (!('echo' in o.answer)) return { ok: false, error: 'PROTOCOL', message: `${this.code}: not an echo` };
    return { ok: true, echo: o.answer.echo, receivedWallUs: o.receivedWallUs };
  }

  /** Clears the job the printer holds. */
  async clear(): Promise<ClearResult> {
    const o = await this.request({ op: 'clear' });
    if (!o.ok) return o;
    if (!o.answer.ok) return { ok: false, error: 'REFUSED', message: `${this.code} refused to clear: ${o.answer.message}` };
    return { ok: true };
  }

  /** The printer's events numbered after `after` in the boot of this connection. */
  async events(after: bigint): Promise<EventsResult> {
    const boot = this.boot;
    const o = await this.request({ op: 'events', after: after.toString() });
    if (!o.ok) return o;
    if (!o.answer.ok) return { ok: false, error: 'REFUSED', message: `${this.code} refused the events: ${o.answer.message}` };
    if (!('events' in o.answer)) return { ok: false, error: 'PROTOCOL', message: `${this.code}: not events` };
    if (boot === null || boot !== this.boot) return { ok: false, error: 'OFFLINE', message: `${this.code}: the connection changed during the request` };
    return { ok: true, events: o.answer.events, more: o.answer.more, boot, receivedWallUs: o.receivedWallUs, serial: this.serial ?? this.options.expectedSerial };
  }

  private request(request: RequestBody): Promise<Outcome> {
    if (this.state === 'SERIAL_MISMATCH') {
      return Promise.resolve({ ok: false, error: 'SERIAL_MISMATCH', message: `${this.code} reported serial ${this.reportedSerial ?? '?'}, not ${this.options.expectedSerial}` });
    }
    if (this.state !== 'ONLINE') return Promise.resolve({ ok: false, error: 'OFFLINE', message: `${this.code} is not connected` });
    return new Promise((resolve) => {
      this.queue.push({ request, resolve });
      this.pump();
    });
  }

  private setState(state: DeviceState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private alarm(a: Omit<PrinterDriverAlarm, 'deviceCode'>): void {
    this.emit('alarm', { ...a, deviceCode: this.code } satisfies PrinterDriverAlarm);
  }

  private connectNow(): void {
    if (this.stopped) return;
    if (this.state === 'ONLINE') this.setState('CONNECTING');
    this.serial = null;
    this.boot = null;
    this.framer.reset();
    const socket = connect({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    socket.setNoDelay(true);
    const connectTimer = setTimeout(() => socket.destroy(new Error('connect timeout')), this.connectTimeoutMs);
    socket.on('data', (chunk) => {
      if (this.socket === socket) this.framer.push(chunk);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== socket) return;
      this.socket = null;
      this.failAll(`${this.code}: the connection closed`);
      if (this.state === 'ONLINE') this.alarm({ kind: 'DISCONNECTED', message: `${this.code}: the connection to the controller was lost`, details: {} });
      if (this.state !== 'SERIAL_MISMATCH') this.setState('OFFLINE');
      this.scheduleReconnect();
    });
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      void this.verify(socket);
    });
  }

  /** hello at every connect: the serial must be the configured one (DI-20); the boot numbers the printer's events. */
  private async verify(socket: Socket): Promise<void> {
    const o = await this.send({ op: 'hello' }, true);
    if (this.socket !== socket) return;
    if (!o.ok || !o.answer.ok || !('boot' in o.answer)) {
      this.drop(`${this.code}: no identification answer (${o.ok ? 'refused' : o.message})`, true);
      return;
    }
    const { serial, boot } = o.answer;
    if (serial !== this.options.expectedSerial) {
      this.reportedSerial = serial;
      this.setState('SERIAL_MISMATCH');
      this.alarm({
        kind: 'SERIAL_MISMATCH',
        message: `DI-20: ${this.code} identified as ${serial}, not the configured ${this.options.expectedSerial}; it is refused`,
        details: { expected: this.options.expectedSerial, reported: serial },
      });
      this.drop('serial mismatch', false);
      return;
    }
    this.reportedSerial = serial;
    this.serial = serial;
    this.boot = boot;
    this.backoff = this.backoffInitialMs;
    this.setState('ONLINE');
    this.pump();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoffMaxMs, this.backoff * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectNow();
    }, wait);
  }

  /** Closes the connection (and fails what waits on it); the close handler reconnects unless stopped. */
  private drop(reason: string, alarm: boolean): void {
    if (alarm) this.alarm({ kind: 'PROTOCOL_ERROR', message: reason, details: {} });
    const s = this.socket;
    if (s) s.destroy();
    else if (!this.stopped) this.scheduleReconnect();
    this.failAll(reason);
  }

  private failAll(message: string): void {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'OFFLINE', message });
    }
    for (const q of this.queue.splice(0)) q.resolve({ ok: false, error: 'OFFLINE', message });
  }

  private pump(): void {
    if (this.pending || this.state !== 'ONLINE') return;
    const next = this.queue.shift();
    if (!next) return;
    void this.send(next.request, false).then(next.resolve);
  }

  private send(body: RequestBody, verifying: boolean): Promise<Outcome> {
    const socket = this.socket;
    if (!socket) return Promise.resolve({ ok: false, error: 'OFFLINE', message: `${this.code} is not connected` });
    this.nextId += 1n;
    const request: SimPrinterRequest = { ...body, id: this.nextId.toString() };
    return new Promise((resolve) => {
      const done = (o: Outcome) => {
        resolve(o);
        if (!verifying) setImmediate(() => this.pump());
      };
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        this.pending = null;
        this.alarm({ kind: 'TIMEOUT', message: `${this.code}: no answer to ${request.op} within ${this.requestTimeoutMs} ms; reconnecting`, details: { op: request.op } });
        done({ ok: false, error: 'TIMEOUT', message: `${this.code}: no answer to ${request.op} within ${this.requestTimeoutMs} ms` });
        // A late answer must never be read as the answer to a later request.
        this.drop('request timeout', false);
      }, this.requestTimeoutMs);
      this.pending = { request, resolve: done, timer };
      socket.write(encodeSimLine(request));
    });
  }

  private onLine(line: string): void {
    const p = this.pending;
    if (!p) {
      this.alarm({ kind: 'PROTOCOL_ERROR', message: `${this.code}: an unsolicited line arrived; reconnecting`, details: { raw: line.slice(0, 64) } });
      this.drop('unsolicited line', false);
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    const receivedWallUs = this.options.clock.wallUs();
    try {
      p.resolve({ ok: true, answer: parseSimPrinterAnswer(p.request, line), receivedWallUs });
    } catch (error) {
      const message = error instanceof SimProtocolError ? error.message : String(error);
      this.alarm({ kind: 'PROTOCOL_ERROR', message: `${this.code}: garbled answer to ${p.request.op} (${message}); reconnecting`, details: { raw: line.slice(0, 64) } });
      p.resolve({ ok: false, error: 'PROTOCOL', message: `${this.code}: garbled answer to ${p.request.op}` });
      this.drop('garbled line', false);
    }
  }

  private onGarbage(fragment: string): void {
    this.alarm({ kind: 'PROTOCOL_ERROR', message: `${this.code}: an over-long line arrived; reconnecting`, details: { raw: fragment.slice(0, 64) } });
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'PROTOCOL', message: `${this.code}: garbled answer` });
    }
    this.drop('garbage', false);
  }
}
