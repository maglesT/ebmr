/**
 * The site gateway core (module C5): instruments behind MT-SICS drivers, the journal, the uplink, stable capture
 * and the live display.
 *
 * Capture (DI-20, DI-28, DI-31, DI-32): only for an instrument that is configured here AND bound to this gateway on
 * the server with the same serial, unit and resolution; only on a connection whose I4 serial was verified; S until a
 * stable weight or the timeout. What the instrument answered with a weight or a status is sealed and journalled
 * (fsync) before anything else: a stable weight as status OK; the last dynamic weight after a timeout as UNSTABLE;
 * overload and underload as such. Then the journal is uploaded and the capture answers with the reading and whether
 * the server acknowledged it. A unit other than the configured one, or a value finer than the resolution, is refused
 * and alarmed (never converted or rounded). Every other failure is answered with its error class.
 */
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  READING_FORMAT,
  isMultipleOf,
  sealReading,
  type CapturePurpose,
  type CaptureResponse,
  type GatewayHealth,
  type LiveSample,
  type LoginResponse,
  type ReadingBody,
  type ScaleErrorClass,
  type ScaleReading,
} from '@ebmr/integration-sdk/scale';
import { systemClock, type GatewayClock } from './clock.ts';
import type { DeviceConfig, GatewayConfig } from './config.ts';
import { MtSicsDriver, type CommandResult } from './drivers/mt-sics.ts';
import { Journal } from './journal.ts';
import { Uplink, newApiToken } from './uplink.ts';

export interface GatewayAlarmRecord {
  atUs: string;
  source: 'driver' | 'journal' | 'uplink' | 'capture';
  kind: string;
  deviceCode: string | null;
  message: string;
  details: Record<string, string>;
}

export interface GatewayOptions {
  clock?: GatewayClock;
  log?: (message: string) => void;
  /** Driver timing (tests shorten it). */
  driver?: { commandTimeoutMs?: number; backoffInitialMs?: number; backoffMaxMs?: number; connectTimeoutMs?: number };
  /** Do not start the uplink loops (tests drive login and flush themselves). */
  manualUplink?: boolean;
}

interface Instrument {
  config: DeviceConfig;
  driver: MtSicsDriver;
}

type LiveListener = (sample: LiveSample) => void;

export class SiteGateway {
  readonly instruments = new Map<string, Instrument>();
  readonly apiToken = newApiToken();
  readonly capturedAt = new Map<string, bigint>();
  readonly alarms: GatewayAlarmRecord[] = [];
  readonly clock: GatewayClock;
  journal!: Journal;
  uplink!: Uplink;
  private readonly live = new Map<string, { listeners: Set<LiveListener>; timer: NodeJS.Timeout; busy: boolean }>();
  private installationMismatch = false;
  private readonly log: (message: string) => void;

  private constructor(
    readonly config: GatewayConfig,
    private readonly options: GatewayOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => undefined);
  }

  static async start(config: GatewayConfig, options: GatewayOptions = {}): Promise<SiteGateway> {
    const g = new SiteGateway(config, options);
    g.journal = await Journal.open({
      dir: config.journalDir,
      gatewayCode: config.gatewayCode,
      publicKey: config.publicKey,
      onAlarm: (a) => g.alarm('journal', a.kind, null, a.message, a.details),
    });
    for (const d of config.devices) {
      const driver = new MtSicsDriver({ code: d.code, host: d.host, port: d.port, expectedSerial: d.expectedSerial, clock: g.clock, ...(options.driver ?? {}) });
      driver.on('alarm', (a: { kind: string; deviceCode: string; message: string; details: Record<string, string> }) => g.alarm('driver', a.kind, a.deviceCode, a.message, a.details));
      driver.on('state', (s: string) => g.log(`${d.code}: ${s}`));
      g.instruments.set(d.code, { config: d, driver });
    }
    g.uplink = new Uplink({
      config,
      journal: g.journal,
      clock: g.clock,
      apiToken: g.apiToken,
      capturedAt: g.capturedAt,
      onAlarm: (a) => {
        if (a.kind === 'INSTALLATION_MISMATCH') g.installationMismatch = true;
        g.alarm('uplink', a.kind, null, a.message, a.details);
      },
      onLogin: (login) => g.checkEnrolment(login),
      log: g.log,
      heartbeatBody: () => ({
        devices: [...g.instruments.values()].map((i) => ({ deviceCode: i.config.code, state: i.driver.state, serial: i.driver.state === 'ONLINE' ? i.driver.serial : i.driver.reportedSerial })),
      }),
    });
    for (const i of g.instruments.values()) i.driver.start();
    if (!options.manualUplink) g.uplink.start();
    return g;
  }

  async stop(): Promise<void> {
    for (const l of this.live.values()) clearInterval(l.timer);
    this.live.clear();
    await this.uplink.stop();
    for (const i of this.instruments.values()) await i.driver.stop();
    await this.journal.close();
  }

  alarm(source: GatewayAlarmRecord['source'], kind: string, deviceCode: string | null, message: string, details: Record<string, string> = {}): void {
    const record: GatewayAlarmRecord = { atUs: this.clock.wallUs().toString(), source, kind, deviceCode, message, details };
    this.alarms.push(record);
    if (this.alarms.length > 500) this.alarms.shift();
    this.log(`ALARM ${kind}${deviceCode ? ` ${deviceCode}` : ''}: ${message}`);
    void appendFile(join(this.config.journalDir, 'alarms.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 }).catch(() => undefined);
  }

  /** The server's bindings must match this configuration (serial, unit, resolution); mismatches are alarmed. */
  private enrolled = new Map<string, LoginResponse['instruments'][number]>();
  private checkEnrolment(login: LoginResponse): void {
    this.enrolled = new Map(login.instruments.map((i) => [i.deviceCode, i]));
    for (const i of this.instruments.values()) {
      const e = this.enrolled.get(i.config.code);
      if (!e) this.alarm('uplink', 'NOT_ENROLLED', i.config.code, `${i.config.code} is configured here but not bound to this gateway on the server; captures are refused`);
      else if (e.serial !== i.config.expectedSerial || e.unit !== i.config.unit || e.resolution !== i.config.resolution) {
        this.alarm('uplink', 'ENROLMENT_MISMATCH', i.config.code, `${i.config.code}: the server expects serial ${e.serial}, ${e.resolution} ${e.unit}; this gateway is configured differently; captures are refused`);
      }
    }
  }

  private enrolmentProblem(i: Instrument): string | null {
    if (!this.uplink.login) return 'the gateway has not logged in to its server yet';
    const e = this.enrolled.get(i.config.code);
    if (!e) return `${i.config.code} is not bound to this gateway on the server`;
    if (e.serial !== i.config.expectedSerial || e.unit !== i.config.unit || e.resolution !== i.config.resolution) return `${i.config.code}: the server's binding differs from this gateway's configuration`;
    return null;
  }

  health(): GatewayHealth {
    return {
      gatewayCode: this.config.gatewayCode,
      loggedIn: this.uplink.login !== null,
      chainId: this.journal.chainId,
      journal: { lastSeq: this.journal.lastSeq().toString(), ackedSeq: this.journal.ackedSeq.toString() },
      devices: [...this.instruments.values()].map((i) => ({ deviceCode: i.config.code, state: i.driver.state, serial: i.driver.serial })),
    };
  }

  private failed(error: ScaleErrorClass, message: string, reading: ScaleReading | null = null, uplinked = false): CaptureResponse {
    return { outcome: 'FAILED', error, message, reading, uplinked };
  }

  private fromCommandFailure(i: Instrument, r: Extract<CommandResult, { ok: false }>): CaptureResponse {
    if (r.error === 'SERIAL_MISMATCH') return this.failed('SERIAL_MISMATCH', r.message);
    if (r.error === 'PROTOCOL') return this.failed('PROTOCOL_ERROR', `${i.config.code} sent an answer that is not MT-SICS (${r.raw ?? ''}); nothing was recorded`);
    return this.failed('DEVICE_OFFLINE', `${i.config.code} did not answer: ${r.message}`);
  }

  /** Seals and journals what the instrument answered (fsync), then uploads it. */
  private async record(
    i: Instrument,
    r: Extract<CommandResult, { ok: true }>,
    fields: Pick<ReadingBody, 'value' | 'unit' | 'stable' | 'status'>,
    purpose: CapturePurpose,
  ): Promise<{ reading: ScaleReading; uplinked: boolean }> {
    const chainId = this.journal.chainId;
    const serial = r.serial;
    if (!chainId || !serial) throw new Error('no chain or no verified serial');
    const reading = await this.journal.appendNext((seq, prevHash) =>
      sealReading(
        {
          format: READING_FORMAT,
          readingId: randomUUID(),
          chainId,
          gatewayCode: this.config.gatewayCode,
          deviceCode: i.config.code,
          serial,
          seq: seq.toString(),
          ...fields,
          raw: r.response.raw,
          sourceTimeUs: r.receivedWallUs.toString(),
          trust: this.config.clockSynchronised ? 'DEVICE_SYNCED' : 'DEVICE_UNSYNCED',
          installation: this.config.installation,
          purpose,
          prevHash,
        },
        this.config.privateKey,
      ),
    );
    this.capturedAt.set(reading.readingId, r.receivedMonoUs);
    void this.uplink.flush();
    const uplinked = await this.uplink.waitForAck(BigInt(reading.seq), 5000);
    return { reading, uplinked };
  }

  async capture(deviceCode: string, purpose: CapturePurpose, timeoutMs = this.config.captureTimeoutMs): Promise<CaptureResponse> {
    const i = this.instruments.get(deviceCode);
    if (!i) return this.failed('UNKNOWN_DEVICE', `${deviceCode} is not an instrument of this gateway`);
    if (!this.journal.chainId || !this.journal.usable || this.installationMismatch) {
      return this.failed('NOT_READY', 'the gateway has no usable reading chain with its server (not logged in, installation mismatch, or re-enrolment needed)');
    }
    const enrolment = this.enrolmentProblem(i);
    if (enrolment) return this.failed('NOT_READY', enrolment);
    if (i.driver.state === 'SERIAL_MISMATCH') return this.failed('SERIAL_MISMATCH', `DI-20: ${deviceCode} reports serial ${i.driver.reportedSerial ?? '?'}, not ${i.config.expectedSerial}; it is refused`);
    if (i.driver.state !== 'ONLINE') return this.failed('DEVICE_OFFLINE', `${deviceCode} is not connected`);
    const deadline = this.clock.monoUs() + BigInt(timeoutMs) * 1000n;
    for (;;) {
      const remainingMs = Number((deadline - this.clock.monoUs()) / 1000n);
      const r = await i.driver.command('S', Math.max(500, remainingMs) + 1000);
      if (!r.ok) return this.fromCommandFailure(i, r);
      const resp = r.response;
      if (resp.kind === 'WEIGHT' && resp.command === 'S' && resp.stability === 'S') {
        if (resp.unit !== i.config.unit) {
          this.alarm('capture', 'UNIT_MISMATCH', deviceCode, `${deviceCode} weighs in ${resp.unit}, not ${i.config.unit}; refused (never converted)`, { raw: resp.raw });
          return this.failed('UNIT_MISMATCH', `${deviceCode} is set to ${resp.unit}; this step needs ${i.config.unit}. Set the balance unit to ${i.config.unit}.`);
        }
        if (!isMultipleOf(resp.value, i.config.resolution)) {
          this.alarm('capture', 'RESOLUTION_MISMATCH', deviceCode, `${deviceCode} answered ${resp.value}, finer than its readability ${i.config.resolution}; refused`, { raw: resp.raw });
          return this.failed('PROTOCOL_ERROR', `${deviceCode} answered with a readability other than ${i.config.resolution} ${i.config.unit}`);
        }
        const { reading, uplinked } = await this.record(i, r, { value: resp.value, unit: resp.unit, stable: true, status: 'OK' }, purpose);
        return { outcome: 'CAPTURED', reading, uplinked };
      }
      if (resp.kind === 'STATUS' && resp.command === 'S' && (resp.status === '+' || resp.status === '-')) {
        const status = resp.status === '+' ? 'OVERLOAD' : 'UNDERLOAD';
        const { reading, uplinked } = await this.record(i, r, { value: null, unit: null, stable: false, status }, purpose);
        return this.failed(status, `${deviceCode} reports ${status === 'OVERLOAD' ? 'overload: the load is above its capacity' : 'underload: the load is below its zero range'}`, reading, uplinked);
      }
      if (resp.kind === 'STATUS' && resp.command === 'S' && resp.status === 'I') {
        if (this.clock.monoUs() < deadline) {
          await new Promise((res) => setTimeout(res, 100));
          continue;
        }
        const last = await i.driver.command('SI', 2000);
        if (last.ok && last.response.kind === 'WEIGHT' && last.response.command === 'S' && last.response.stability === 'D' && last.response.unit === i.config.unit && isMultipleOf(last.response.value, i.config.resolution)) {
          const { reading, uplinked } = await this.record(i, last, { value: last.response.value, unit: last.response.unit, stable: false, status: 'UNSTABLE' }, purpose);
          return this.failed('NOT_STABLE_WITHIN_TIMEOUT', `${deviceCode} did not settle within ${timeoutMs / 1000} s; the unstable value was recorded as unstable and cannot be used`, reading, uplinked);
        }
        return this.failed('NOT_STABLE_WITHIN_TIMEOUT', `${deviceCode} did not settle within ${timeoutMs / 1000} s`);
      }
      this.alarm('capture', 'PROTOCOL_ERROR', deviceCode, `${deviceCode} answered S with "${resp.raw}"`, { raw: resp.raw });
      return this.failed('PROTOCOL_ERROR', `${deviceCode} answered "${resp.raw}"`);
    }
  }

  /** Live display at the configured rate (SI) while anyone watches; never recorded. */
  subscribeLive(deviceCode: string, listener: LiveListener): () => void {
    const i = this.instruments.get(deviceCode);
    if (!i) throw new Error(`unknown instrument ${deviceCode}`);
    let entry = this.live.get(deviceCode);
    if (!entry) {
      const e = { listeners: new Set<LiveListener>(), busy: false, timer: setInterval(() => void this.poll(i, e), this.config.livePollMs) };
      entry = e;
      this.live.set(deviceCode, e);
    }
    entry.listeners.add(listener);
    return () => {
      const e = this.live.get(deviceCode);
      e?.listeners.delete(listener);
      if (e && e.listeners.size === 0) {
        clearInterval(e.timer);
        this.live.delete(deviceCode);
      }
    };
  }

  private async poll(i: Instrument, e: { listeners: Set<LiveListener>; busy: boolean }): Promise<void> {
    if (e.busy) return;
    e.busy = true;
    try {
      const code = i.config.code;
      let sample: LiveSample;
      if (i.driver.state !== 'ONLINE') sample = { deviceCode: code, value: null, unit: null, stable: false, status: 'OFFLINE' };
      else {
        const r = await i.driver.command('SI', 1000);
        if (!r.ok) sample = { deviceCode: code, value: null, unit: null, stable: false, status: r.error === 'PROTOCOL' ? 'ERROR' : 'OFFLINE' };
        else if (r.response.kind === 'WEIGHT' && r.response.command === 'S') {
          sample =
            r.response.unit === i.config.unit
              ? { deviceCode: code, value: r.response.value, unit: r.response.unit, stable: r.response.stability === 'S', status: r.response.stability === 'S' ? 'OK' : 'UNSTABLE' }
              : { deviceCode: code, value: null, unit: null, stable: false, status: 'ERROR' };
        } else if (r.response.kind === 'STATUS' && r.response.command === 'S' && r.response.status === '+') sample = { deviceCode: code, value: null, unit: null, stable: false, status: 'OVERLOAD' };
        else if (r.response.kind === 'STATUS' && r.response.command === 'S' && r.response.status === '-') sample = { deviceCode: code, value: null, unit: null, stable: false, status: 'UNDERLOAD' };
        else sample = { deviceCode: code, value: null, unit: null, stable: false, status: 'ERROR' };
      }
      for (const l of e.listeners) l(sample);
    } finally {
      e.busy = false;
    }
  }
}
