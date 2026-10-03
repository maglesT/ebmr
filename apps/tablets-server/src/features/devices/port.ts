/**
 * The DeviceReadingPort (platform/ports.ts) over tab.claim_readings and tab.scale_status (module C5).
 *
 * claim(client, {readingIds, room, maxAgeUs, purpose}) runs inside the caller's kernel command (C3's command
 * transaction; the actor must be a person holding STEP.EXECUTE or DISPENSE.EXECUTE where they are, never an
 * administrator). For each reading, in order, the database checks that it exists; still carries its proof (the hash
 * of its stored content, the gateway's Ed25519 signature under the enrolled key, a raw line stating its value; else
 * EBMR-DEV-110); is a stable weight (status OK); comes from an ACTIVE INSTRUMENT registered to the room of the actor
 * session's terminal as the database knows it, never the caller's word (`room` must name that same room; a terminal
 * with no room, or another room, is EBMR-DEV-103; DI-20), bound to an active gateway key; belongs to this
 * installation kind; is at most `maxAgeUs` old at database time, or the platform setting device.reading_max_age_s if
 * that is less (default 120 s, allowed 5-120 s; the caller can only ask for fresher readings: tablets 0360, F38),
 * counting the time it waited at the gateway and at
 * the server before and during ingestion (the gateway's wait as it signed it over a challenge the database issued for
 * the upload, plus the database's own time from that challenge to the insert: tablets 0330; a reading replayed after
 * a gateway restart has no known wait and is never claimable), and, when its trust is DEVICE_SYNCED, by the capture
 * time the gateway signed, within a stated clock
 * tolerance (tablets 0320; DI-28); was captured for the same purpose when the purpose is TARE, GROSS or CHECK (any
 * other purpose text is recorded only); and has not been used. It inserts tab.reading_use (unique reading id) in the
 * caller's transaction and returns the facts in the order of `readingIds`. A refusal raises an EBMR-DEV-1xx error that
 * aborts the caller's transaction. A DI-20 location or blocked-device refusal (EBMR-DEV-103) is also alerted durably:
 * after the command rolls back, the platform's command wrapper runs a guarded command of its own under the same actor
 * (platform/db/commands.ts afterRollback), in which tab.alert_refused_claim takes the session, the person and the
 * session's room from the validated actor and the balance's room from the registry (review finding P49).
 *
 * The use row commits with the caller's transaction: a reading used by a committed command, accepted or refused, stays
 * used (a reading is used by at most one command row); a retry needs a new capture. A command from a screen that shows
 * an older run version is refused (ENG-STALE) and recorded, but uses none of its readings: the server names them with
 * peekWeighing (Phase 2 exit review F58, F58.1).
 *
 * peekWeighing(client, {tareReadingId, grossReadingId, room, maxAgeUs}): the facts the claims of a weighing would
 * return, the tare as TARE then the gross as GROSS, after every check those claims make, made as the command makes them
 * (in one transaction, so a reading named as both is refused as the gross claim refuses it, EBMR-DEV-105), with nothing
 * used: tab.peek_weighing_readings makes both claims inside one subtransaction and rolls it back (tablets 0510).
 * Refusals and the durable alert of a DI-20 refusal are those of claim. The row of a stale command lists these readings
 * as named (evidence.namedReadings), never as used, and the database checks the pair again for that row (tablets 0510).
 *
 * scaleStatus(room): the room's scale for the step-screen header and the scale the step captures from. ONLINE only
 * when the gateway's last heartbeat, at database time, is at most 10 s old and reported the instrument connected (and
 * able to capture and deliver) with its registered serial, the server reaches the gateway's API, and the server has not
 * refused a reading of the gateway key's chain since the last one it ingested (tablets 0320, review finding P51);
 * UNKNOWN before the first heartbeat; OFFLINE otherwise, with the reason (then only the manual two-person path is
 * offered). A room may hold several scales (tab.bind_instrument allows it), and the MBR binds a step to an equipment
 * class, not to one instrument, so the answer is (DI-30, DI-32, PR-20, ALCOA accuracy; review finding P50):
 *  - an ONLINE scale of the room whenever one is (the first by device code among them): the header and the capture
 *    name a scale that can be used;
 *  - the room's only scale, whatever its status, when the room has exactly one;
 *  - null when the room has no scale, or several and none of them online, rather than whichever sorts first, or last
 *    reported.
 *
 * scales(room): every scale of the room with its status. C3's manual two-person path refuses hand-keyed weights while
 * any of them is ONLINE, checks the balance the operator names against them and stores them with the row; the database
 * checks the same again inside the command, serialised with the heartbeats of the room (tablets 0310, EBMR-EXE-074).
 */
import type pg from 'pg';
import { commands } from '@ebmr/kernel';
import type { ScaleStatusView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { afterRollback, withActorCommand } from '../../platform/db/commands.ts';
import type { ClaimedReading, DeviceReadingPort, ReadingClaim, WeighingReadings } from '../../platform/ports.ts';

export interface ScaleStatusRow {
  deviceCode: string;
  roomCode: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  /** Why the scale cannot be captured from now (null when ONLINE), as the database says (tablets 0320). */
  reason: string | null;
  lastHeartbeatUs: string | null;
  gatewayCode: string;
  resolution: string;
  unit: string;
}

/** Location and device refusals whose alert must survive the rolled-back command. */
const ALERTED_CODES = new Set(['EBMR-DEV-103']);

/** The scales of `room` (every room when null) as tab.scale_status answers, with the reason a scale is not ONLINE. */
export async function scaleStatusRows(app: AppContext, room: string | null): Promise<ScaleStatusRow[]> {
  const { rows } = await app.pools.app.query<{ s: ScaleStatusRow[] }>('select tab.scale_status($1) as s', [room]);
  return rows[0]?.s ?? [];
}

export async function scaleStatuses(app: AppContext, room: string | null): Promise<ScaleStatusView[]> {
  return (await scaleStatusRows(app, room)).map((r) => ({
    deviceCode: r.deviceCode,
    roomCode: r.roomCode,
    status: r.status,
    lastHeartbeat: r.lastHeartbeatUs === null ? null : app.formatInstant(r.lastHeartbeatUs),
    gatewayCode: r.gatewayCode,
    resolution: r.resolution,
    unit: r.unit,
  }));
}

/**
 * `sql` (tab.claim_readings, or tab.peek_weighing_readings: the checks of the claims, nothing used) on the readings
 * `ids` for `room`, inside the caller's command transaction: the facts in the order of the ids, or the claim's refusal
 * (with the durable alert of a DI-20 refusal, for the readings named; tab.alert_refused_claim alerts those whose balance
 * or room the claim refuses).
 */
async function readingsOf(client: pg.PoolClient, ids: readonly string[], room: string | null, sql: string, params: unknown[]): Promise<ClaimedReading[]> {
  const malformed = ids.find((id) => !isUuid(id));
  if (malformed !== undefined) throw new commands.KernelError('EBMR-DEV-101', `EBMR-DEV-101 DI-32: ${malformed} is not a reading id`);
  try {
    const { rows } = await client.query<{ r: { readingId: string; value: string; unit: string; raw: string; deviceCode: string; sourceTimeUs: string | null; trust: ClaimedReading['trust'] }[] }>(sql, params);
    return (rows[0]?.r ?? []).map((r) => ({
      readingId: r.readingId,
      value: r.value,
      unit: r.unit,
      raw: r.raw,
      deviceCode: r.deviceCode,
      sourceTimeUs: r.sourceTimeUs === null ? null : BigInt(r.sourceTimeUs),
      trust: r.trust,
    }));
  } catch (error) {
    const refusal = commands.asKernelError(error);
    const code = commands.errorCode(error);
    if (code && ALERTED_CODES.has(code)) {
      // DI-20: the caller's transaction is lost. Once it has rolled back, the command wrapper records the alert in a
      // guarded command of its own under the same actor; the database takes the session and its room from that
      // validated actor, never from here (tablets 0320).
      const named = [...new Set(ids)];
      afterRollback(refusal, async (pool, actor) => {
        await withActorCommand(pool, actor, (c) => c.query('select tab.alert_refused_claim($1::uuid[], $2)', [named, room]));
      });
    }
    throw refusal;
  }
}

export function createDeviceReadingPort(app: AppContext): DeviceReadingPort {
  return {
    claim(client: pg.PoolClient, claim: ReadingClaim): Promise<ClaimedReading[]> {
      const ids = [...claim.readingIds];
      return readingsOf(client, ids, claim.room, 'select tab.claim_readings($1::uuid[], $2, $3::bigint, $4) as r', [ids, claim.room, claim.maxAgeUs.toString(), claim.purpose]);
    },
    peekWeighing(client: pg.PoolClient, w: WeighingReadings): Promise<ClaimedReading[]> {
      return readingsOf(client, [w.tareReadingId, w.grossReadingId], w.room, 'select tab.peek_weighing_readings($1::uuid, $2::uuid, $3, $4::bigint) as r', [
        w.tareReadingId,
        w.grossReadingId,
        w.room,
        w.maxAgeUs.toString(),
      ]);
    },
    async scaleStatus(room: string | null): Promise<ScaleStatusView | null> {
      if (room === null) return null;
      const scales = await scaleStatuses(app, room);
      const online = scales.find((s) => s.status === 'ONLINE');
      if (online) return online;
      return scales.length === 1 ? (scales[0] ?? null) : null;
    },
    scales(room: string): Promise<ScaleStatusView[]> {
      return scaleStatuses(app, room);
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID.test(s);
}
