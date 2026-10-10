/**
 * Process equipment on the site gateway (Phase 3 slice 3a, G-06; DI-20, DI-28, DI-31): the presses and coaters behind
 * the ebmr.sim-process.v1 driver, their readings journalled and forwarded, and the setpoint downloads.
 *
 * Readings: every poll reads each device and journals, in one synced append, an ACTUAL reading per tag, a
 * SETPOINT_READBACK for each setpoint whose read-back changed (and at the first poll of a connection), an ALARM when
 * an alarm becomes active and an ALARM_CLEARED when it ends (with the tag's value then). Each carries the device
 * serial verified at connect, the tag's unit, the gateway's clock when the answer arrived, the device's next sequence
 * number (process-journal.ts) and its quality: the device's, or STALE once its scan counter has not moved for
 * processStaleAfterMs (its values stopped updating). A value in another unit than the tag's, with more decimals than
 * the tag's, or of a tag the equipment does not have is never journalled or converted: it is alarmed.
 *
 * Forwarding (store and forward): what is journalled is sent oldest first to POST /gw/v1/process-readings under the
 * gateway's session (the scale uplink's bearer token; a request answered with relogin ends the session and logs in
 * again), in batches of one capture session; the delivered mark moves only on the server's 2xx answer. While the
 * server cannot be reached nothing is lost: the readings wait in the journal and go, in order, at the next flush. An
 * outage, a refusal and the recovery are alarmed once each; a refused batch is offered again after 30 s.
 *
 * Setpoints: GET /gw/v1/setpoint-downloads lists the downloads pending for this gateway's devices. Each is checked
 * (a device of this gateway, a setpoint tag of its equipment, the tag's unit and decimals), written, read back and
 * compared: APPLIED when the read-back equals the download, MISMATCH when it differs, FAILED when it could not be
 * written or read back. The read-back is journalled and forwarded before the acknowledgement POST
 * /gw/v1/setpoint-downloads/:id/ack is sent; an acknowledgement that does not reach the server is sent again (the
 * device is not written twice for one download in this process).
 */
import { randomUUID } from 'node:crypto';
import {
  PROCESS_BATCH_MAX,
  PROCESS_READINGS_PATH,
  ProcessReadingsResponse,
  SETPOINT_DOWNLOADS_PATH,
  SetpointDownloadsResponse,
  processReadingProblems,
  setpointAckPath,
  tagSpec,
  type ProcessQuality,
  type ProcessReading,
  type ProcessReadingsRequest,
  type SetpointAckRequest,
  type SetpointDownload,
} from '@ebmr/integration-sdk/process';
import { GatewayWireError, scaleOf, toCounts } from '@ebmr/integration-sdk/scale';
import type { GatewayClock } from './clock.ts';
import type { ProcessDeviceConfig } from './config.ts';
import { ProcessSimDriver } from './drivers/process-sim.ts';
import { ProcessJournal } from './process-journal.ts';
import { UplinkError } from './uplink.ts';

/** The gateway session the process uplink sends under (the scale Uplink provides it). */
export interface GatewaySession {
  sessionToken(): Promise<string | null>;
  sessionEnded(token: string): void;
}

export interface ProcessAlarm {
  kind:
    | 'VALUE_REFUSED'
    | 'DEVICE_STALE'
    | 'DEVICE_FRESH'
    | 'UPLINK_FAILED'
    | 'UPLINK_RESTORED'
    | 'READINGS_REFUSED'
    | 'JOURNAL_FAILED'
    | 'SETPOINT_FAILED'
    | 'SETPOINT_MISMATCH'
    | 'ACK_FAILED';
  deviceCode: string | null;
  message: string;
  details: Record<string, string>;
}

export interface ProcessGatewayOptions {
  uplink: string;
  journalDir: string;
  devices: ProcessDeviceConfig[];
  session: GatewaySession;
  clock: GatewayClock;
  pollMs: number;
  staleAfterMs: number;
  setpointPollMs: number;
  /** Do not start the loops (tests drive pollOnce, flush and pollSetpoints themselves). */
  manual?: boolean;
  driver?: { requestTimeoutMs?: number; backoffInitialMs?: number; backoffMaxMs?: number; connectTimeoutMs?: number };
  onAlarm?: (alarm: ProcessAlarm) => void;
  onDriverAlarm?: (alarm: { kind: string; deviceCode: string; message: string; details: Record<string, string> }) => void;
  log?: (message: string) => void;
}

interface Device {
  config: ProcessDeviceConfig;
  driver: ProcessSimDriver;
  /** The scan counter last seen, and when it last moved (monotonic µs). */
  scan: string | null;
  scanMovedAtUs: bigint;
  stale: boolean;
  /** Read-backs last journalled on this connection (tag -> value). */
  readbacks: Map<string, string>;
  /** Alarms active at the last poll (code|tag). */
  alarms: Set<string>;
}

type Outgoing = Omit<ProcessReading, 'sequence'>;

/** Two decimal texts name the same value ("14.5" and "14.50" do). */
function sameDecimal(a: string, b: string): boolean {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return toCounts(a, scale) === toCounts(b, scale);
}

/** A refused batch is offered again after this long (the alarm is raised once; no alarm storm). */
const REFUSAL_HOLD_US = 30_000_000n;

export class ProcessGateway {
  /** The gateway's capture session: drawn at each start, carried by every reading taken in this process. */
  readonly sessionId = randomUUID();
  readonly devices = new Map<string, Device>();
  journal!: ProcessJournal;
  /** Why the last upload failed (null once one succeeds). */
  uploadFailure: string | null = null;
  private refusedAtUs: bigint | null = null;
  /** Downloads handled in this process: the acknowledgement, and whether the server has it. */
  private readonly acks = new Map<string, { body: SetpointAckRequest; sent: boolean }>();
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private polling = false;
  private setpointPolling: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  private constructor(private readonly options: ProcessGatewayOptions) {}

  static async start(options: ProcessGatewayOptions): Promise<ProcessGateway> {
    const g = new ProcessGateway(options);
    g.journal = await ProcessJournal.open({ dir: options.journalDir, onAlarm: (a) => g.alarm({ kind: 'JOURNAL_FAILED', deviceCode: null, message: a.message, details: { ...a.details, journalAlarm: a.kind } }) });
    for (const config of options.devices) {
      const driver = new ProcessSimDriver({ code: config.code, equipment: config.equipment, host: config.host, port: config.port, expectedSerial: config.expectedSerial, clock: options.clock, ...(options.driver ?? {}) });
      const device: Device = { config, driver, scan: null, scanMovedAtUs: options.clock.monoUs(), stale: false, readbacks: new Map(), alarms: new Set() };
      driver.on('alarm', (a: { kind: string; deviceCode: string; message: string; details: Record<string, string> }) => options.onDriverAlarm?.(a));
      driver.on('state', (s: string) => {
        options.log?.(`${config.code}: ${s}`);
        // A new connection reports its read-backs again; the scan counter starts afresh.
        if (s !== 'ONLINE') {
          device.readbacks.clear();
          device.scan = null;
        }
      });
      g.devices.set(config.code, device);
      driver.start();
    }
    if (!options.manual) {
      g.timers.push(setInterval(() => void g.pollOnce(), options.pollMs));
      g.timers.push(setInterval(() => void g.pollSetpoints(), options.setpointPollMs));
    }
    return g;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await this.flushing?.catch(() => undefined);
    await this.setpointPolling?.catch(() => undefined);
    for (const d of this.devices.values()) await d.driver.stop();
    await this.journal.close();
  }

  private alarm(a: ProcessAlarm): void {
    this.options.onAlarm?.(a);
  }

  /** Reads every device once, journals what it read, then forwards. Never rejects. */
  async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const d of this.devices.values()) await this.pollDevice(d);
    } finally {
      this.polling = false;
    }
    await this.flush();
  }

  private quality(d: Device, scan: string, device: ProcessQuality): ProcessQuality {
    const now = this.options.clock.monoUs();
    if (d.scan !== scan) {
      d.scan = scan;
      d.scanMovedAtUs = now;
      if (d.stale) {
        d.stale = false;
        this.alarm({ kind: 'DEVICE_FRESH', deviceCode: d.config.code, message: `${d.config.code}: values update again`, details: { scan } });
      }
    } else if (!d.stale && now - d.scanMovedAtUs >= BigInt(this.options.staleAfterMs) * 1000n) {
      d.stale = true;
      this.alarm({ kind: 'DEVICE_STALE', deviceCode: d.config.code, message: `${d.config.code}: the values have not updated for ${this.options.staleAfterMs} ms; they are reported STALE`, details: { scan } });
    }
    return d.stale ? 'STALE' : device;
  }

  /** A reading of this device's equipment in the tag's unit and decimals; null (alarmed) otherwise. */
  private checked(d: Device, r: Outgoing): Outgoing | null {
    const spec = tagSpec(r.tag);
    const problems = processReadingProblems(r).map((p) => p.message);
    if (spec && spec.equipment !== d.config.equipment) problems.push(`${r.tag} is not a ${d.config.equipment.toLowerCase()} tag`);
    if (problems.length === 0) return r;
    this.alarm({ kind: 'VALUE_REFUSED', deviceCode: d.config.code, message: `${d.config.code}: ${r.kind} ${r.tag} = ${r.value} ${r.unit} refused: ${problems.join('; ')}`, details: { tag: r.tag, value: r.value, unit: r.unit } });
    return null;
  }

  private async pollDevice(d: Device): Promise<void> {
    const r = await d.driver.read();
    if (!r.ok) return;
    const { sample } = r;
    const quality = (q: 'GOOD' | 'UNCERTAIN' | 'BAD') => this.quality(d, sample.scan, q);
    const base = { deviceSerial: r.serial, sourceTime: r.receivedWallUs.toString() };
    const out: Outgoing[] = [];
    const scanQuality = quality('GOOD');
    const valueOf = new Map(sample.values.map((v) => [v.tag, v]));
    for (const v of sample.values) {
      out.push({ ...base, tag: v.tag, value: v.value, unit: v.unit, quality: scanQuality === 'STALE' ? 'STALE' : v.quality, kind: 'ACTUAL' });
    }
    for (const s of sample.setpoints) {
      if (d.readbacks.get(s.tag) === s.value) continue;
      out.push({ ...base, tag: s.tag, value: s.value, unit: s.unit, quality: scanQuality, kind: 'SETPOINT_READBACK' });
    }
    const active = new Set(sample.alarms.map((a) => `${a.code}|${a.tag}`));
    const alarmReading = (key: string, kind: 'ALARM' | 'ALARM_CLEARED'): Outgoing | null => {
      const tag = key.slice(key.indexOf('|') + 1);
      const v = valueOf.get(tag);
      return v ? { ...base, tag, value: v.value, unit: v.unit, quality: scanQuality, kind } : null;
    };
    for (const key of active) if (!d.alarms.has(key)) out.push(...[alarmReading(key, 'ALARM')].filter((x): x is Outgoing => x !== null));
    for (const key of d.alarms) if (!active.has(key)) out.push(...[alarmReading(key, 'ALARM_CLEARED')].filter((x): x is Outgoing => x !== null));
    const accepted = out.map((o) => this.checked(d, o)).filter((o): o is Outgoing => o !== null);
    try {
      await this.journal.append(this.sessionId, accepted);
    } catch {
      return; // alarmed by the journal; nothing is remembered as reported
    }
    for (const s of sample.setpoints) d.readbacks.set(s.tag, s.value);
    d.alarms = active;
  }

  /** Forwards what the journal holds, oldest first; one flush at a time (a request during one runs one more). Never rejects. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.deliver();
        } while (this.flushAgain && !this.stopped);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    for (;;) {
      const pending = this.journal.undelivered(PROCESS_BATCH_MAX);
      const first = pending[0];
      if (!first) return;
      if (this.refusedAtUs !== null && this.options.clock.monoUs() - this.refusedAtUs < REFUSAL_HOLD_US) return;
      // One request carries one capture session (readings journalled before a restart go in their own batches).
      const other = pending.findIndex((e) => e.sessionId !== first.sessionId);
      const batch = other < 0 ? pending : pending.slice(0, other);
      const body: ProcessReadingsRequest = { sessionId: first.sessionId, readings: batch.map((e) => e.reading) };
      try {
        await this.call('POST', PROCESS_READINGS_PATH, body, ProcessReadingsResponse);
      } catch (error) {
        const e = error instanceof UplinkError ? error : null;
        const message = error instanceof Error ? error.message : String(error);
        if (e && e.status >= 400 && e.status < 500 && !e.relogin) {
          this.refusedAtUs = this.options.clock.monoUs();
          this.alarm({ kind: 'READINGS_REFUSED', deviceCode: null, message: `the server refused ${batch.length} process readings: ${e.code} ${message}; offered again in 30 s`, details: { code: e.code, firstSequence: first.reading.sequence, deviceSerial: first.reading.deviceSerial } });
        } else if (this.uploadFailure === null) {
          this.alarm({ kind: 'UPLINK_FAILED', deviceCode: null, message: `process readings not uploaded (kept in the journal): ${message}`, details: { waiting: String(pending.length) } });
        }
        this.uploadFailure = message;
        return;
      }
      this.refusedAtUs = null;
      if (this.uploadFailure !== null) this.alarm({ kind: 'UPLINK_RESTORED', deviceCode: null, message: 'process readings are uploaded again', details: {} });
      this.uploadFailure = null;
      await this.journal.acknowledge(batch.length);
    }
  }

  /** Fetches the pending setpoint downloads and applies each; one run at a time. Never rejects. */
  pollSetpoints(): Promise<void> {
    this.setpointPolling ??= this.applyDownloads()
      .catch(() => undefined)
      .finally(() => {
        this.setpointPolling = null;
      });
    return this.setpointPolling;
  }

  private async applyDownloads(): Promise<void> {
    if (this.stopped) return;
    let downloads: SetpointDownload[];
    try {
      downloads = (await this.call('GET', SETPOINT_DOWNLOADS_PATH, null, SetpointDownloadsResponse)).downloads;
    } catch {
      return; // the next poll asks again; an outage is alarmed by the readings' upload
    }
    for (const download of downloads) {
      let ack = this.acks.get(download.id);
      if (!ack) {
        ack = { body: await this.apply(download), sent: false };
        this.acks.set(download.id, ack);
      }
      // The read-back reading reaches the server before the acknowledgement that names it.
      await this.flush();
      if (ack.body.readback && this.journal.undelivered().some((e) => e.reading.deviceSerial === download.deviceSerial && e.reading.sequence === ack.body.readback?.sequence)) continue;
      try {
        await this.call('POST', setpointAckPath(download.id), ack.body, ProcessReadingsResponse);
        ack.sent = true;
      } catch (error) {
        this.alarm({ kind: 'ACK_FAILED', deviceCode: null, message: `the acknowledgement of setpoint download ${download.id} did not reach the server (${error instanceof Error ? error.message : String(error)}); sent again later`, details: { id: download.id } });
      }
    }
  }

  private async apply(download: SetpointDownload): Promise<SetpointAckRequest> {
    const failed = (message: string): SetpointAckRequest => {
      this.alarm({ kind: 'SETPOINT_FAILED', deviceCode: device?.config.code ?? null, message: `setpoint download ${download.id} (${download.tag} = ${download.value} ${download.unit}) failed: ${message}`, details: { id: download.id, deviceSerial: download.deviceSerial } });
      return { sessionId: this.sessionId, outcome: 'FAILED', readback: null, message };
    };
    const device = [...this.devices.values()].find((d) => d.config.expectedSerial === download.deviceSerial);
    if (!device) return failed(`no device with serial ${download.deviceSerial} on this gateway`);
    const spec = tagSpec(download.tag);
    if (!spec || spec.equipment !== device.config.equipment || !spec.setpoint) return failed(`${download.tag} is not a setpoint of this ${device.config.equipment.toLowerCase()}`);
    if (download.unit !== spec.unit) return failed(`${download.tag} is set in ${spec.unit}, not ${download.unit}`);
    try {
      toCounts(download.value, spec.scale);
    } catch {
      return failed(`${download.tag} takes at most ${spec.scale} decimals`);
    }
    const w = await device.driver.write(download.tag, download.value);
    if (!w.ok) return failed(w.message);
    const r = await device.driver.read();
    if (!r.ok) return failed(`written, but not read back: ${r.message}`);
    const back = r.sample.setpoints.find((s) => s.tag === download.tag);
    if (!back || back.unit !== spec.unit) return failed('written, but the device did not read the setpoint back in its unit');
    const quality = this.quality(device, r.sample.scan, 'GOOD');
    const reading: Outgoing = { deviceSerial: r.serial, tag: download.tag, value: back.value, unit: back.unit, quality, sourceTime: r.receivedWallUs.toString(), kind: 'SETPOINT_READBACK' };
    if (this.checked(device, reading) === null) return failed('written, but the read-back is not a value of the tag');
    let journalled: ProcessReading | undefined;
    try {
      [journalled] = await this.journal.append(this.sessionId, [reading]);
    } catch (error) {
      return failed(`written, but the read-back could not be journalled (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!journalled) return failed('written, but the read-back was not journalled');
    device.readbacks.set(download.tag, back.value);
    const readback = { value: journalled.value, unit: journalled.unit, sourceTime: journalled.sourceTime, sequence: journalled.sequence };
    if (!sameDecimal(back.value, download.value) || quality === 'STALE') {
      const message = quality === 'STALE' ? `the read-back of ${download.tag} is stale` : `${download.tag} reads back ${back.value}, not ${download.value}`;
      this.alarm({ kind: 'SETPOINT_MISMATCH', deviceCode: device.config.code, message: `setpoint download ${download.id}: ${message}`, details: { id: download.id, sent: download.value, readBack: back.value } });
      return { sessionId: this.sessionId, outcome: 'MISMATCH', readback, message };
    }
    return { sessionId: this.sessionId, outcome: 'APPLIED', readback, message: null };
  }

  /** One request under the gateway session; a relogin answer ends the session (a login follows). */
  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, parse: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
    const token = await this.options.session.sessionToken();
    if (token === null) throw new UplinkError(0, 'NO_SESSION', 'the gateway has no session with the server', false);
    let res: Response;
    try {
      res = await fetch(`${this.options.uplink}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new UplinkError(0, 'UNREACHABLE', `the server's gateway listener cannot be reached: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new UplinkError(res.status, 'PROTOCOL', `the listener answered ${res.status} without JSON`, false);
    }
    if (!res.ok) {
      const e = GatewayWireError.safeParse(json);
      const err = e.success ? new UplinkError(res.status, e.data.error.code, e.data.error.message, e.data.error.relogin) : new UplinkError(res.status, 'PROTOCOL', `the listener answered ${res.status}`, res.status === 401);
      if (err.relogin) this.options.session.sessionEnded(token);
      throw err;
    }
    const parsed = parse.safeParse(json);
    if (!parsed.success) throw new UplinkError(res.status, 'PROTOCOL', `the listener's answer to ${path} is not in the expected form`, false);
    return parsed.data;
  }
}
