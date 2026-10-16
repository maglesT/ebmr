/**
 * The OpcuaTransport on node-opcua (Phase 6 slice 6b, builder A; D-P6b-1: node-opcua pinned exactly, used only by the
 * gateway and the simulator; no kernel or database import). It opens SignAndEncrypt sessions only (D-P6b-2) with the
 * gateway's application instance certificate (kept in `pkiDir`), and reports the SHA-256 of the server certificate the
 * channel was opened with; the driver compares it with the enrolled thumbprint (DI-20). The PKI's own trust list accepts
 * the server certificate so that the pinned thumbprint, not a trust list, is the control (and a changed certificate is
 * reported, not silently refused).
 *
 * Values travel as the source sent them: the raw text of the variant (a Double as its shortest round-trip decimal, an
 * integer as its digits, never rounded to the tag's digits), the status code as 0xXXXXXXXX, the source and server
 * timestamps in microseconds. The value shown is the raw value's plain decimal form, or null for a BAD status or a raw
 * value that is not a number (DI-32, D-P6b-0-10).
 *
 * Node ids of the eBMR's tag map (`nsu=<uri>;s=...`) are mapped to the server's namespace index read at connect.
 * Alarm occurrences and equipment events arrive as JSON values of each unit's `_events` node (opcuaEventsNodeId,
 * D-P6b-A-3), monitored with a queue so every change is delivered.
 */
import { createHash } from 'node:crypto';
import {
  AttributeIds,
  ClientMonitoredItem,
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  TimestampsToReturn,
  type ClientSession,
  type ClientSubscription,
  type DataValue,
} from 'node-opcua';
import {
  canonicalDecimal,
  OPCUA_NAMESPACE_URI,
  opcuaEventsNodeId,
  qualityOfStatus,
  type EquipmentAlarmV1,
  type EquipmentEventV1,
  type NativeSample,
  type OpcuaEndpoint,
} from '@ebmr/integration-sdk/adapter';
import type { OpcuaDataChange, OpcuaTransport } from './opcua.ts';

export interface NodeOpcuaTransportOptions {
  /** The gateway's PKI folder: its application instance certificate and key, created on first use. */
  pkiDir: string;
  /** The units whose `_events` node is monitored. */
  units: readonly string[];
  applicationName?: string;
  /** How long a connect may take before it fails (ms). */
  connectTimeoutMs?: number;
}

const URI_PREFIX = `nsu=${OPCUA_NAMESPACE_URI};`;

/** Microseconds of an OPC UA DateTime as node-opcua gives it (a Date plus picoseconds), or null. */
function micros(d: Date | null | undefined, picos: number | null | undefined): bigint | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return BigInt(d.getTime()) * 1000n + BigInt(Math.floor((picos ?? 0) / 1_000_000));
}

/** The raw text of a variant value as the source sent it. */
function rawText(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === 'number')) {
    // node-opcua carries 64-bit integers as [high, low] words.
    return ((BigInt(value[0] as number) << 32n) + BigInt((value[1] as number) >>> 0)).toString();
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return value === null || value === undefined ? '-' : JSON.stringify(value).slice(0, 64);
}

/**
 * The first (leaf) certificate of a DER buffer that may hold a chain: one DER SEQUENCE with its length header. The
 * thumbprint is of these bytes (the server's own certificate), as the enrolment records it.
 */
export function leafCertificate(der: Buffer | null | undefined): Buffer | null {
  if (!der || der.length < 2 || der[0] !== 0x30) return null;
  const b1 = der[1] ?? 0;
  if (b1 < 0x80) return der.subarray(0, 2 + b1);
  const n = b1 & 0x7f;
  if (n < 1 || n > 4 || der.length < 2 + n) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + (der[2 + i] ?? 0);
  return der.length >= 2 + n + len ? der.subarray(0, 2 + n + len) : null;
}

export function sampleOf(dv: DataValue): NativeSample {
  const status = `0x${(dv.statusCode.value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  const raw = rawText(dv.value.value).slice(0, 64) || '-';
  const decimal = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$/.test(raw) ? canonicalDecimal(raw) : null;
  const source = micros(dv.sourceTimestamp, dv.sourcePicoseconds) ?? micros(dv.serverTimestamp, dv.serverPicoseconds) ?? 0n;
  const server = micros(dv.serverTimestamp, dv.serverPicoseconds);
  return { sourceTime: source.toString(), serverTime: server === null ? null : server.toString(), raw, value: qualityOfStatus(status) === 'BAD' ? null : decimal, status };
}

export class NodeOpcuaTransport implements OpcuaTransport {
  private client: OPCUAClient | null = null;
  private session: ClientSession | null = null;
  private subscription: ClientSubscription | null = null;
  private ns = -1;
  private lostCb: ((reason: string) => void) | null = null;
  private lostFired = false;

  constructor(private readonly options: NodeOpcuaTransportOptions) {}

  /** The server's node id of one of the eBMR's node ids. */
  private nodeId(id: string): string {
    if (!id.startsWith(URI_PREFIX)) throw new Error(`${id} is not a node of the eBMR's tag map`);
    if (this.ns < 0) throw new Error('the session is not open');
    return `ns=${this.ns.toString()};${id.slice(URI_PREFIX.length)}`;
  }

  async connect(endpoint: OpcuaEndpoint): Promise<{ serverCertificateThumbprint: string }> {
    await this.close();
    this.lostFired = false;
    const clientCertificateManager = new OPCUACertificateManager({ rootFolder: this.options.pkiDir, automaticallyAcceptUnknownCertificate: true });
    await clientCertificateManager.initialize();
    const client = OPCUAClient.create({
      applicationName: this.options.applicationName ?? 'eBMR site gateway',
      securityMode: MessageSecurityMode.SignAndEncrypt,
      securityPolicy: SecurityPolicy[endpoint.securityPolicy],
      endpointMustExist: false,
      keepSessionAlive: true,
      requestedSessionTimeout: 30_000,
      connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 },
      clientCertificateManager,
      defaultSecureTokenLifetime: 600_000,
      transportTimeout: this.options.connectTimeoutMs ?? 5000,
    });
    const lost = (reason: string) => {
      if (this.lostFired || this.client !== client) return;
      this.lostFired = true;
      this.lostCb?.(reason);
    };
    client.on('connection_lost', () => lost('connection lost'));
    client.on('backoff', () => lost('connection lost (reconnecting)'));
    this.client = client;
    await client.connect(endpoint.endpointUrl);
    const session = await client.createSession();
    session.on('keepalive_failure', () => lost('session keep-alive failed'));
    session.on('session_closed', () => lost('session closed by the server'));
    this.session = session;
    const presented = client.serverCertificate as Buffer | Buffer[] | null | undefined;
    const cert = leafCertificate(Array.isArray(presented) ? presented[0] : presented);
    if (!cert) throw new Error('the server presented no certificate');
    const namespaces = await session.readNamespaceArray();
    this.ns = namespaces.indexOf(OPCUA_NAMESPACE_URI);
    if (this.ns < 0) throw new Error(`the server does not publish the namespace ${OPCUA_NAMESPACE_URI}`);
    return { serverCertificateThumbprint: createHash('sha256').update(cert).digest('hex') };
  }

  onConnectionLost(cb: (reason: string) => void): void {
    this.lostCb = cb;
  }

  async subscribe(nodeIds: readonly string[], samplingIntervalMs: number, onChange: (c: OpcuaDataChange) => void): Promise<void> {
    const sub = await this.ensureSubscription(samplingIntervalMs);
    for (const id of nodeIds) {
      const item = ClientMonitoredItem.create(sub, { nodeId: this.nodeId(id), attributeId: AttributeIds.Value }, { samplingInterval: samplingIntervalMs, discardOldest: false, queueSize: 100 }, TimestampsToReturn.Both);
      item.on('changed', (dv: DataValue) => onChange({ nodeId: id, sample: sampleOf(dv) }));
    }
  }

  async subscribeEvents(onAlarm: (a: EquipmentAlarmV1) => void, onEvent: (e: EquipmentEventV1) => void): Promise<void> {
    const sub = await this.ensureSubscription(250);
    for (const unit of this.options.units) {
      const item = ClientMonitoredItem.create(sub, { nodeId: this.nodeId(opcuaEventsNodeId(unit)), attributeId: AttributeIds.Value }, { samplingInterval: 0, discardOldest: false, queueSize: 1000 }, TimestampsToReturn.Both);
      item.on('changed', (dv: DataValue) => {
        const text = typeof dv.value.value === 'string' ? dv.value.value : '';
        if (text === '') return; // the node's initial empty value
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = { alarm: { malformed: text.slice(0, 200) } };
        }
        const b = (body ?? {}) as { alarm?: unknown; event?: unknown };
        if (b.event !== undefined) onEvent(b.event as EquipmentEventV1);
        else onAlarm((b.alarm ?? body) as EquipmentAlarmV1);
      });
    }
  }

  async read(nodeId: string): Promise<NativeSample> {
    if (!this.session) throw new Error('the session is not open');
    const dv = await this.session.read({ nodeId: this.nodeId(nodeId), attributeId: AttributeIds.Value }, 0);
    return sampleOf(dv);
  }

  async readText(nodeId: string): Promise<string | null> {
    if (!this.session) throw new Error('the session is not open');
    const dv = await this.session.read({ nodeId: this.nodeId(nodeId), attributeId: AttributeIds.Value }, 0);
    return dv.statusCode.isGood() && typeof dv.value.value === 'string' ? dv.value.value : null;
  }

  async write(nodeId: string, raw: string): Promise<void> {
    if (!this.session) throw new Error('the session is not open');
    const value = Number(raw);
    if (!Number.isFinite(value) || canonicalDecimal(raw) === null) throw new Error(`${raw} is not a number to write`);
    const status = await this.session.write({ nodeId: this.nodeId(nodeId), attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Double, value } } });
    if (!status.isGood()) throw new Error(`the server refused the write: ${status.toString()}`);
  }

  async close(): Promise<void> {
    const client = this.client;
    const session = this.session;
    const sub = this.subscription;
    this.client = null;
    this.session = null;
    this.subscription = null;
    this.ns = -1;
    await sub?.terminate().catch(() => undefined);
    await session?.close().catch(() => undefined);
    await client?.disconnect().catch(() => undefined);
  }

  private async ensureSubscription(intervalMs: number): Promise<ClientSubscription> {
    if (!this.session) throw new Error('the session is not open');
    this.subscription ??= await this.session.createSubscription2({
      requestedPublishingInterval: intervalMs, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10, maxNotificationsPerPublish: 0, publishingEnabled: true, priority: 1,
    });
    return this.subscription;
  }
}
