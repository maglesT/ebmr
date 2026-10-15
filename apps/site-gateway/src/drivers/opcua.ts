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
import {
  OpcuaEndpoint,
  qualityOfStatus,
  SERIES_CHUNK_MAX_SAMPLES,
  seriesChunkHash,
  type EquipmentAlarmV1,
  type EquipmentEventV1,
  type NativeSample,
  type SeriesChunkV1,
} from '@ebmr/integration-sdk/adapter';
import type { EquipmentKind } from '@ebmr/integration-sdk/process';
import type { GatewayClock } from '../clock.ts';

/** One data change as the transport reports it (OPC UA DataValue, values as text). */
export interface OpcuaDataChange {
  nodeId: string;
  sample: NativeSample;
}

/** The port the driver uses; node-opcua is wrapped behind it (builder A), a fake in tests. */
export interface OpcuaTransport {
  /** Opens a SignAndEncrypt session; resolves with the SHA-256 (hex) of the server certificate's DER bytes. */
  connect(endpoint: OpcuaEndpoint): Promise<{ serverCertificateThumbprint: string }>;
  subscribe(nodeIds: readonly string[], samplingIntervalMs: number, onChange: (c: OpcuaDataChange) => void): Promise<void>;
  /** Alarms and Conditions and other events of the server, already mapped to the contract's shapes. */
  subscribeEvents(onAlarm: (a: EquipmentAlarmV1) => void, onEvent: (e: EquipmentEventV1) => void): Promise<void>;
  read(nodeId: string): Promise<NativeSample>;
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
}

/** Device states of an OPC UA endpoint (the scale and process states plus the certificate check). */
export type OpcuaEndpointState = 'CONNECTING' | 'ONLINE' | 'OFFLINE' | 'CERTIFICATE_MISMATCH';

export interface OpcuaDriverAlarm {
  kind: 'CERTIFICATE_MISMATCH' | 'INSECURE_ENDPOINT' | 'STALE_VALUE' | 'FEED_GAP' | 'RECIPE_MISMATCH' | 'DISCONNECTED';
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
