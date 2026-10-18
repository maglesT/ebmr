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

/** A series the spool names. */
interface SeriesMeta {
  subjectKind: SpooledSample['subjectKind'];
  subjectCode: string;
  tag: string;
  unit: string;
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
  /** The series spooled since the spool started (kept across a rotation as `seen` lines), and each one's last journalled sample. */
  private readonly spoolSeen = new Map<string, SeriesMeta>();
  private readonly chunkEnd = new Map<string, bigint>();
  /** A crash recovery left messages unjournalled: the spool is kept and never marked closed in this run. */
  private spoolRecoveryPending = false;

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
   * filled as a series gap, for every series the spool shows was being recorded; then starts the spool afresh, unless a
   * recovery message could not be journalled (the spool is then kept, and the next start tries again). A damaged line
   * before the end refuses to open, as the journal.
   */
  private recoverSpool(): void {
    const path = this.spoolPath;
    let kept = false;
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      let closed = false;
      const series = new Map<string, SeriesMeta>();
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
        if ((rec.k !== 's' && rec.k !== 'seen') || !rec.subjectKind || !rec.subjectCode || !rec.tag || !rec.unit || (rec.k === 's' && (!rec.chunkNo || !rec.sample))) {
          throw new Error(`the OPC UA feed spool ${path} holds an unknown line ${(i + 1).toString()}`);
        }
        const key = `${rec.subjectCode}|${rec.tag}`;
        series.set(key, { subjectKind: rec.subjectKind, subjectCode: rec.subjectCode, tag: rec.tag, unit: rec.unit });
        if (rec.k === 'seen' || !rec.chunkNo || !rec.sample) continue;
        const no = BigInt(rec.chunkNo);
        if (no <= (this.chunkHead.get(key) ?? 0n)) continue; // journalled already
        const at = `${key}|${no.toString()}`;
        const c = open.get(at) ?? { subjectKind: rec.subjectKind, subjectCode: rec.subjectCode, tag: rec.tag, unit: rec.unit, chunkNo: no, samples: [] };
        c.samples.push(rec.sample);
        open.set(at, c);
      }
      if (!closed && series.size > 0) kept = !this.completeAfterCrash(series, [...open.values()]);
    }
    if (this.failed) return; // the journal failed: the spool stays as it is for the next start
    try {
      if (kept) {
        // Review round 1 of 7b-1b (finding 2c): a recovery message was not journalled; the spool is kept as it is (and
        // never marked closed in this run), so the next start completes it again.
        this.spoolRecoveryPending = true;
      } else {
        writeFileSync(path, '', { mode: 0o600 });
      }
      this.spoolFd = openSync(path, 'a');
      fsyncSync(this.spoolFd);
      this.spoolBytes = kept ? Buffer.byteLength(readFileSync(path, 'utf8'), 'utf8') : 0;
    } catch (e) {
      this.spoolFailure(e);
    }
    const every = Math.max(10, Math.min(1000, this.options.spoolSyncMs ?? 500));
    this.spoolTimer = setInterval(() => this.syncSpool(), every);
    this.spoolTimer.unref();
  }

  /**
   * The series of a crashed run (header): each open chunk completed and journalled in number order; a spooled chunk that
   * is not a valid chunk is reported as a gap up to the next completed chunk; and for every series a gap from its last
   * sample known (the last chunk completed, or the end of its last journalled chunk when none was open: a crash just
   * after a chunk closed or a quiet tag's flush) to the restart. Returns whether every message was journalled (or was
   * already).
   */
  private completeAfterCrash(series: ReadonlyMap<string, SeriesMeta>, chunks: OpenChunk[]): boolean {
    const restartUs = this.options.clock.wallUs();
    let ok = true;
    const timeOf = (s: NativeSample | undefined): bigint | null => {
      try {
        return s ? BigInt(s.sourceTime) : null;
      } catch {
        return null;
      }
    };
    const gap = (m: SeriesMeta, from: bigint, to: bigint, detail: string): void => {
      const toUs = to > from ? to : from + 1n;
      const g: SeriesGapV1 = { ...m, subjectKind: 'EQUIPMENT', fromUs: from.toString(), toUs: toUs.toString(), reason: 'GATEWAY_RESTART', detail: detail.slice(0, 500) };
      if (this.journal('opcua.series_gap', `gap/${m.subjectCode}/${m.tag}/${g.fromUs}/${g.toUs}`, g.toUs, g).outcome === 'FAILED') ok = false;
      this.options.onAlarm?.({
        kind: 'SERIES_GAP', message: `${m.subjectCode}/${m.tag}: no samples could be recorded from ${g.fromUs} to ${g.toUs} (gateway restart); reported to the server`,
        details: { unit: m.subjectCode, tag: m.tag, fromUs: g.fromUs, toUs: g.toUs },
      });
    };
    for (const [key, m] of series) {
      const mine = chunks.filter((c) => `${c.subjectCode}|${c.tag}` === key).sort((a, b) => (a.chunkNo < b.chunkNo ? -1 : a.chunkNo > b.chunkNo ? 1 : 0));
      let cursor: bigint | null = this.chunkEnd.get(key) ?? null;
      let dropped: string[] = [];
      let dropFrom: bigint | null = null;
      let completed = 0;
      for (const c of mine) {
        const body = { subjectKind: c.subjectKind, subjectCode: c.subjectCode, tag: c.tag, unit: c.unit, chunkNo: c.chunkNo.toString(), samples: c.samples };
        const chunk = { ...body, chunkHash: seriesChunkHash(body) };
        if (!SeriesChunk.safeParse(chunk).success) {
          // Finding 2b: it cannot be: the driver checked each sample; if it is, its stretch is a gap, never silent.
          if (dropped.length === 0) dropFrom = cursor ?? (timeOf(c.samples[0]) ?? restartUs) - 1n;
          dropped.push(c.chunkNo.toString());
          continue;
        }
        const first = timeOf(c.samples[0]) ?? restartUs;
        if (dropped.length > 0 && dropFrom !== null) {
          gap(m, dropFrom, first, `Spooled chunk(s) ${dropped.join(', ')} could not be completed (not a valid chunk); their samples could not be recorded.`);
          dropped = [];
        }
        const lastUs = c.samples[c.samples.length - 1]?.sourceTime ?? restartUs.toString();
        if (this.journal('opcua.series_chunk', `${c.subjectCode}/${c.tag}/${c.chunkNo.toString()}`, lastUs, chunk).outcome === 'FAILED') ok = false;
        completed += 1;
        cursor = timeOf(c.samples[c.samples.length - 1]) ?? cursor;
      }
      const from = dropped.length > 0 ? dropFrom : cursor;
      const what = dropped.length > 0
        ? `Spooled chunk(s) ${dropped.join(', ')} could not be completed (not a valid chunk).`
        : completed > 0
          ? `The gateway stopped with an open chunk; it was completed from the spool (${completed.toString()} chunk(s)).`
          : 'The gateway stopped with no open chunk of this series (a chunk had just closed, or the tag was quiet).';
      gap(m, from ?? restartUs - 1n, restartUs, `${what} Samples after the last one recorded, and while the gateway was down, could not be recorded.`);
    }
    return ok;
  }

  /** Spools one sample of an open chunk (written by the next batch). */
  private spool(s: SpooledSample): void {
    if (this.spoolFailed || this.spoolFd === null) return;
    const key = `${s.subjectCode}|${s.tag}`;
    this.spoolSeen.set(key, { subjectKind: s.subjectKind, subjectCode: s.subjectCode, tag: s.tag, unit: s.unit });
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
    // Finding 2a: every series spooled since the start stays named (a crash after its chunk closed is still a gap).
    const seen = [...this.spoolSeen.values()].map((m) => `${JSON.stringify({ k: 'seen', ...m })}\n`);
    const lines = [...seen, ...this.spoolOpen.values()].flatMap((c) => typeof c === 'string' ? [c] :
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
      if (n >= (this.chunkHead.get(k) ?? 0n)) {
        this.chunkHead.set(k, n);
        const last = p.samples[p.samples.length - 1];
        try {
          if (last) this.chunkEnd.set(k, BigInt(last.sourceTime));
        } catch {
          // a journalled chunk with a malformed time: its end is unknown
        }
      }
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
    return this.journal(messageType, sourceRecordId, sourceTimestamp, payload).env;
  }

  /** publish, saying whether the message was journalled now (PUBLISHED), was already (KNOWN) or could not be (FAILED). */
  private journal(messageType: OpcuaEnvelope['messageType'], sourceRecordId: string, sourceTimestamp: string, payload: object): { env: OpcuaEnvelope | null; outcome: 'PUBLISHED' | 'KNOWN' | 'FAILED' } {
    const text = JSON.stringify(payload);
    const payloadHash = rawPayloadHash(text);
    const idempotencyKey = `${this.options.gatewayCode.slice(0, 40)}-${createHash('sha256').update(`${messageType}|${sourceRecordId}`, 'utf8').digest('hex').slice(0, 48)}`;
    const known = this.keys.get(idempotencyKey);
    if (known === payloadHash) return { env: null, outcome: 'KNOWN' };
    if (known !== undefined) {
      this.options.onAlarm?.({ kind: 'FEED_DUPLICATE_KEY', message: `${messageType} ${sourceRecordId} arrived again with other content; published so the server records the refusal`, details: { sourceRecordId } });
    }
    if (this.failed || this.fd === null) return { env: null, outcome: 'FAILED' };
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
      return { env: null, outcome: 'FAILED' };
    }
    try {
      writeSync(this.fd, `${JSON.stringify(env)}\n`);
      fsyncSync(this.fd);
    } catch (e) {
      this.failed = true;
      this.options.onAlarm?.({ kind: 'FEED_JOURNAL_FAILED', message: `the OPC UA feed journal cannot be written: ${e instanceof Error ? e.message : String(e)}; the feed stops`, details: { sourceRecordId } });
      return { env: null, outcome: 'FAILED' };
    }
    this.remember(env);
    return { env, outcome: 'PUBLISHED' };
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
        if (this.spoolOpen.size === 0 && !this.spoolFailed && !this.spoolRecoveryPending) {
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
