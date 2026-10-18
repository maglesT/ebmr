/**
 * The gateway's OPC UA feed (Phase 6 slice 6b, builder A; D-P6b-0-1; DI-31, DI-32): what the OPC UA drivers receive
 * besides the released tags' process readings (native series chunks, alarm occurrences that are not tag readings,
 * equipment events, and each endpoint session the drivers open) becomes one inbound envelope of the 6a contract, written
 * to the feed's journal before anything else happens to it, and served to the server's OPCUA adapter worker by the 6a
 * feed protocol:
 *
 *   GET /opcua/v1/feed?after=N&limit=M     {messages, head}: the envelopes after sequence N (at most 500)
 *   GET /opcua/v1/heartbeat                {head, atUs}: the gateway runs and its journal is writable
 *   GET /opcua/v1/reconciliation?from&to   the feed's own count and checksum of what it published in [from, to) of
 *                                           source time (ReconciliationSubmission)
 *
 * The journal (one JSON envelope per line, fsync per append) is the feed: a restart serves the same messages with the
 * same sequence numbers and continues the chunk numbers of each (unit, tag). An exact re-delivery (the same idempotency
 * key and payload hash, e.g. the current value of an `_events` node sent again at a resubscription) is not published
 * twice; the same key with another payload is published, so the database refuses it with an alarm (never silently).
 * A message that cannot be journalled is alarmed and the feed stops accepting (the head no longer moves; the server's
 * heartbeat check sees it).
 *
 * Phase 7 slice 7a (6jc-R9; DI-31, DI-20): every envelope is signed with the gateway's Ed25519 key when it is journalled
 * (gatewaySignature over feedSignatureMessage of the SDK; keyId the SHA-256 of the key's SPKI DER), and the signature is
 * journalled with it, so a restart serves the very same bytes. The database checks the signature against the gateway's
 * ACTIVE enrolled key (tab.accept_gateway_envelope, tablets 1405); an envelope journalled unsigned before 7a is served as
 * it stands and refused there (EBMR-INT-030).
 *
 * Phase 7 slice 7b-1 (the T12 observation, decision 0022; DI-32, DI-31): the spool. A chunk is journalled when it
 * closes; until then its samples were only in the driver's memory, and a crash lost them. Now each sample of an open
 * chunk is spooled on receipt (opcua-spool.jsonl beside the journal: the chunk's subject, tag, unit and number, and the
 * sample), written and fsynced in batches at most `spoolSyncMs` (at most 1 s) apart. A clean stop (every open chunk
 * closed and journalled first) ends the spool with a `closed` line. At open, after the journal, a spool that does not
 * end so is a crash: each open chunk it holds (a number the journal does not hold for that unit and tag) is completed
 * from its samples and journalled, signed like every chunk, with the next numbers continuing after it; and for each
 * such series what the gateway cannot fill (the samples after the last one spooled, the time it was down) is published
 * as an opcua.series_gap from that sample's source time to the restart (the gateway's clock), which the database
 * raises as a SERIES_GAP alarm naming unit, tag and interval (recipe-core 1232). The spool is then started afresh, and
 * rewritten with only the open chunks' samples when it grows past `spoolRotateBytes`. A spool that cannot be written is
 * alarmed (SPOOL_FAILED) once; the feed goes on.
 *
 * The feed changes nothing at the server: the server pulls. It listens on loopback unless the site
 * configures otherwise; every message is also checked again by the server (hash, contract) and the database.
 */
import { createHash, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  rawPayloadHash,
  reconciliationChecksum,
  SeriesChunkV1 as SeriesChunk,
  seriesChunkHash,
  signFeedEnvelope,
  type NativeSample,
  type SeriesGapV1,
  type GatewaySignature,
  type EquipmentAlarmV1,
  type EquipmentEventV1,
  type OpcuaEndpointSessionV1,
  type ReconciliationSubmission,
  type SeriesChunkV1,
} from '@ebmr/integration-sdk/adapter';
import type { GatewayClock } from './clock.ts';
import type { OpcuaSink, SpooledSample } from './drivers/opcua.ts';

export const OPCUA_FEED_PREFIX = '/opcua/v1';
const PAGE_MAX = 500;

export interface OpcuaEnvelope {
  sourceSystem: 'OPCUA';
  messageType: 'opcua.series_chunk' | 'opcua.alarm' | 'opcua.equipment_event' | 'opcua.endpoint_session' | 'opcua.series_gap';
  sourceRecordId: string;
  sourceTimestamp: string;
  sequenceNo: string;
  idempotencyKey: string;
  schemaVersion: '1';
  payloadHash: string;
  payload: Record<string, unknown>;
  /** Slice 7a: the gateway's signature, made when the envelope is journalled (absent in a journal written before 7a). */
  gatewaySignature?: GatewaySignature;
}

export interface OpcuaFeedAlarm {
  kind: 'FEED_JOURNAL_FAILED' | 'FEED_DUPLICATE_KEY' | 'SERIES_GAP' | 'SPOOL_FAILED';
  message: string;
  details: Record<string, string>;
}

export interface OpcuaFeedOptions {
  dir: string;
  gatewayCode: string;
  clock: GatewayClock;
  /** The gateway's Ed25519 key (DEMO-ONLY key file; a KMS or HSM at deployment) and its key id (SDK feedKeyId). */
  signingKey: { privateKey: KeyObject; keyId: string };
  onAlarm?: (a: OpcuaFeedAlarm) => void;
  /** Slice 7b-1: how far apart the spool's batches are written and fsynced (ms; at most 1000, default 500). */
  spoolSyncMs?: number;
  /** Slice 7b-1: the spool's size (bytes) past which it is rewritten with only the open chunks' samples (default 4 MiB). */
  spoolRotateBytes?: number;
}

/** One series' open chunk as the spool holds it. */
interface OpenChunk {
  subjectKind: SpooledSample['subjectKind'];
  subjectCode: string;
  tag: string;
  unit: string;
  chunkNo: bigint;
  samples: NativeSample[];
}

const SPOOL_FILE = 'opcua-spool.jsonl';
const CLOSED_LINE = `${JSON.stringify({ k: 'closed' })}\n`;

export class OpcuaFeed {
  private readonly messages: OpcuaEnvelope[] = [];
  private readonly keys = new Map<string, string>();
  private readonly chunkHead = new Map<string, bigint>();
  private fd: number | null = null;
  private failed = false;
  private http: Server | null = null;
  port: number | null = null;
  /** The spool (slice 7b-1): its file, the lines not yet written, its size, the open chunks it holds, its timer. */
  private spoolFd: number | null = null;
  private spoolPending: string[] = [];
  private spoolBytes = 0;
  private spoolFailed = false;
  private readonly spoolOpen = new Map<string, OpenChunk>();
  private spoolTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly options: OpcuaFeedOptions) {}

  /** Opens (or creates) the feed's journal and reloads what it holds. */
  static open(options: OpcuaFeedOptions): OpcuaFeed {
    const f = new OpcuaFeed(options);
    mkdirSync(options.dir, { recursive: true });
    const path = join(options.dir, 'opcua-feed.jsonl');
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        if (line === '') continue;
        let env: OpcuaEnvelope;
        try {
          env = JSON.parse(line) as OpcuaEnvelope;
        } catch {
          // A torn last line (the process died mid-write): that message was never acknowledged as published.
          if (i >= lines.length - 2) break;
          throw new Error(`the OPC UA feed journal ${path} is damaged at line ${(i + 1).toString()}`);
        }
        f.remember(env);
      }
    }
    f.fd = openSync(path, 'a');
    f.recoverSpool();
    return f;
  }

  private get spoolPath(): string {
    return join(this.options.dir, SPOOL_FILE);
  }

  /**
   * At open (header, "the spool"): after a crash, completes each open chunk from the spool and publishes what cannot be
   * filled as a series gap; then starts the spool afresh. A damaged line before the end refuses to open, as the journal.
   */
  private recoverSpool(): void {
    const path = this.spoolPath;
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      let closed = false;
      const open = new Map<string, OpenChunk>();
      for (const [i, line] of lines.entries()) {
        if (line === '') continue;
        let rec: { k?: unknown } & Partial<SpooledSample>;
        try {
          rec = JSON.parse(line) as typeof rec;
        } catch {
          // A torn last line: that sample was never fsynced; it falls in the gap reported below.
          if (i >= lines.length - 2) break;
          throw new Error(`the OPC UA feed spool ${path} is damaged at line ${(i + 1).toString()}`);
        }
        if (rec.k === 'closed') {
          closed = true;
          continue;
        }
        closed = false;
        if (rec.k !== 's' || !rec.subjectKind || !rec.subjectCode || !rec.tag || !rec.unit || !rec.chunkNo || !rec.sample) {
          throw new Error(`the OPC UA feed spool ${path} holds an unknown line ${(i + 1).toString()}`);
        }
        const no = BigInt(rec.chunkNo);
        const key = `${rec.subjectCode}|${rec.tag}`;
        if (no <= (this.chunkHead.get(key) ?? 0n)) continue; // journalled already
        const at = `${key}|${no.toString()}`;
        const c = open.get(at) ?? { subjectKind: rec.subjectKind, subjectCode: rec.subjectCode, tag: rec.tag, unit: rec.unit, chunkNo: no, samples: [] };
        c.samples.push(rec.sample);
        open.set(at, c);
      }
      if (!closed && open.size > 0) this.completeAfterCrash([...open.values()].sort((a, b) => (a.chunkNo < b.chunkNo ? -1 : a.chunkNo > b.chunkNo ? 1 : 0)));
    }
    if (this.failed) return; // the journal failed: the spool stays as it is for the next start
    try {
      writeFileSync(path, '', { mode: 0o600 });
      this.spoolFd = openSync(path, 'a');
      fsyncSync(this.spoolFd);
      this.spoolBytes = 0;
    } catch (e) {
      this.spoolFailure(e);
    }
    const every = Math.max(10, Math.min(1000, this.options.spoolSyncMs ?? 500));
    this.spoolTimer = setInterval(() => this.syncSpool(), every);
    this.spoolTimer.unref();
  }

  /** The open chunks of a crashed run, completed and journalled; a gap from each series' last spooled sample to now. */
  private completeAfterCrash(chunks: OpenChunk[]): void {
    const restartUs = this.options.clock.wallUs();
    const last = new Map<string, OpenChunk>();
    for (const c of chunks) {
      const body = { subjectKind: c.subjectKind, subjectCode: c.subjectCode, tag: c.tag, unit: c.unit, chunkNo: c.chunkNo.toString(), samples: c.samples };
      const chunk = { ...body, chunkHash: seriesChunkHash(body) };
      if (SeriesChunk.safeParse(chunk).success) {
        this.publish('opcua.series_chunk', `${c.subjectCode}/${c.tag}/${c.chunkNo.toString()}`, c.samples[c.samples.length - 1]?.sourceTime ?? restartUs.toString(), chunk);
      }
      // A spooled chunk that is not a valid chunk (it cannot be: the driver checked each sample) is part of the gap.
      const key = `${c.subjectCode}|${c.tag}`;
      const prev = last.get(key);
      if (!prev || c.chunkNo > prev.chunkNo) last.set(key, c);
    }
    for (const c of last.values()) {
      const lastUs = BigInt(c.samples[c.samples.length - 1]?.sourceTime ?? '0');
      const toUs = restartUs > lastUs ? restartUs : lastUs + 1n;
      const gap: SeriesGapV1 = {
        subjectKind: 'EQUIPMENT', subjectCode: c.subjectCode, tag: c.tag, unit: c.unit, fromUs: lastUs.toString(), toUs: toUs.toString(), reason: 'GATEWAY_RESTART',
        detail: `The gateway stopped without closing chunk ${c.chunkNo.toString()}; it was completed from the spool with ${c.samples.length.toString()} samples. Samples after the last one spooled, and while the gateway was down, could not be recorded.`,
      };
      this.publish('opcua.series_gap', `gap/${c.subjectCode}/${c.tag}/${gap.fromUs}`, gap.toUs, gap);
      this.options.onAlarm?.({
        kind: 'SERIES_GAP', message: `${c.subjectCode}/${c.tag}: no samples could be recorded from ${gap.fromUs} to ${gap.toUs} (gateway restart); reported to the server`,
        details: { unit: c.subjectCode, tag: c.tag, fromUs: gap.fromUs, toUs: gap.toUs },
      });
    }
  }

  /** Spools one sample of an open chunk (written by the next batch). */
  private spool(s: SpooledSample): void {
    if (this.spoolFailed || this.spoolFd === null) return;
    const key = `${s.subjectCode}|${s.tag}`;
    const no = BigInt(s.chunkNo);
    const c = this.spoolOpen.get(key);
    if (c && c.chunkNo === no) c.samples.push(s.sample);
    else this.spoolOpen.set(key, { subjectKind: s.subjectKind, subjectCode: s.subjectCode, tag: s.tag, unit: s.unit, chunkNo: no, samples: [s.sample] });
    this.spoolPending.push(`${JSON.stringify({ k: 's', ...s })}\n`);
  }

  /** Writes and fsyncs the spooled lines not yet written (the batch); rewrites the spool once it is past its size. */
  syncSpool(): void {
    if (this.spoolFailed || this.spoolFd === null || this.spoolPending.length === 0) return;
    const text = this.spoolPending.join('');
    this.spoolPending = [];
    try {
      writeSync(this.spoolFd, text);
      fsyncSync(this.spoolFd);
      this.spoolBytes += Buffer.byteLength(text, 'utf8');
      if (this.spoolBytes > (this.options.spoolRotateBytes ?? 4 * 1024 * 1024)) this.rotateSpool();
    } catch (e) {
      this.spoolFailure(e);
    }
  }

  /** The spool rewritten with the samples of the chunks still open (written to a new file, fsynced, renamed over). */
  private rotateSpool(): void {
    const lines = [...this.spoolOpen.values()].flatMap((c) =>
      c.samples.map((sample) => `${JSON.stringify({ k: 's', subjectKind: c.subjectKind, subjectCode: c.subjectCode, tag: c.tag, unit: c.unit, chunkNo: c.chunkNo.toString(), sample })}\n`));
    const next = `${this.spoolPath}.next`;
    const fd = openSync(next, 'w', 0o600);
    try {
      writeSync(fd, lines.join(''));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(next, this.spoolPath);
    if (this.spoolFd !== null) closeSync(this.spoolFd);
    this.spoolFd = openSync(this.spoolPath, 'a');
    this.spoolBytes = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
  }

  private spoolFailure(e: unknown): void {
    if (this.spoolFailed) return;
    this.spoolFailed = true;
    this.options.onAlarm?.({
      kind: 'SPOOL_FAILED', message: `the OPC UA feed spool cannot be written: ${e instanceof Error ? e.message : String(e)}; the samples of open chunks are held in memory only until they close`,
      details: {},
    });
  }

  private remember(env: OpcuaEnvelope): void {
    this.messages.push(env);
    this.keys.set(env.idempotencyKey, env.payloadHash);
    if (env.messageType === 'opcua.series_chunk') {
      const p = env.payload as unknown as SeriesChunkV1;
      const k = `${p.subjectCode}|${p.tag}`;
      const n = BigInt(p.chunkNo);
      if (n > (this.chunkHead.get(k) ?? 0n)) this.chunkHead.set(k, n);
      // Slice 7b-1: a chunk journalled is no longer open in the spool.
      const open = this.spoolOpen.get(k);
      if (open && open.chunkNo <= n) this.spoolOpen.delete(k);
    }
  }

  /** The next chunk number of (unit, tag): one more than the highest journalled. */
  nextChunkNo(unit: string, tag: string): bigint {
    return (this.chunkHead.get(`${unit}|${tag}`) ?? 0n) + 1n;
  }

  head(): bigint {
    return BigInt(this.messages.length);
  }

  published(): readonly OpcuaEnvelope[] {
    return this.messages;
  }

  get healthy(): boolean {
    return !this.failed && this.fd !== null;
  }

  /**
   * Journals and publishes one message; returns it, or null when it is an exact re-delivery of one already published
   * (or the journal failed: alarmed).
   */
  publish(messageType: OpcuaEnvelope['messageType'], sourceRecordId: string, sourceTimestamp: string, payload: Record<string, unknown>): OpcuaEnvelope | null {
    const text = JSON.stringify(payload);
    const payloadHash = rawPayloadHash(text);
    const idempotencyKey = `${this.options.gatewayCode.slice(0, 40)}-${createHash('sha256').update(`${messageType}|${sourceRecordId}`, 'utf8').digest('hex').slice(0, 48)}`;
    const known = this.keys.get(idempotencyKey);
    if (known === payloadHash) return null;
    if (known !== undefined) {
      this.options.onAlarm?.({ kind: 'FEED_DUPLICATE_KEY', message: `${messageType} ${sourceRecordId} arrived again with other content; published so the server records the refusal`, details: { sourceRecordId } });
    }
    if (this.failed || this.fd === null) return null;
    const unsigned: OpcuaEnvelope = {
      sourceSystem: 'OPCUA', messageType, sourceRecordId: sourceRecordId.slice(0, 128), sourceTimestamp, sequenceNo: (this.messages.length + 1).toString(), idempotencyKey,
      schemaVersion: '1', payloadHash, payload: JSON.parse(text) as Record<string, unknown>,
    };
    let env: OpcuaEnvelope;
    try {
      // Slice 7a: signed before it is journalled; the journal line is the signed envelope (what every restart serves).
      env = { ...unsigned, gatewaySignature: signFeedEnvelope(unsigned, this.options.gatewayCode, this.options.signingKey.keyId, this.options.signingKey.privateKey) };
    } catch (e) {
      this.options.onAlarm?.({ kind: 'FEED_JOURNAL_FAILED', message: `the OPC UA feed cannot sign ${messageType} ${sourceRecordId}: ${e instanceof Error ? e.message : String(e)}; not published`, details: { sourceRecordId } });
      return null;
    }
    try {
      writeSync(this.fd, `${JSON.stringify(env)}\n`);
      fsyncSync(this.fd);
    } catch (e) {
      this.failed = true;
      this.options.onAlarm?.({ kind: 'FEED_JOURNAL_FAILED', message: `the OPC UA feed journal cannot be written: ${e instanceof Error ? e.message : String(e)}; the feed stops`, details: { sourceRecordId } });
      return null;
    }
    this.remember(env);
    return env;
  }

  /** The sink an OpcuaDriver writes to. */
  sink(): OpcuaSink {
    return {
      session: (s: OpcuaEndpointSessionV1) => void this.publish('opcua.endpoint_session', `session/${s.endpointCode}/${s.openedAt}`, s.openedAt, s),
      chunk: (c: SeriesChunkV1) => {
        const last = c.samples[c.samples.length - 1];
        void this.publish('opcua.series_chunk', `${c.subjectCode}/${c.tag}/${c.chunkNo}`, last?.sourceTime ?? '0', c);
      },
      // The whole id names the message (its idempotency key); only the envelope's sourceRecordId is cut to 128 (publish).
      alarm: (a: EquipmentAlarmV1) => void this.publish('opcua.alarm', `alarm/${a.occurrenceId}/${a.transition}`, a.occurredAt, a),
      event: (e: EquipmentEventV1) => void this.publish('opcua.equipment_event', `event/${e.eventId}`, e.occurredAt, e),
      sample: (s: SpooledSample) => this.spool(s),
    };
  }

  page(after: bigint, limit: number): { messages: OpcuaEnvelope[]; head: string } {
    const n = Math.max(1, Math.min(limit, PAGE_MAX));
    const start = after < 0n ? 0 : Number(after > BigInt(this.messages.length) ? BigInt(this.messages.length) : after);
    return { messages: this.messages.slice(start, start + n), head: this.head().toString() };
  }

  reconciliation(fromUs: bigint, toUs: bigint): ReconciliationSubmission {
    const inPeriod = this.messages.filter((m) => BigInt(m.sourceTimestamp) >= fromUs && BigInt(m.sourceTimestamp) < toUs);
    const { count, checksum } = reconciliationChecksum(inPeriod.map((m) => ({ idempotencyKey: m.idempotencyKey, payloadHash: m.payloadHash })));
    return { periodFrom: fromUs.toString(), periodTo: toUs.toString(), sourceCount: count, sourceChecksum: checksum };
  }

  /** Serves the feed protocol on host:port (port 0: any free port). */
  async serve(host: string, port: number): Promise<number> {
    const WHOLE = /^(0|[1-9][0-9]{0,17})$/;
    this.http = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? '/', 'http://feed');
      if (req.method !== 'GET') return send(405, { error: 'GET only' });
      if (url.pathname === `${OPCUA_FEED_PREFIX}/feed`) {
        const after = url.searchParams.get('after') ?? '0';
        const limit = url.searchParams.get('limit') ?? '100';
        if (!WHOLE.test(after) || !/^[1-9][0-9]{0,3}$/.test(limit)) return send(400, { error: 'after and limit are whole numbers' });
        return send(200, this.page(BigInt(after), Number(limit)));
      }
      if (url.pathname === `${OPCUA_FEED_PREFIX}/heartbeat`) {
        return this.healthy ? send(200, { head: this.head().toString(), atUs: this.options.clock.wallUs().toString() }) : send(503, { error: 'the feed journal failed' });
      }
      if (url.pathname === `${OPCUA_FEED_PREFIX}/reconciliation`) {
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        if (!WHOLE.test(from) || !WHOLE.test(to) || BigInt(from) >= BigInt(to)) return send(400, { error: 'from < to, epoch microseconds' });
        return send(200, this.reconciliation(BigInt(from), BigInt(to)));
      }
      return send(404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => this.http?.listen(port, host, () => resolve()));
    const a = this.http.address();
    this.port = a && typeof a === 'object' ? a.port : null;
    return this.port ?? port;
  }

  /**
   * Closes the feed. The spool is written, and ends with its `closed` line when no chunk is open any more (the drivers
   * stopped first and closed theirs); with a chunk still open it is left as a crash leaves it, so the next start
   * completes the chunk.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    this.spoolTimer = null;
    this.syncSpool();
    if (this.spoolFd !== null) {
      try {
        if (this.spoolOpen.size === 0 && !this.spoolFailed) {
          writeSync(this.spoolFd, CLOSED_LINE);
          fsyncSync(this.spoolFd);
        }
      } catch (e) {
        this.spoolFailure(e);
      }
      closeSync(this.spoolFd);
    }
    this.spoolFd = null;
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
