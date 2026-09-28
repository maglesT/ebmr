/**
 * MT-SICS driver: one TCP connection per balance, CR LF line framing that keeps every raw line, one outstanding
 * command at a time (a queue), a timeout per command, and reconnection with exponential back-off.
 *
 * DI-20: at every connect the driver asks I4 for the serial number; a serial other than the configured one is
 * refused (state SERIAL_MISMATCH, alarm, connection closed; checked again at the next attempt).
 * A timed-out command or a garbled line closes the connection, so a late or corrupted answer can never be taken
 * as the answer to a later command; the next command runs on a fresh, re-verified connection.
 */
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { LineFramer, MtSicsProtocolError, encodeCommand, parseResponse, type DeviceState, type MtSicsCommand, type MtSicsResponse } from '@ebmr/integration-sdk/scale';
import type { GatewayClock } from '../clock.ts';

export interface MtSicsDriverOptions {
  code: string;
  host: string;
  port: number;
  expectedSerial: string;
  clock: GatewayClock;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
}

export type CommandResult =
  /** `serial`: the serial verified with I4 on the connection that carried this answer. */
  | { ok: true; response: MtSicsResponse; receivedWallUs: bigint; receivedMonoUs: bigint; serial: string | null }
  | { ok: false; error: 'OFFLINE' | 'SERIAL_MISMATCH' | 'TIMEOUT' | 'PROTOCOL'; raw?: string; message: string };

export interface DriverAlarm {
  kind: 'SERIAL_MISMATCH' | 'PROTOCOL_ERROR' | 'TIMEOUT' | 'DISCONNECTED';
  deviceCode: string;
  message: string;
  details: Record<string, string>;
}

interface Pending {
  command: MtSicsCommand;
  resolve: (r: CommandResult) => void;
  timer: NodeJS.Timeout;
}

interface Queued {
  command: MtSicsCommand;
  timeoutMs: number;
  resolve: (r: CommandResult) => void;
}

/**
 * Events: 'state' (DeviceState), 'alarm' (DriverAlarm).
 */
export class MtSicsDriver extends EventEmitter {
  state: DeviceState = 'CONNECTING';
  /** The serial read with I4 on the current connection (null while not verified). */
  serial: string | null = null;
  /** The serial the instrument reported when it was refused (SERIAL_MISMATCH). */
  reportedSerial: string | null = null;
  private socket: Socket | null = null;
  private framer: LineFramer;
  private pending: Pending | null = null;
  private readonly queue: Queued[] = [];
  private stopped = false;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;

  constructor(readonly options: MtSicsDriverOptions) {
    super();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2000;
    this.backoffInitialMs = options.backoffInitialMs ?? 250;
    this.backoffMaxMs = options.backoffMaxMs ?? 5000;
    this.backoff = this.backoffInitialMs;
    this.framer = new LineFramer(
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

  /** Sends a command once connected and verified; resolves with the parsed answer and its raw line. */
  command(command: MtSicsCommand, timeoutMs = this.commandTimeoutMs): Promise<CommandResult> {
    if (this.state === 'SERIAL_MISMATCH') {
      return Promise.resolve({ ok: false, error: 'SERIAL_MISMATCH', message: `${this.code} reported serial ${this.reportedSerial ?? '?'}, not ${this.options.expectedSerial}` });
    }
    if (this.state !== 'ONLINE') return Promise.resolve({ ok: false, error: 'OFFLINE', message: `${this.code} is not connected` });
    return new Promise((resolve) => {
      this.queue.push({ command, timeoutMs, resolve });
      this.pump();
    });
  }

  private setState(state: DeviceState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private alarm(a: Omit<DriverAlarm, 'deviceCode'>): void {
    this.emit('alarm', { ...a, deviceCode: this.code } satisfies DriverAlarm);
  }

  private connectNow(): void {
    if (this.stopped) return;
    if (this.state === 'ONLINE') this.setState('CONNECTING');
    this.serial = null;
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
      this.failAll('OFFLINE', `${this.code}: the connection closed`);
      if (this.state === 'ONLINE') this.alarm({ kind: 'DISCONNECTED', message: `${this.code}: the connection to the balance was lost`, details: {} });
      if (this.state !== 'SERIAL_MISMATCH') this.setState('OFFLINE');
      this.scheduleReconnect();
    });
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      void this.verify(socket);
    });
  }

  /** I4 at every connect (DI-20). */
  private async verify(socket: Socket): Promise<void> {
    const r = await this.send('I4', this.commandTimeoutMs, true);
    if (this.socket !== socket) return;
    if (!r.ok) {
      this.drop(`${this.code}: no serial number answer (${r.message})`, true);
      return;
    }
    if (r.response.kind !== 'SERIAL') {
      this.drop(`${this.code}: I4 answered "${r.response.raw}"`, true);
      return;
    }
    if (r.response.serial !== this.options.expectedSerial) {
      this.reportedSerial = r.response.serial;
      this.setState('SERIAL_MISMATCH');
      this.alarm({
        kind: 'SERIAL_MISMATCH',
        message: `DI-20: ${this.code} answered with serial ${r.response.serial}, not the configured ${this.options.expectedSerial}; it is refused`,
        details: { expected: this.options.expectedSerial, reported: r.response.serial, raw: r.response.raw },
      });
      this.drop('serial mismatch', false);
      return;
    }
    this.reportedSerial = r.response.serial;
    this.serial = r.response.serial;
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
    this.failAll('OFFLINE', reason);
  }

  private failAll(error: 'OFFLINE', message: string): void {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error, message });
    }
    for (const q of this.queue.splice(0)) q.resolve({ ok: false, error, message });
  }

  private pump(): void {
    if (this.pending || this.state !== 'ONLINE') return;
    const next = this.queue.shift();
    if (!next) return;
    void this.send(next.command, next.timeoutMs, false).then(next.resolve);
  }

  private send(command: MtSicsCommand, timeoutMs: number, verifying: boolean): Promise<CommandResult> {
    const socket = this.socket;
    if (!socket) return Promise.resolve({ ok: false, error: 'OFFLINE', message: `${this.code} is not connected` });
    return new Promise((resolve) => {
      const done = (r: CommandResult) => {
        resolve(r);
        if (!verifying) setImmediate(() => this.pump());
      };
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        this.pending = null;
        this.alarm({ kind: 'TIMEOUT', message: `${this.code}: no answer to ${command} within ${timeoutMs} ms; reconnecting`, details: { command } });
        done({ ok: false, error: 'TIMEOUT', message: `${this.code}: no answer to ${command} within ${timeoutMs} ms` });
        // A late answer must never be read as the answer to a later command.
        this.drop('command timeout', false);
      }, timeoutMs);
      this.pending = { command, resolve: done, timer };
      socket.write(encodeCommand(command));
    });
  }

  private onLine(line: string): void {
    const p = this.pending;
    if (!p) {
      this.alarm({ kind: 'PROTOCOL_ERROR', message: `${this.code}: an unsolicited line arrived; reconnecting`, details: { raw: line } });
      this.drop('unsolicited line', false);
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    const receivedWallUs = this.options.clock.wallUs();
    const receivedMonoUs = this.options.clock.monoUs();
    try {
      const response = parseResponse(line);
      p.resolve({ ok: true, response, receivedWallUs, receivedMonoUs, serial: this.serial });
    } catch (error) {
      const message = error instanceof MtSicsProtocolError ? error.message : String(error);
      this.alarm({ kind: 'PROTOCOL_ERROR', message: `${this.code}: garbled answer to ${p.command} (${message}); reconnecting`, details: { raw: line } });
      p.resolve({ ok: false, error: 'PROTOCOL', raw: line, message: `${this.code}: garbled answer to ${p.command}` });
      this.drop('garbled line', false);
    }
  }

  private onGarbage(fragment: string): void {
    this.alarm({ kind: 'PROTOCOL_ERROR', message: `${this.code}: an over-long line arrived; reconnecting`, details: { raw: fragment.slice(0, 64) } });
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'PROTOCOL', raw: fragment.slice(0, 128), message: `${this.code}: garbled answer` });
    }
    this.drop('garbage', false);
  }
}
