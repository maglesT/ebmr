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
 * The feed holds no secret and changes nothing at the server: the server pulls. It listens on loopback unless the site
 * configures otherwise; every message is also checked again by the server (hash, contract) and the database.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  rawPayloadHash,
  reconciliationChecksum,
  type EquipmentAlarmV1,
  type EquipmentEventV1,
  type OpcuaEndpointSessionV1,
  type ReconciliationSubmission,
  type SeriesChunkV1,
} from '@ebmr/integration-sdk/adapter';
import type { GatewayClock } from './clock.ts';
import type { OpcuaSink } from './drivers/opcua.ts';

export const OPCUA_FEED_PREFIX = '/opcua/v1';
const PAGE_MAX = 500;

export interface OpcuaEnvelope {
  sourceSystem: 'OPCUA';
  messageType: 'opcua.series_chunk' | 'opcua.alarm' | 'opcua.equipment_event' | 'opcua.endpoint_session';
  sourceRecordId: string;
  sourceTimestamp: string;
  sequenceNo: string;
  idempotencyKey: string;
  schemaVersion: '1';
  payloadHash: string;
  payload: Record<string, unknown>;
}

export interface OpcuaFeedAlarm {
  kind: 'FEED_JOURNAL_FAILED' | 'FEED_DUPLICATE_KEY';
  message: string;
  details: Record<string, string>;
}

export interface OpcuaFeedOptions {
  dir: string;
  gatewayCode: string;
  clock: GatewayClock;
  onAlarm?: (a: OpcuaFeedAlarm) => void;
}

export class OpcuaFeed {
  private readonly messages: OpcuaEnvelope[] = [];
  private readonly keys = new Map<string, string>();
  private readonly chunkHead = new Map<string, bigint>();
  private fd: number | null = null;
  private failed = false;
  private http: Server | null = null;
  port: number | null = null;

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
    return f;
  }

  private remember(env: OpcuaEnvelope): void {
    this.messages.push(env);
    this.keys.set(env.idempotencyKey, env.payloadHash);
    if (env.messageType === 'opcua.series_chunk') {
      const p = env.payload as unknown as SeriesChunkV1;
      const k = `${p.subjectCode}|${p.tag}`;
      const n = BigInt(p.chunkNo);
      if (n > (this.chunkHead.get(k) ?? 0n)) this.chunkHead.set(k, n);
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
    const env: OpcuaEnvelope = {
      sourceSystem: 'OPCUA', messageType, sourceRecordId: sourceRecordId.slice(0, 128), sourceTimestamp, sequenceNo: (this.messages.length + 1).toString(), idempotencyKey,
      schemaVersion: '1', payloadHash, payload: JSON.parse(text) as Record<string, unknown>,
    };
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
      alarm: (a: EquipmentAlarmV1) => void this.publish('opcua.alarm', `alarm/${a.occurrenceId}/${a.transition}`.slice(0, 128), a.occurredAt, a),
      event: (e: EquipmentEventV1) => void this.publish('opcua.equipment_event', `event/${e.eventId}`.slice(0, 128), e.occurredAt, e),
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

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
