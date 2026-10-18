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
 *
 * Readiness (DI-30, PR-20; review finding P51): an instrument is reported ONLINE in the heartbeat and in GET
 * /v1/health only while a capture on it could be journalled and delivered: connected with its verified serial, AND
 * the gateway is logged in with a usable journal (not diverged, no failed write), the installation kind matches, the
 * server's binding matches this configuration, and the uplink can deliver (Uplink.deliveryProblem: the server does
 * not refuse the oldest reading it lacks, the watermark can be written, the last upload succeeded, and readings
 * journalled before the login are delivered). Otherwise it is reported OFFLINE, with the reason in the health
 * answer, so the server offers the manual two-person path instead of refusing it while every capture fails; a
 * capture then answers NOT_READY with the same reason. The heartbeat carries that reason too, so the server holds a
 * record of why. A change is sent in a heartbeat at once (at most one such heartbeat per 500 ms, Uplink). What the
 * gateway cannot see (the server failing to reach this API) the server detects and records (tablets 0320).
 */
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NOT_READY_MAX,
  READING_FORMAT,
  isMultipleOf,
  sealReading,
  type CapturePurpose,
  type CaptureResponse,
  type DeviceState,
  type GatewayHealth,
  type LiveSample,
  type LoginResponse,
  type ReadingBody,
  type ScaleErrorClass,
  type ScaleReading,
} from '@ebmr/integration-sdk/scale';
import { systemClock, type GatewayClock } from './clock.ts';
import type { DeviceConfig, GatewayConfig, OpcuaEndpointConfig } from './config.ts';
import type { EquipmentKind } from '@ebmr/integration-sdk/process';
import { feedKeyId } from '@ebmr/integration-sdk/adapter';
import { MtSicsDriver, type CommandResult } from './drivers/mt-sics.ts';
import { Journal } from './journal.ts';
import { PrinterGateway } from './printer-uplink.ts';
import { ProcessGateway } from './process-uplink.ts';
import { OpcuaDriver, type OpcuaDriverAlarm, type OpcuaTransport, type OpcuaUnit } from './drivers/opcua.ts';
import { NodeOpcuaTransport } from './drivers/opcua-node.ts';
import { OpcuaFeed } from './opcua-feed.ts';
import { Uplink, newApiToken } from './uplink.ts';

/**
 * How long a capture waits, once its reading is journalled, to learn whether the server holds it (Uplink.waitForAck):
 * `uplinked: false` when the server has not acknowledged it by then (the reading stays journalled and is delivered
 * later). The answer never comes later than this, whatever the gateway's disk does, so it stays within the time the
 * server's request allows after the balance has settled (decision X28).
 */
export const CAPTURE_ACK_WAIT_MS = 5000;

export interface GatewayAlarmRecord {
  atUs: string;
  source: 'driver' | 'journal' | 'uplink' | 'capture' | 'process' | 'printer' | 'opcua';
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
  /** Slice 6b: the OPC UA transport per endpoint (tests; default node-opcua). */
  opcuaTransport?: (e: OpcuaEndpointConfig) => OpcuaTransport;
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
  /** The presses and coaters, when configured (Phase 3 slice 3a). */
  process: ProcessGateway | null = null;
  /** The line printers, when configured (Phase 3 slice 4a). */
  printer: PrinterGateway | null = null;
  /** The OPC UA endpoints' drivers and their feed, when configured (Phase 6 slice 6b). */
  readonly opcuaDrivers = new Map<string, OpcuaDriver>();
  opcuaFeed: OpcuaFeed | null = null;
  /** A test's transport per endpoint (default node-opcua). */
  opcuaTransport: ((e: OpcuaEndpointConfig) => OpcuaTransport) | null = null;
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
      onAlarm: (a) => {
        g.alarm('journal', a.kind, null, a.message, a.details);
        // A failed append makes every instrument not ready: tell the server now (the uplink exists by then).
        if (a.kind === 'WRITE_FAILED') g.readinessChanged();
      },
    });
    for (const d of config.devices) {
      const driver = new MtSicsDriver({ code: d.code, host: d.host, port: d.port, expectedSerial: d.expectedSerial, clock: g.clock, ...(options.driver ?? {}) });
      driver.on('alarm', (a: { kind: string; deviceCode: string; message: string; details: Record<string, string> }) => g.alarm('driver', a.kind, a.deviceCode, a.message, a.details));
      driver.on('state', (s: string) => {
        g.log(`${d.code}: ${s}`);
        g.readinessChanged();
      });
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
        devices: [...g.instruments.values()].map((i) => {
          const notReady = g.notReady(i);
          return {
            deviceCode: i.config.code,
            state: g.reportedState(i),
            serial: i.driver.state === 'ONLINE' ? i.driver.serial : i.driver.reportedSerial,
            // The server stores why (review finding P51), so it holds a record of it, not only the state.
            notReady: notReady === null ? null : notReady.slice(0, NOT_READY_MAX),
          };
        }),
      }),
    });
    for (const i of g.instruments.values()) i.driver.start();
    g.opcuaTransport = options.opcuaTransport ?? null;
    const units = g.startOpcua();
    if (config.processDevices.length > 0 || units.length > 0) {
      // Presses and coaters (Phase 3 slice 3a): their own journal and uplink, under this gateway's session.
      g.process = await ProcessGateway.start({
        uplink: config.uplink,
        journalDir: config.journalDir,
        devices: config.processDevices,
        session: g.uplink,
        clock: g.clock,
        pollMs: config.processPollMs,
        staleAfterMs: config.processStaleAfterMs,
        setpointPollMs: config.setpointPollMs,
        manual: options.manualUplink ?? false,
        ...(options.driver ? { driver: { ...options.driver, ...(options.driver.commandTimeoutMs ? { requestTimeoutMs: options.driver.commandTimeoutMs } : {}) } } : {}),
        onAlarm: (a) => g.alarm('process', a.kind, a.deviceCode, a.message, a.details),
        onDriverAlarm: (a) => g.alarm('driver', a.kind, a.deviceCode, a.message, a.details),
        log: g.log,
        units,
      });
    }
    if (g.opcuaFeed) await g.opcuaFeed.serve(config.opcuaFeedListen.host, config.opcuaFeedListen.port);
    if (config.printers.length > 0) {
      // Line printers (Phase 3 slice 4a): their own journal and uplink, under this gateway's session.
      g.printer = await PrinterGateway.start({
        uplink: config.uplink,
        journalDir: config.journalDir,
        printers: config.printers,
        session: g.uplink,
        clock: g.clock,
        pollMs: config.printerPollMs,
        staleAfterMs: config.printerStaleAfterMs,
        jobPollMs: config.printJobPollMs,
        manual: options.manualUplink ?? false,
        ...(options.driver ? { driver: { ...options.driver, ...(options.driver.commandTimeoutMs ? { requestTimeoutMs: options.driver.commandTimeoutMs } : {}) } } : {}),
        onAlarm: (a) => g.alarm('printer', a.kind, a.deviceCode, a.message, a.details),
        onDriverAlarm: (a) => g.alarm('driver', a.kind, a.deviceCode, a.message, a.details),
        log: g.log,
      });
    }
    if (!options.manualUplink) g.uplink.start();
    return g;
  }

  /**
   * Slice 6b (builder A): the OPC UA drivers of the configured endpoints and their feed (./opcua-feed.ts); returns the
   * units the process path reads through them. Their transport is node-opcua unless a test gives one.
   */
  private startOpcua(): { config: { code: string; equipment: EquipmentKind; expectedSerial: string }; driver: OpcuaUnit }[] {
    const endpoints = this.config.opcuaEndpoints;
    if (endpoints.length === 0) return [];
    const feed = OpcuaFeed.open({
      dir: join(this.config.journalDir, 'opcua'), gatewayCode: this.config.gatewayCode, clock: this.clock,
      // Slice 7a (6jc-R9): the feed is signed with the gateway's own key (the one enrolled in tab.gateway_key).
      signingKey: { privateKey: this.config.privateKey, keyId: feedKeyId(Buffer.from(this.config.publicKeySpki, 'base64')) },
      onAlarm: (a) => this.alarm('opcua', a.kind, null, a.message, a.details),
    });
    this.opcuaFeed = feed;
    const out: { config: { code: string; equipment: EquipmentKind; expectedSerial: string }; driver: OpcuaUnit }[] = [];
    for (const e of endpoints) {
      const transport = this.opcuaTransport?.(e) ?? new NodeOpcuaTransport({ pkiDir: this.config.opcuaPkiDir, units: e.units.map((u) => u.equipmentCode) });
      const driver = new OpcuaDriver({
        code: e.code, endpoint: e.endpoint, equipment: Object.fromEntries(e.units.map((u) => [u.equipmentCode, u.equipment])), transport, clock: this.clock,
        sink: feed.sink(), nextChunkNo: (unit, tag) => feed.nextChunkNo(unit, tag), gapAfterMs: this.config.opcuaGapAfterMs,
      });
      driver.on('alarm', (a: OpcuaDriverAlarm) => this.alarm('opcua', a.kind, a.endpointCode, a.message, a.details));
      driver.on('state', (s: string) => {
        this.log(`${e.code}: ${s}`);
        for (const u of e.units) this.process?.connectionChanged(u.code);
      });
      this.opcuaDrivers.set(e.code, driver);
      for (const u of e.units) out.push({ config: { code: u.code, equipment: u.equipment, expectedSerial: u.equipmentCode }, driver: driver.unit(u.equipmentCode) });
      driver.start();
    }
    return out;
  }

  async stop(): Promise<void> {
    for (const l of this.live.values()) clearInterval(l.timer);
    this.live.clear();
    for (const d of this.opcuaDrivers.values()) await d.stop();
    await this.opcuaFeed?.close();
    await this.process?.stop();
    await this.printer?.stop();
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

  /** Something that may change what the heartbeat reports happened: with the loops running, report it now. */
  private readinessChanged(): void {
    (this.uplink as Uplink | undefined)?.readinessChanged();
  }

  /**
   * Why a capture on `i` could not be journalled and delivered now, apart from the instrument's own connection
   * (null when it could). The capture answers NOT_READY with it, and the heartbeat reports `i` OFFLINE.
   */
  private readinessProblem(i: Instrument): string | null {
    if (this.journal.writeFailure !== null) return `the gateway's journal could not be written (${this.journal.writeFailure}); nothing more is recorded until the gateway restarts`;
    if (!this.journal.chainId || !this.journal.usable || this.installationMismatch) {
      return 'the gateway has no usable reading chain with its server (not logged in, installation mismatch, or re-enrolment needed)';
    }
    return this.enrolmentProblem(i) ?? this.uplink.deliveryProblem();
  }

  /** Why `i` is reported OFFLINE although it is connected (null when it is not connected, or ready). */
  private notReady(i: Instrument): string | null {
    return i.driver.state === 'ONLINE' ? this.readinessProblem(i) : null;
  }

  /** The state the heartbeat and the health answer report: the driver's, except that a connected instrument that cannot capture is OFFLINE. */
  private reportedState(i: Instrument): DeviceState {
    return this.notReady(i) !== null ? 'OFFLINE' : i.driver.state;
  }

  health(): GatewayHealth {
    return {
      gatewayCode: this.config.gatewayCode,
      loggedIn: this.uplink.login !== null,
      chainId: this.journal.chainId,
      journal: { lastSeq: this.journal.lastSeq().toString(), ackedSeq: this.journal.ackedSeq.toString() },
      devices: [...this.instruments.values()].map((i) => {
        const notReady = this.notReady(i);
        return { deviceCode: i.config.code, state: notReady !== null ? 'OFFLINE' : i.driver.state, serial: i.driver.serial, notReady };
      }),
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

  /**
   * Seals and journals what the instrument answered (fsync), then uploads it. `uplinked`: the server acknowledged it
   * within CAPTURE_ACK_WAIT_MS; the answer waits for the watermark write that records it, but not past that time
   * (Uplink.waitForAck).
   */
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
    const uplinked = await this.uplink.waitForAck(BigInt(reading.seq), CAPTURE_ACK_WAIT_MS, reading.chainId);
    return { reading, uplinked };
  }

  async capture(deviceCode: string, purpose: CapturePurpose, timeoutMs = this.config.captureTimeoutMs): Promise<CaptureResponse> {
    const i = this.instruments.get(deviceCode);
    if (!i) return this.failed('UNKNOWN_DEVICE', `${deviceCode} is not an instrument of this gateway`);
    const problem = this.readinessProblem(i);
    if (problem) return this.failed('NOT_READY', problem);
    try {
      return await this.captureOn(i, purpose, timeoutMs);
    } catch (error) {
      // A reading that could not be journalled was never answered or uploaded (the journal alarmed and stopped).
      if (this.journal.writeFailure !== null) return this.failed('NOT_READY', `nothing was recorded: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async captureOn(i: Instrument, purpose: CapturePurpose, timeoutMs: number): Promise<CaptureResponse> {
    const deviceCode = i.config.code;
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
