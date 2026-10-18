/**
 * OPC UA client driver: the shape fixed by Phase 6 slice 6b-0 (plan "Slice 6b", "Gateway and simulator";
 * docs/build-plan/phase-6/slice-6b-0-interfaces.md). Builder A implements `OpcuaDriver` on node-opcua (D-P6b-1: an
 * exact pin, used only here and by the simulator; no kernel or database import, boundary rule unchanged) behind the
 * `OpcuaTransport` port below, so the driver's rules are tested without a network.
 *
 * What the driver does (each item a rule the implementation keeps):
 *  - DI-20 / D-P6b-2: connects to an enrolled endpoint only with SignAndEncrypt and one of OPCUA_SECURITY_POLICIES; the
 *    server certificate's SHA-256 must equal the enrolled thumbprint (`certificateProblem`), else state
 *    CERTIFICATE_MISMATCH, an alarm, and the session is closed (checked again at each reconnect).
 *  - Subscriptions on the node ids of the released tags (`opcuaNodeId`), with source timestamps and status codes kept
 *    as received; each data change is a `NativeSample`.
 *  - The gateway's existing process path: values of the released tags still travel as process readings
 *    (`/gw/v1/process-readings`, journal first, tablets 0820), so G-06 entries stand on them unchanged; the driver
 *    offers the same read/write surface as ProcessSimDriver (setpoint write, then read-back).
 *  - Native data: samples per (unit, tag) are cut into series chunks (`SeriesChunker`) and journalled; alarm
 *    occurrences (Alarms and Conditions) and equipment events become `opcua.alarm` / `opcua.equipment_event` messages.
 *    The gateway serves them to the server's OPCUA adapter worker through the 6a feed protocol (feed, heartbeat,
 *    reconciliation), each in an InboundEnvelope with the gateway's per-feed sequence number.
 *  - Recipe version read (`RECIPE_VERSION_TAG`) before the step's downloads; a mismatch is a RECIPE_MISMATCH event.
 *  - Faults the simulator injects and the driver must surface (DI-31): feed gap, stale value (status or unchanged
 *    source time), recipe mismatch, drift, endpoint certificate change.
 */
import { EventEmitter } from 'node:events';
import {
  ENDPOINT_LOCATION_NODE,
  EquipmentAlarmV1,
  EquipmentEventV1,
  NativeSample,
  OpcuaEndpoint,
  opcuaActiveAlarmsNodeId,
  opcuaNodeId,
  opcuaSetpointNodeId,
  parseOpcuaNodeId,
  qualityOfStatus,
  RECIPE_VERSION_TAG,
  SERIES_CHUNK_MAX_SAMPLES,
  seriesChunkHash,
  OPCUA_OFFLINE_BUFFER_US,
  type OpcuaEndpointSessionV1,
  type SeriesChunkV1,
} from '@ebmr/integration-sdk/adapter';
import { tagsOf, type EquipmentKind, type ProcessReadingNative, type SimSample } from '@ebmr/integration-sdk/process';
import type { GatewayClock } from '../clock.ts';

/** One data change as the transport reports it (OPC UA DataValue, values as text). */
export interface OpcuaDataChange {
  nodeId: string;
  sample: NativeSample;
  /** Slice 7b-1 (6jc-R13): why the transport marked the sample BAD (a value without any timestamp), or absent. */
  problem?: string;
}

/** The port the driver uses; node-opcua is wrapped behind it (builder A), a fake in tests. */
export interface OpcuaTransport {
  /** Opens a SignAndEncrypt session; resolves with the SHA-256 (hex) of the server certificate's DER bytes. */
  connect(endpoint: OpcuaEndpoint): Promise<{ serverCertificateThumbprint: string }>;
  subscribe(nodeIds: readonly string[], samplingIntervalMs: number, onChange: (c: OpcuaDataChange) => void): Promise<void>;
  /** Alarms and Conditions and other events of the server, already mapped to the contract's shapes. */
  subscribeEvents(onAlarm: (a: EquipmentAlarmV1) => void, onEvent: (e: EquipmentEventV1) => void): Promise<void>;
  read(nodeId: string): Promise<NativeSample>;
  /** Slice 6b builder A (additive): a text node (the endpoint's location, a recipe version) as the server holds it, or null. */
  readText?(nodeId: string): Promise<string | null>;
  /** Slice 6b builder A (additive): called once when an open session is lost (link cut, server gone). */
  onConnectionLost?(cb: (reason: string) => void): void;
  /** Writes the raw value text to a node (a setpoint); the read-back is a separate read. */
  write(nodeId: string, raw: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpcuaDriverOptions {
  /** The gateway's code for this endpoint. */
  code: string;
  endpoint: OpcuaEndpoint;
  /** The kind of each unit the endpoint serves (its tags: process/tags.ts tagsOf). */
  equipment: Readonly<Record<string, EquipmentKind>>;
  transport: OpcuaTransport;
  clock: GatewayClock;
  samplingIntervalMs?: number;
  /** A chunk closes at this many samples or this span of source time, whichever comes first. */
  chunkMaxSamples?: number;
  chunkMaxSpanUs?: bigint;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Slice 6b builder A (additive): where the native data go (the gateway's OPC UA feed, ../opcua-feed.ts). */
  sink?: OpcuaSink;
  /** The next chunk number of (unit, tag), continued from the feed's journal across restarts (default 1). */
  nextChunkNo?: (equipmentCode: string, tag: string) => bigint;
  /** A unit that sends no data change for this long is a feed gap (alarmed once until data come again). */
  gapAfterMs?: number;
  /** The site's offline buffer (setting integration.opcua_offline_buffer_s; default OPCUA_OFFLINE_BUFFER_US, 7 days). */
  offlineBufferUs?: bigint;
}

/** Where the driver hands what it receives: each is journalled by the feed before anything else happens to it. */
export interface OpcuaSink {
  session(s: OpcuaEndpointSessionV1): void;
  chunk(c: SeriesChunkV1): void;
  alarm(a: EquipmentAlarmV1): void;
  event(e: EquipmentEventV1): void;
  /**
   * Phase 7 slice 7b-1 (DI-32, DI-31): each sample of an open chunk, on receipt, with the number the chunk will have; the
   * feed spools it (../opcua-feed.ts), so a crash before the chunk closes does not lose it.
   */
  sample?(s: SpooledSample): void;
}

/** A sample of an open chunk as the feed's spool keeps it (the chunk's subject, tag, unit and number, and the sample). */
export interface SpooledSample {
  subjectKind: SeriesChunkV1['subjectKind'];
  subjectCode: string;
  tag: string;
  unit: string;
  chunkNo: string;
  sample: NativeSample;
}

/** Device states of an OPC UA endpoint (the scale and process states plus the certificate check). */
export type OpcuaEndpointState = 'CONNECTING' | 'ONLINE' | 'OFFLINE' | 'CERTIFICATE_MISMATCH';

export interface OpcuaDriverAlarm {
  kind:
    | 'CERTIFICATE_MISMATCH' | 'INSECURE_ENDPOINT' | 'STALE_VALUE' | 'FEED_GAP' | 'RECIPE_MISMATCH' | 'DISCONNECTED' | 'OUT_OF_ORDER' | 'WRONG_UNIT' | 'MALFORMED'
    // Slice 7b-1 (6jc-R13, DI-32): a value without any timestamp (kept BAD), a source time before the session's start.
    | 'MISSING_TIMESTAMP' | 'BEFORE_SESSION';
  endpointCode: string;
  message: string;
  details: Record<string, string>;
}

/** Why an endpoint must not be used (DI-20, D-P6b-2), or null: its enrolment is sound and the certificate is the enrolled one. */
export function certificateProblem(endpoint: unknown, serverCertificateThumbprint: string): string | null {
  const parsed = OpcuaEndpoint.safeParse(endpoint);
  if (!parsed.success) return `the endpoint is not enrolled for SignAndEncrypt with a certificate thumbprint: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
  if (serverCertificateThumbprint !== parsed.data.certificateThumbprint) {
    return `the server certificate ${serverCertificateThumbprint.slice(0, 12)}... is not the enrolled ${parsed.data.certificateThumbprint.slice(0, 12)}... (certificate changed)`;
  }
  return null;
}

/**
 * Cuts the samples of one (subject, tag) into series chunks: numbered 1, 2, 3, ... per subject and tag, closed at the
 * sample limit or span, with the hash the database recomputes. The chunk numbers continue across restarts from the
 * gateway's journal (`nextChunkNo`).
 */
export class SeriesChunker {
  private samples: NativeSample[] = [];
  private nextNo: bigint;

  constructor(
    readonly subject: { kind: SeriesChunkV1['subjectKind']; code: string },
    readonly tag: string,
    readonly unit: string,
    nextChunkNo: bigint,
    private readonly maxSamples = SERIES_CHUNK_MAX_SAMPLES,
    private readonly maxSpanUs = 60_000_000n,
  ) {
    this.nextNo = nextChunkNo;
  }

  /** Adds a sample; returns the closed chunk when this sample closes one (the sample then opens the next). */
  add(sample: NativeSample): SeriesChunkV1 | null {
    const first = this.samples[0];
    let closed: SeriesChunkV1 | null = null;
    if (first && (this.samples.length >= this.maxSamples || BigInt(sample.sourceTime) - BigInt(first.sourceTime) >= this.maxSpanUs)) closed = this.flush();
    this.samples.push(sample);
    return closed;
  }

  /** The number the open chunk will have when it closes (the next chunk's number when none is open). */
  openChunkNo(): bigint {
    return this.nextNo;
  }

  /** The source time of the open chunk's first sample (null when none is open): a quiet tag's chunk is closed by span. */
  openSinceUs(): bigint | null {
    const first = this.samples[0];
    return first ? BigInt(first.sourceTime) : null;
  }

  /** Closes the open chunk (at stop or on a quiet tag); null when it holds no sample. */
  flush(): SeriesChunkV1 | null {
    if (this.samples.length === 0) return null;
    const body = { subjectKind: this.subject.kind, subjectCode: this.subject.code, tag: this.tag, unit: this.unit, chunkNo: this.nextNo.toString(), samples: this.samples };
    this.samples = [];
    this.nextNo += 1n;
    return { ...body, chunkHash: seriesChunkHash(body) };
  }
}

/** Whether a sample is unusable as a current value: a BAD or UNCERTAIN status (the server keeps it, flagged). */
export function sampleIsDoubtful(sample: NativeSample): boolean {
  return qualityOfStatus(sample.status) !== 'GOOD';
}

// ---------------------------------------------------------------------------------------------------------------
// The driver (slice 6b, builder A)
// ---------------------------------------------------------------------------------------------------------------

/** One unit's latest values as the process path reads them (the ProcessGateway's poll), with their original records. */
export type OpcuaUnitRead =
  | {
      ok: true;
      sample: SimSample;
      receivedWallUs: bigint;
      serial: string;
      native: { values: Record<string, ProcessReadingNative>; setpoints: Record<string, ProcessReadingNative> };
    }
  | { ok: false; error: 'OFFLINE' | 'REFUSED' | 'CERTIFICATE_MISMATCH'; message: string };

export type OpcuaUnitWrite = { ok: true } | { ok: false; error: 'OFFLINE' | 'REFUSED'; message: string };

/** The view of one unit the process path drives like a ProcessSimDriver (read, write, state and alarm events). */
export interface OpcuaUnit {
  readonly code: string;
  readonly equipment: EquipmentKind;
  read(): Promise<OpcuaUnitRead>;
  write(tag: string, value: string): Promise<OpcuaUnitWrite>;
}

const SET_SUFFIX = '/setpoint';

/**
 * The OPC UA client driver of one endpoint (header). Events: 'state' (OpcuaEndpointState), 'alarm' (OpcuaDriverAlarm).
 * Every data change is checked before it is used: a sample that is not a NativeSample, of a node the driver did not
 * subscribe, out of source-time order or repeated (the same source time again) is never chunked and is alarmed; a
 * doubtful status (UNCERTAIN, BAD) is kept as received in the series (a BAD sample shows no value) and alarmed as a stale
 * value once per episode. Nothing the endpoint sends is dropped without an alarm (DI-31).
 */
export class OpcuaDriver extends EventEmitter {
  state: OpcuaEndpointState = 'CONNECTING';
  /** The SHA-256 of the certificate the server presented at the last connect. */
  presentedThumbprint: string | null = null;
  private readonly units: ReadonlyMap<string, EquipmentKind>;
  private readonly latest = new Map<string, NativeSample>();
  private readonly setpoints = new Map<string, NativeSample>();
  private readonly activeAlarms = new Map<string, string>();
  private readonly recipe = new Map<string, string>();
  private readonly expectedRecipe = new Map<string, string>();
  private readonly scans = new Map<string, bigint>();
  private readonly lastChangeUs = new Map<string, bigint>();
  private readonly gapAlarmed = new Set<string>();
  private readonly doubtful = new Set<string>();
  private readonly chunkers = new Map<string, SeriesChunker>();
  private stopped = false;
  private backoff: number;
  private timer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private session = 0;
  /** When the current session opened (its openedAt, the gateway's clock): no older sample enters the series (6jc-R13). */
  private sessionOpenedUs: bigint | null = null;
  private reportedMismatch: string | null = null;
  /** Nodes whose first notification after a (re)subscription is still due: a repeat of the known sample is no news. */
  private readonly resubscribed = new Set<string>();

  constructor(readonly options: OpcuaDriverOptions) {
    super();
    this.units = new Map(Object.entries(options.equipment));
    this.backoff = options.backoffInitialMs ?? 500;
    for (const code of this.units.keys()) if (!options.endpoint.equipmentCodes.includes(code)) throw new Error(`unit ${code} is not one of endpoint ${options.code}'s enrolled units`);
  }

  start(): void {
    this.stopped = false;
    this.connecting = this.connect();
    this.tick = setInterval(() => this.housekeeping(), Math.max(200, Math.min(1000, this.options.gapAfterMs ?? 5000)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.tick) clearInterval(this.tick);
    await this.connecting?.catch(() => undefined);
    this.flushAll();
    await this.options.transport.close().catch(() => undefined);
    this.setState('OFFLINE');
  }

  /** The recipe version the running step expects on `unit` (compared with the unit's recipe.version node). */
  expectRecipe(unit: string, version: string | null): void {
    if (version === null) this.expectedRecipe.delete(unit);
    else this.expectedRecipe.set(unit, version);
    this.checkRecipe(unit);
  }

  /** The unit's recipe version as last read, or null. */
  recipeVersion(unit: string): string | null {
    return this.recipe.get(unit) ?? null;
  }

  /** The process-path view of unit `code`. */
  unit(code: string): OpcuaUnit {
    const equipment = this.units.get(code);
    if (!equipment) throw new Error(`${code} is not a unit of endpoint ${this.options.code}`);
    return { code, equipment, read: () => Promise.resolve(this.readUnit(code, equipment)), write: (tag, value) => this.writeUnit(code, tag, value) };
  }

  /** Closes every open chunk (stop, a lost session): the samples received so far are never held back. */
  flushAll(): void {
    for (const c of this.chunkers.values()) {
      const chunk = c.flush();
      if (chunk) this.options.sink?.chunk(chunk);
    }
  }

  // -------------------------------------------------------------------------------------------------------------

  private setState(s: OpcuaEndpointState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private alarm(kind: OpcuaDriverAlarm['kind'], message: string, details: Record<string, string> = {}): void {
    const a: OpcuaDriverAlarm = { kind, endpointCode: this.options.code, message: `${this.options.code}: ${message}`, details };
    this.emit('alarm', a);
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.backoffMaxMs ?? 30_000);
    this.timer = setTimeout(() => {
      this.connecting = this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const { endpoint, transport, sink } = this.options;
    this.setState('CONNECTING');
    const session = ++this.session;
    let thumbprint: string;
    try {
      thumbprint = (await transport.connect(endpoint)).serverCertificateThumbprint;
    } catch (e) {
      this.setState('OFFLINE');
      this.alarm('DISCONNECTED', `cannot open a SignAndEncrypt session: ${e instanceof Error ? e.message : String(e)}`, { url: endpoint.endpointUrl });
      this.retry();
      return;
    }
    this.presentedThumbprint = thumbprint;
    const openedUs = this.options.clock.wallUs();
    const problem = certificateProblem(endpoint, thumbprint);
    const report = (reportedLocation: string | null): OpcuaEndpointSessionV1 => ({
      endpointCode: this.options.code, endpointUrl: endpoint.endpointUrl, securityMode: endpoint.securityMode, securityPolicy: endpoint.securityPolicy,
      certificateThumbprint: thumbprint, reportedLocation, equipmentCodes: [...this.units.keys()], openedAt: openedUs.toString(),
    });
    if (problem) {
      // DI-20: nothing is read from an endpoint that is not the enrolled one; the session is still reported (once per
      // certificate presented, not at every retry), so the database records the refusal with its alarm.
      if (this.reportedMismatch !== thumbprint) sink?.session(report(null));
      this.reportedMismatch = thumbprint;
      this.setState('CERTIFICATE_MISMATCH');
      this.alarm('CERTIFICATE_MISMATCH', problem, { presented: thumbprint, enrolled: endpoint.certificateThumbprint });
      await transport.close().catch(() => undefined);
      this.retry();
      return;
    }
    try {
      const location = transport.readText ? await transport.readText(ENDPOINT_LOCATION_NODE) : null;
      sink?.session(report(location !== null && /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(location) ? location : null));
      this.sessionOpenedUs = openedUs;
      this.reportedMismatch = null;
      transport.onConnectionLost?.((reason) => this.lost(session, reason));
      for (const unit of this.units.keys()) {
        const v = transport.readText ? await transport.readText(opcuaNodeId(unit, RECIPE_VERSION_TAG)) : null;
        if (v !== null) this.recipe.set(unit, v);
        this.checkRecipe(unit);
      }
      const nodes: string[] = [];
      for (const [unit, kind] of this.units) {
        for (const t of tagsOf(kind)) {
          nodes.push(opcuaNodeId(unit, t.tag));
          if (t.setpoint) nodes.push(opcuaSetpointNodeId(unit, t.tag));
        }
        nodes.push(opcuaActiveAlarmsNodeId(unit), opcuaNodeId(unit, RECIPE_VERSION_TAG));
      }
      for (const n of nodes) this.resubscribed.add(n);
      await transport.subscribe(nodes, this.options.samplingIntervalMs ?? 250, (c) => this.onChange(c));
      await transport.subscribeEvents(
        (a) => this.onAlarm(a),
        (e) => this.onEvent(e),
      );
    } catch (e) {
      this.setState('OFFLINE');
      this.alarm('DISCONNECTED', `the session could not be set up: ${e instanceof Error ? e.message : String(e)}`);
      await transport.close().catch(() => undefined);
      this.retry();
      return;
    }
    const now = this.options.clock.monoUs();
    for (const unit of this.units.keys()) this.lastChangeUs.set(unit, now);
    this.backoff = this.options.backoffInitialMs ?? 500;
    this.setState('ONLINE');
  }

  private lost(session: number, reason: string): void {
    if (session !== this.session || this.stopped || this.state !== 'ONLINE') return;
    // The samples received before the cut are kept: the open chunks close now; the gap in source time stays visible.
    this.flushAll();
    this.setState('OFFLINE');
    this.alarm('DISCONNECTED', `the session was lost: ${reason}; reconnecting`, {});
    void this.options.transport.close().catch(() => undefined);
    this.retry();
  }

  private chunker(unit: string, tag: string, unitOfTag: string): SeriesChunker {
    const key = `${unit}|${tag}`;
    let c = this.chunkers.get(key);
    if (!c) {
      c = new SeriesChunker({ kind: 'EQUIPMENT', code: unit }, tag, unitOfTag, this.options.nextChunkNo?.(unit, tag) ?? 1n, this.options.chunkMaxSamples ?? SERIES_CHUNK_MAX_SAMPLES, this.options.chunkMaxSpanUs ?? 60_000_000n);
      this.chunkers.set(key, c);
    }
    return c;
  }

  private onChange(c: OpcuaDataChange): void {
    const parsedSample = NativeSample.safeParse(c.sample);
    let nodeId = c.nodeId;
    const isSetpoint = nodeId.endsWith(SET_SUFFIX);
    if (isSetpoint) nodeId = nodeId.slice(0, -SET_SUFFIX.length);
    // The active-alarms node: a text list, not a sample.
    for (const unit of this.units.keys()) {
      if (c.nodeId === opcuaActiveAlarmsNodeId(unit)) {
        this.activeAlarms.set(unit, c.sample.raw === '-' ? '' : c.sample.raw);
        return;
      }
    }
    const node = parseOpcuaNodeId(nodeId);
    const kind = node ? this.units.get(node.equipmentCode) : undefined;
    if (!node || !kind) {
      this.alarm('WRONG_UNIT', `a data change of node ${c.nodeId.slice(0, 160)} that the driver did not subscribe was refused`, { nodeId: c.nodeId.slice(0, 200) });
      return;
    }
    if (node.tag === RECIPE_VERSION_TAG) {
      this.recipe.set(node.equipmentCode, c.sample.raw);
      this.touch(node.equipmentCode);
      this.checkRecipe(node.equipmentCode);
      return;
    }
    const spec = tagsOf(kind).find((t) => t.tag === node.tag);
    if (!parsedSample.success || !spec || (isSetpoint && !spec.setpoint)) {
      this.alarm('MALFORMED', `a data change of ${node.equipmentCode}/${node.tag} is not a sample the driver can keep`, { nodeId: c.nodeId.slice(0, 200) });
      return;
    }
    const sample = parsedSample.data;
    if (isSetpoint) {
      this.setpoints.set(`${node.equipmentCode}|${node.tag}`, sample);
      return;
    }
    const key = `${node.equipmentCode}|${node.tag}`;
    const prev = this.latest.get(key);
    const first = this.resubscribed.delete(c.nodeId);
    if (first && prev && prev.sourceTime === sample.sourceTime && prev.raw === sample.raw && prev.status === sample.status) return; // the current value re-sent at subscription
    if (prev && BigInt(sample.sourceTime) === BigInt(prev.sourceTime)) {
      // The same source time again: the value did not update at the source (a stale value).
      this.markDoubtful(key, `${node.equipmentCode}/${node.tag} repeats source time ${sample.sourceTime}: the value is stale`, sample);
      return;
    }
    if (prev && BigInt(sample.sourceTime) < BigInt(prev.sourceTime)) {
      this.alarm('OUT_OF_ORDER', `${node.equipmentCode}/${node.tag}: source time ${sample.sourceTime} is before the last ${prev.sourceTime}; the sample is not taken into the series`, {
        tag: node.tag, raw: sample.raw, status: sample.status, sourceTime: sample.sourceTime,
      });
      return;
    }
    if (c.problem) {
      // 6jc-R13: dated at receipt and BAD (the transport); kept in the series as received, alarmed with the reason.
      this.alarm('MISSING_TIMESTAMP', `${node.equipmentCode}/${node.tag}: ${c.problem}`, { tag: node.tag, raw: sample.raw, sourceTime: sample.sourceTime });
    }
    if (qualityOfStatus(sample.status) !== 'GOOD') this.markDoubtful(key, `${node.equipmentCode}/${node.tag} reports status ${sample.status}`, sample);
    else this.doubtful.delete(key);
    this.latest.set(key, sample);
    this.touch(node.equipmentCode);
    // 6jc-R13 (DI-32; golden regression fix round 2): the database refuses a source time more than the offline buffer
    // before the session's start (recipe-core 1235). Within it the sample is genuine (the current value of a tag
    // unchanged since before the session, sent at subscription; a value held while the gateway was down) and enters the
    // series as received. Older, it stays the tag's current value but is not taken into the series, with an alarm, so no
    // chunk is refused.
    const buffer = this.options.offlineBufferUs ?? OPCUA_OFFLINE_BUFFER_US;
    if (this.sessionOpenedUs !== null && BigInt(sample.sourceTime) < this.sessionOpenedUs - buffer) {
      this.alarm('BEFORE_SESSION', `${node.equipmentCode}/${node.tag}: source time ${sample.sourceTime} is more than ${(buffer / 1_000_000n).toString()} s before this session opened (${this.sessionOpenedUs.toString()}); kept as the current value, not taken into the series`, {
        tag: node.tag, raw: sample.raw, status: sample.status, sourceTime: sample.sourceTime,
      });
      return;
    }
    const chunker = this.chunker(node.equipmentCode, node.tag, spec.unit);
    const closed = chunker.add(sample);
    if (closed) this.options.sink?.chunk(closed);
    // Slice 7b-1: the sample is spooled with its open chunk's number (the closed chunk, if any, is journalled first).
    this.options.sink?.sample?.({ subjectKind: 'EQUIPMENT', subjectCode: node.equipmentCode, tag: node.tag, unit: spec.unit, chunkNo: chunker.openChunkNo().toString(), sample });
  }

  private markDoubtful(key: string, message: string, sample: NativeSample): void {
    if (this.doubtful.has(key)) return;
    this.doubtful.add(key);
    this.alarm('STALE_VALUE', message, { key, status: sample.status, sourceTime: sample.sourceTime });
  }

  private touch(unit: string): void {
    this.scans.set(unit, (this.scans.get(unit) ?? 0n) + 1n);
    this.lastChangeUs.set(unit, this.options.clock.monoUs());
    if (this.gapAlarmed.delete(unit)) this.emit('feed-restored', unit);
  }

  private onAlarm(a: EquipmentAlarmV1): void {
    const p = EquipmentAlarmV1.safeParse(a);
    if (!p.success) {
      this.alarm('MALFORMED', `an alarm occurrence is not in the contract's form: ${p.error.issues[0]?.message ?? 'invalid'}`);
      return;
    }
    if (p.data.subjectKind !== 'EQUIPMENT' || !this.units.has(p.data.subjectCode)) {
      this.alarm('WRONG_UNIT', `an alarm names ${p.data.subjectCode}, which this endpoint does not serve; refused`, { subject: p.data.subjectCode, occurrence: p.data.occurrenceId });
      return;
    }
    this.options.sink?.alarm(p.data);
  }

  private onEvent(e: EquipmentEventV1): void {
    const p = EquipmentEventV1.safeParse(e);
    if (!p.success) {
      this.alarm('MALFORMED', `an equipment event is not in the contract's form: ${p.error.issues[0]?.message ?? 'invalid'}`);
      return;
    }
    if (!this.units.has(p.data.equipmentCode)) {
      this.alarm('WRONG_UNIT', `an event names ${p.data.equipmentCode}, which this endpoint does not serve; refused`, { subject: p.data.equipmentCode, event: p.data.eventId });
      return;
    }
    this.options.sink?.event(p.data);
  }

  private checkRecipe(unit: string): void {
    const want = this.expectedRecipe.get(unit);
    const have = this.recipe.get(unit);
    if (want === undefined || have === undefined || want === have) return;
    const occurredAt = this.options.clock.wallUs().toString();
    this.alarm('RECIPE_MISMATCH', `${unit} runs recipe ${have}; the step expects ${want}`, { unit, expected: want, actual: have });
    this.options.sink?.event({
      equipmentCode: unit, eventId: `recipe-mismatch-${unit}-${occurredAt}`, kind: 'RECIPE_MISMATCH', state: null, recipeVersion: have.slice(0, 64),
      message: `Recipe ${have} loaded; the step expects ${want}`, occurredAt,
    });
  }

  /** Periodic: feed gaps (a unit silent for gapAfterMs while online) and the span close of quiet chunks. */
  private housekeeping(): void {
    if (this.state !== 'ONLINE') return;
    const now = this.options.clock.monoUs();
    const gap = BigInt(this.options.gapAfterMs ?? 5000) * 1000n;
    for (const unit of this.units.keys()) {
      const last = this.lastChangeUs.get(unit) ?? now;
      if (now - last >= gap && !this.gapAlarmed.has(unit)) {
        this.gapAlarmed.add(unit);
        this.alarm('FEED_GAP', `${unit} sent no data change for ${(this.options.gapAfterMs ?? 5000).toString()} ms`, { unit });
      }
    }
    const span = this.options.chunkMaxSpanUs ?? 60_000_000n;
    const wall = this.options.clock.wallUs();
    for (const c of this.chunkers.values()) {
      const since = c.openSinceUs();
      if (since !== null && wall - since >= span) {
        const chunk = c.flush();
        if (chunk) this.options.sink?.chunk(chunk);
      }
    }
  }

  private readUnit(code: string, kind: EquipmentKind): OpcuaUnitRead {
    if (this.state === 'CERTIFICATE_MISMATCH') return { ok: false, error: 'CERTIFICATE_MISMATCH', message: `${this.options.code}: certificate mismatch` };
    if (this.state !== 'ONLINE') return { ok: false, error: 'OFFLINE', message: `${this.options.code} is ${this.state}` };
    const native = { values: {} as Record<string, ProcessReadingNative>, setpoints: {} as Record<string, ProcessReadingNative> };
    const nativeOf = (s: NativeSample): ProcessReadingNative => ({ raw: s.raw, status: s.status, deviceTime: s.sourceTime, endpointCode: this.options.code });
    const values: SimSample['values'] = [];
    const setpoints: SimSample['setpoints'] = [];
    for (const t of tagsOf(kind)) {
      const s = this.latest.get(`${code}|${t.tag}`);
      if (s && s.value !== null) {
        const q = qualityOfStatus(s.status);
        values.push({ tag: t.tag, value: s.value, unit: t.unit, quality: q });
        native.values[t.tag] = nativeOf(s);
      }
      const sp = this.setpoints.get(`${code}|${t.tag}`);
      if (t.setpoint && sp && sp.value !== null && qualityOfStatus(sp.status) === 'GOOD') {
        setpoints.push({ tag: t.tag, value: sp.value, unit: t.unit });
        native.setpoints[t.tag] = nativeOf(sp);
      }
    }
    const alarms = (this.activeAlarms.get(code) ?? '')
      .split(';')
      .filter((x) => x.includes('|'))
      .map((x) => ({ code: x.slice(0, x.indexOf('|')), tag: x.slice(x.indexOf('|') + 1) }))
      .filter((a) => /^[A-Z][A-Z0-9_]{1,47}$/.test(a.code) && values.some((v) => v.tag === a.tag));
    const sample: SimSample = { id: '0', ok: true, scan: (this.scans.get(code) ?? 0n).toString(), running: true, values, setpoints, alarms };
    return { ok: true, sample, receivedWallUs: this.options.clock.wallUs(), serial: code, native };
  }

  private async writeUnit(code: string, tag: string, value: string): Promise<OpcuaUnitWrite> {
    if (this.state !== 'ONLINE') return { ok: false, error: 'OFFLINE', message: `${this.options.code} is ${this.state}` };
    const kind = this.units.get(code);
    if (!kind || !tagsOf(kind).some((t) => t.tag === tag && t.setpoint)) return { ok: false, error: 'REFUSED', message: `${tag} is no setpoint tag of ${code}` };
    const node = opcuaSetpointNodeId(code, tag);
    try {
      await this.options.transport.write(node, value);
      // The read-back is a fresh read of the device, not the subscription's last value.
      const back = await this.options.transport.read(node);
      const parsed = NativeSample.safeParse(back);
      if (parsed.success) this.setpoints.set(`${code}|${tag}`, parsed.data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'REFUSED', message: e instanceof Error ? e.message : String(e) };
    }
  }
}
