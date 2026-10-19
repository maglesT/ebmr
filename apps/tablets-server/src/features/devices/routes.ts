/**
 * Browser routes of the `devices` namespace (sandbox; module C5):
 *  - GET  /api/devices/scales?room            scales of a room (default: the terminal's room) with their status;
 *  - POST /api/devices/scales/:code/capture   a trigger, not a GMP write by the person: the gateway takes a stable
 *    reading, journals it, uplinks it under its integration identity; the answer is the ReadingView once the row
 *    exists. The committing G-07/G-22 entry claims it by id (DeviceReadingPort), so capture needs no badge tap. When
 *    the gateway's API cannot be reached, the database records it and shows the gateway's scales OFFLINE until the
 *    server reaches it again, so the manual two-person path opens instead of both paths being refused (DI-30, PR-20;
 *    review finding P51); any answer of the gateway records it reachable;
 *  - GET  /api/devices/scales/:code/live      SSE relay of the gateway's live display ("live, not recorded"); an
 *    open stream ends when the site policy site.zone changes while the server runs, and the browser's reconnect is
 *    refused like every API request (SITE_ZONE_CHANGED, DI-27). It also follows its session as each new request does
 *    (SSE-SESSION; DI-38, DI-16): every LIVE_SESSION_RECHECK_MS the session gate is asked again, and the stream ends,
 *    with an `end` event naming the refusal, once the session is locked (by the person or by the idle time), signed
 *    out, switched to another person, expired, or works in a role no longer granted (which ends the session too).
 * The browser never supplies a value, a device or a time: everything in a ReadingView comes from the reading row.
 * Capture and live display are for the scale of the terminal's own room only (DI-20).
 */
import type { FastifyInstance } from 'fastify';
import { routes, type ReadingView } from '@ebmr/api-contract';
import type { LiveSample } from '@ebmr/integration-sdk/scale';
import type { AppContext } from '../../platform/context.ts';
import { admitSession, bindRoutes, type HandlerContext } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import { resolveSession, type ResolvedSession } from '../../platform/auth/session.ts';
import { SITE_ZONE_CHANGED } from '../../platform/site-zone.ts';
import { DEVICES_GUIDANCE } from './guidance.ts';
import { scaleStatusRows, scaleStatuses, type ScaleStatusRow } from './port.ts';
import { runtimeOf } from './runtime.ts';
import { processReadings } from './process-readings.ts';
import { stepBindingHandlers } from './step-bindings.ts';

interface ReadingRow {
  id: string;
  device_code: string;
  gateway_code: string;
  value: string | null;
  unit: string | null;
  stable: boolean;
  status: ReadingView['status'];
  raw: string;
  source_time_us: string;
  recorded_us: string;
  trust: ReadingView['trust'];
  purpose: ReadingView['purpose'];
}

export async function readingRow(app: AppContext, readingId: string): Promise<ReadingRow | null> {
  const { rows } = await app.pools.app.query<ReadingRow>(
    `select id, device_code, gateway_code, value, unit, stable, status, raw, source_time_us::text as source_time_us,
            recorded_us::text as recorded_us, trust, purpose
       from tab.device_reading where id = $1`,
    [readingId],
  );
  return rows[0] ?? null;
}

export function readingView(app: AppContext, r: ReadingRow): ReadingView | null {
  if (r.value === null || r.unit === null) return null;
  return {
    readingId: r.id,
    deviceCode: r.device_code,
    gatewayCode: r.gateway_code,
    value: r.value,
    unit: r.unit,
    stable: r.stable,
    status: r.status,
    raw: r.raw,
    sourceTime: app.formatInstant(r.source_time_us),
    recordedAt: app.formatInstant(r.recorded_us),
    trust: r.trust,
    purpose: r.purpose,
  };
}

const guided = (code: keyof typeof DEVICES_GUIDANCE, why: string, details?: Record<string, string>) => {
  const g = DEVICES_GUIDANCE[code];
  if (!g) throw new Error(`no guidance for ${code}`);
  return refusal(
    g.status,
    { code, kind: g.kind, whatHappened: g.whatHappened, why, controls: g.controls ?? [], whatYouCanDo: g.whatYouCanDo, whoCanHelp: g.whoCanHelp, ...(details ? { details } : {}) },
    g.retryable ?? false,
  );
};

/** The scale of the session's room with this code (DI-20); refused for a scale elsewhere. */
async function scaleInRoom(app: AppContext, session: ResolvedSession, code: string): Promise<ScaleStatusRow> {
  if (session.roomCode === null) throw guided('SCALE_NOT_IN_ROOM', 'This terminal is not registered to a room, so it cannot use a scale.');
  const scale = (await scaleStatusRows(app, session.roomCode)).find((s) => s.deviceCode === code);
  if (!scale) throw guided('SCALE_NOT_IN_ROOM', `${code} is not a scale of room ${session.roomCode}.`);
  return scale;
}

async function capture(ctx: HandlerContext<typeof routes.devices.capture>): Promise<ReadingView> {
  const app = ctx.app;
  const session = ctx.requireSession();
  const scale = await scaleInRoom(app, session, ctx.params.code);
  if (scale.status !== 'ONLINE') {
    throw guided('SCALE_OFFLINE', `${scale.deviceCode} is ${scale.status === 'UNKNOWN' ? 'not reporting yet' : 'offline'}: ${scale.reason ?? 'no heartbeat from the site gateway in the last 10 seconds, or a serial mismatch'}.`);
  }
  const runtime = runtimeOf(app);
  const answer = await runtime.capture(scale.gatewayCode, scale.deviceCode, { purpose: ctx.body.purpose });
  if ('unreachable' in answer) {
    // DI-30, PR-20 (P51): the heartbeat still says ONLINE, but no capture can reach the gateway. The database records
    // it and shows the scale OFFLINE until the server reaches the gateway again, so the manual path is open meanwhile.
    await runtime.recordApiContact(scale.gatewayCode, false, answer.unreachable);
    throw guided('SCALE_OFFLINE', `The site gateway could not be reached: ${answer.unreachable}. The scale is shown offline until the server reaches the gateway again.`);
  }
  await runtime.recordApiContact(scale.gatewayCode, true, 'a capture was answered');
  if (answer.outcome === 'FAILED') {
    const details: Record<string, string> = { error: answer.error };
    if (answer.reading) details['readingId'] = answer.reading.readingId;
    if (answer.error === 'DEVICE_OFFLINE' || answer.error === 'SERIAL_MISMATCH' || answer.error === 'NOT_READY' || answer.error === 'UNKNOWN_DEVICE') {
      throw guided('SCALE_OFFLINE', answer.message, details);
    }
    throw guided('CAPTURE_FAILED', answer.message, details);
  }
  const readingId = answer.reading.readingId;
  const present = await runtime.waitForIngest(readingId, 5000, async () => (await readingRow(app, readingId)) !== null);
  const row = present ? await readingRow(app, readingId) : null;
  if (!row) throw guided('READING_NOT_RECEIVED', `Reading ${readingId} has not been received from the gateway.`, { readingId });
  // The row is the only source of what the browser sees; it must be the scale and purpose asked for.
  if (row.device_code !== scale.deviceCode || row.purpose !== ctx.body.purpose) {
    throw guided('CAPTURE_FAILED', `The gateway answered with a reading of ${row.device_code} for ${row.purpose ?? 'no purpose'}.`);
  }
  const view = readingView(app, row);
  if (!view || row.status !== 'OK') throw guided('CAPTURE_FAILED', `The scale reported ${row.status}.`, { readingId });
  return view;
}

/**
 * How often an open live display asks the session gate again (SSE-SESSION): the most a stream outlives a lock, a
 * sign-out or a withdrawn role. One indexed read of the session binding per open stream; a terminal shows at most a few.
 */
export const LIVE_SESSION_RECHECK_MS = 2_000;

/** Why the server ends an open live display (the `end` event's data): a refusal's code and texts. */
export interface LiveStreamEnd {
  code: string;
  whatHappened?: string;
  why?: string;
}

/**
 * Why an open live display of session `tokenHash` must end now: the refusal a new request of the stream's route would
 * get (admitSession, the request gate itself), or null while the session still serves it. A database that cannot be
 * asked ends the stream too (fail closed).
 */
export async function liveStreamEnd(app: AppContext, tokenHash: string): Promise<LiveStreamEnd | null> {
  try {
    await admitSession(app, routes.devices.live.id, await resolveSession(app.pools.app, tokenHash));
    return null;
  } catch (error) {
    if (error instanceof HttpRefusal) return { code: error.refusal.code, whatHappened: error.refusal.whatHappened, why: error.refusal.why };
    return { code: 'SESSION_NOT_CHECKED', whatHappened: 'The session could not be checked, so the live display ended.' };
  }
}

async function live(ctx: HandlerContext<typeof routes.devices.live>): Promise<LiveSample> {
  const app = ctx.app;
  const session = ctx.requireSession();
  const scale = await scaleInRoom(app, session, ctx.params.code);
  const first: LiveSample = { deviceCode: scale.deviceCode, value: null, unit: scale.unit, stable: false, status: scale.status === 'ONLINE' ? 'UNSTABLE' : 'OFFLINE' };
  app.siteZone.current(); // DI-27: a change noticed since the request began is still refused as a request
  const reply = ctx.reply;
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-ebmr-installation': app.installation,
    'x-content-type-options': 'nosniff',
  });
  let ended = false;
  const send = (sample: LiveSample) => {
    if (!ended && !raw.writableEnded) raw.write(`data: ${JSON.stringify(sample)}\n\n`);
  };
  send(first);
  const unsubscribe = runtimeOf(app).live.subscribe(scale.gatewayCode, scale.deviceCode, send);
  const keepAlive = setInterval(() => {
    if (!raw.writableEnded) raw.write(': keep-alive\n\n');
  }, 15_000);
  let offZoneChange = (): void => undefined;
  // SSE-SESSION (DI-38, DI-16): the session is asked again while the stream is open, as each new request would ask it.
  let checking = false;
  const recheck = setInterval(() => {
    if (checking || ended) return;
    checking = true;
    void liveStreamEnd(app, session.tokenHash)
      .then((why) => {
        if (why !== null) end(why);
      })
      .finally(() => {
        checking = false;
      });
  }, LIVE_SESSION_RECHECK_MS);
  /** Ends the stream; `why` says why when the server ends it (an `end` event; the browser shows no more samples). */
  const end = (why?: LiveStreamEnd) => {
    if (ended) return;
    ended = true;
    clearInterval(keepAlive);
    clearInterval(recheck);
    unsubscribe();
    offZoneChange();
    if (!raw.writableEnded) {
      if (why !== undefined) raw.write(`event: end\ndata: ${JSON.stringify(why)}\n\n`);
      raw.end();
    }
  };
  raw.once('close', () => end());
  // DI-27: after a change of the site's time zone the server shows nothing until it restarts; the stream ends too.
  offZoneChange = app.siteZone.onChange(() => end({ code: SITE_ZONE_CHANGED }));
  // The reply is hijacked, so bindRoutes sends nothing more; the stream ends when the browser leaves.
  return first;
}

export function bindDeviceRoutes(scope: FastifyInstance, app: AppContext): void {
  bindRoutes(scope, app, routes.devices, {
    async scales(ctx) {
      const session = ctx.requireSession();
      const room = ctx.query.room ?? session.roomCode;
      return { scales: await scaleStatuses(app, room) };
    },
    capture,
    live,
    processReadings: (ctx) => processReadings(app, ctx),
    // Phase 7 slice 7g (WP4): the step's device and equipment bindings and the setpoint download.
    ...stepBindingHandlers(app),
  });
}
