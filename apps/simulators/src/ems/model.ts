/**
 * The EMS simulator (Phase 6 slice 6b, builder B; EMS contract; DI-31, DI-32, DI-49; D-P6b-6): room temperature and
 * relative humidity sensors of the Tablets rooms, published on the feed as native series chunks, with the room alarms
 * the EMS raises (limit excursions the client posts, and the EMS's own FEED_GAP occurrence when a sensor stops).
 *
 *   POST /ems/v1/samples     {roomCode, tag, samples: [{raw, status?}, ...]}   one ems.series_chunk
 *   POST /ems/v1/alarms      {roomCode, occurrenceId, transition, alarmCode, severity, tag?, value?, limit?, limitKind?, message}
 *   POST /ems/v1/sensor-gap  {roomCode, tag, on}   the sensor stops reporting (on: its samples are refused and the EMS
 *                            raises FEED_GAP for the room) or reports again (off: the occurrence is cleared)
 *
 * The rooms are the ones the client reports for (the eBMR decides whether it knows the room). Chunk numbers count up
 * from 1 per room and tag; each sample gets its own strictly increasing source time (the server time equals it); the
 * value shown is the canonical decimal the raw text states exactly (DI-32), none for a BAD status. SIMULATOR, DEMO-ONLY.
 */
import {
  canonicalDecimal,
  EMS,
  EMS_TAGS,
  qualityOfStatus,
  RawNumberText,
  seriesChunkHash,
  StatusCodeText,
  type NativeSample,
  type SeriesChunkV1,
} from '@ebmr/integration-sdk/adapter';
import { SystemFeed, systemClock, type FeedClock } from '../system-feed/feed.ts';
import { contractPlugin } from '../system-feed/plugin.ts';
import type { FeedPlugin } from '../system-feed/server.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unitOf = (tag: unknown): string | undefined => EMS_TAGS.find((t) => t.tag === tag)?.unit;

/** One native sample from what a sensor reported: the shown value is the raw text's exact decimal, none when BAD. */
export function nativeSample(raw: string, status: string, sourceTime: bigint): NativeSample {
  const good = StatusCodeText.safeParse(status).success && qualityOfStatus(status) !== 'BAD';
  const value = good && RawNumberText.safeParse(raw).success ? canonicalDecimal(raw) : null;
  return { sourceTime: sourceTime.toString(), serverTime: sourceTime.toString(), raw, value, status };
}

/** The chunk with its hash recomputed (after a change of its subject, WRONG_BATCH). */
function rehashed(p: Record<string, unknown>): Record<string, unknown> {
  return { ...p, chunkHash: seriesChunkHash(p as unknown as SeriesChunkV1) };
}

export interface EmsModel {
  /** The last chunk number published per `room/tag`. */
  chunkNo: Map<string, number>;
  /** The sensors (`room/tag`) that stopped reporting, with their open FEED_GAP occurrence. */
  silent: Map<string, string>;
}

export function emsSimulator(clock?: FeedClock): { feed: SystemFeed; plugin: FeedPlugin; model: EmsModel } {
  const c = clock ?? systemClock();
  let wrong = 0;
  let gaps = 0;
  const model: EmsModel = { chunkNo: new Map(), silent: new Map() };
  const feed = new SystemFeed({
    system: 'EMS',
    clock: c,
    wrongIdentity: (type, p) => {
      const moved = { ...p, subjectCode: `NO-SUCH-ROOM-${(++wrong).toString()}` };
      return type === 'ems.series_chunk' ? rehashed(moved) : moved;
    },
  });
  const key = (room: unknown, tag: unknown) => `${String(room)}/${String(tag)}`;

  /** Publishes the EMS's own FEED_GAP occurrence of a room's sensor (RAISED or CLEARED). */
  function gapAlarm(room: string, tag: string, transition: 'RAISED' | 'CLEARED', occurrenceId: string) {
    const payload = {
      subjectKind: 'AREA', subjectCode: room, occurrenceId, transition, alarmCode: 'FEED_GAP', severity: '700', tag, value: null, limit: null, limitKind: 'STATE',
      message: transition === 'RAISED' ? `the ${tag} sensor of room ${room} stopped reporting (feed gap)` : `the ${tag} sensor of room ${room} reports again`,
      occurredAt: c.nowUs().toString(),
    };
    const parsed = EMS.inbound['ems.alarm']?.versions['1']?.safeParse(payload);
    if (!parsed?.success) throw new Error(`the FEED_GAP alarm does not match the EMS contract: ${parsed?.error.message ?? 'no schema'}`);
    return feed.publish('ems.alarm', `${room}/${occurrenceId}`, parsed.data as Record<string, unknown>);
  }

  const base = contractPlugin(feed, EMS, {
    prefix: 'ems',
    title: 'EMS simulator',
    routes: [
      {
        path: '/ems/v1/samples',
        messageType: 'ems.series_chunk',
        recordId: (p) => key(p['subjectCode'], p['tag']),
        complete(body) {
          const samples = Array.isArray(body['samples']) ? body['samples'] : [];
          const no = (model.chunkNo.get(key(body['roomCode'], body['tag'])) ?? 0) + 1;
          const chunk = {
            subjectKind: 'AREA' as const,
            subjectCode: typeof body['roomCode'] === 'string' ? body['roomCode'] : '',
            tag: typeof body['tag'] === 'string' ? body['tag'] : '',
            unit: unitOf(body['tag']) ?? '',
            chunkNo: no.toString(),
            samples: samples.map((s: unknown) => (isRecord(s) && typeof s['raw'] === 'string' ? nativeSample(s['raw'], typeof s['status'] === 'string' ? s['status'] : '0x00000000', c.nowUs()) : s)) as NativeSample[],
          };
          return { ...chunk, chunkHash: seriesChunkHash(chunk) };
        },
        published(p) {
          model.chunkNo.set(key(p['subjectCode'], p['tag']), Number(p['chunkNo']));
        },
      },
      {
        path: '/ems/v1/alarms',
        messageType: 'ems.alarm',
        recordId: (p) => `${String(p['subjectCode'])}/${String(p['occurrenceId'])}`,
        complete: (b) => ({
          subjectKind: 'AREA', subjectCode: b['roomCode'], occurrenceId: b['occurrenceId'], transition: b['transition'], alarmCode: b['alarmCode'], severity: b['severity'],
          tag: b['tag'] ?? null, value: b['value'] ?? null, limit: b['limit'] ?? null, limitKind: b['limitKind'] ?? null, message: b['message'], occurredAt: c.nowUs().toString(),
        }),
      },
    ],
    consoleRows: () => [
      ['Room sensors', [...model.chunkNo].map(([k, n]) => `${k} chunk ${n.toString()}`).join(', ') || 'none yet'],
      ['Sensors not reporting (FEED_GAP)', [...model.silent.keys()].join(', ') || 'none'],
    ],
    state: () => ({ chunkNo: Object.fromEntries(model.chunkNo), silent: Object.fromEntries(model.silent) }),
  });

  const plugin: FeedPlugin = {
    ...base,
    route(method, path, query, body) {
      if (method === 'POST' && path === '/ems/v1/samples' && isRecord(body) && model.silent.has(key(body['roomCode'], body['tag']))) {
        return { status: 409, body: { error: { code: 'SENSOR_SILENT', message: `the ${String(body['tag'])} sensor of room ${String(body['roomCode'])} is not reporting` } } };
      }
      if (method === 'POST' && path === '/ems/v1/sensor-gap') {
        if (!isRecord(body) || typeof body['roomCode'] !== 'string' || unitOf(body['tag']) === undefined || typeof body['on'] !== 'boolean') {
          return { status: 400, body: { error: { code: 'SCHEMA', message: `expected {roomCode, tag: ${EMS_TAGS.map((t) => t.tag).join('|')}, on: boolean}` } } };
        }
        const room = body['roomCode'];
        const tag = String(body['tag']);
        const k = key(room, tag);
        const open = model.silent.get(k);
        if (body['on'] === (open !== undefined)) return { status: 200, body: { unchanged: true } };
        const occurrence = open ?? `GAP-${(++gaps).toString()}-${c.nowUs().toString()}`;
        const env = gapAlarm(room, tag, body['on'] ? 'RAISED' : 'CLEARED', occurrence);
        if (body['on']) model.silent.set(k, occurrence);
        else model.silent.delete(k);
        return { status: 201, body: { sequenceNo: env.sequenceNo, idempotencyKey: env.idempotencyKey, payload: env.payload } };
      }
      return base.route(method, path, query, body);
    },
  };
  return { feed, plugin, model };
}
