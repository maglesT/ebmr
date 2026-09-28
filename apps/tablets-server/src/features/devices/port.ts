/**
 * The DeviceReadingPort (platform/ports.ts) over tab.claim_readings and tab.scale_status (module C5).
 *
 * claim(client, {readingIds, room, maxAgeUs, purpose}) runs inside the caller's kernel command (C3's command
 * transaction; the actor must be a person holding STEP.EXECUTE or DISPENSE.EXECUTE where they are, never an
 * administrator). For each reading, in order, the database checks that it exists; is a stable weight (status OK);
 * comes from an ACTIVE INSTRUMENT registered to `room` (DI-20) and bound to an active gateway key; belongs to
 * this installation kind; is at most `maxAgeUs` old at database time, counting the time it waited at the gateway
 * (a reading replayed after a gateway restart has no known wait and is never claimable); was captured for the
 * same purpose when the purpose is TARE, GROSS or CHECK (any other purpose text is recorded only); and has not
 * been used. It inserts tab.reading_use (unique reading id) in the caller's transaction and returns the facts in
 * the order of `readingIds`. A refusal raises an EBMR-DEV-1xx error that aborts the caller's transaction; a
 * DI-20 location or blocked-device refusal is also alerted in a separate transaction, so the alert survives.
 *
 * The use row commits with the caller's transaction: a reading referenced by a committed command, accepted or
 * refused, stays used (a reading id appears in at most one command row); a retry needs a new capture.
 *
 * scaleStatus(room): the room's scale for the step-screen header, or null when the room has none. ONLINE only
 * when the gateway's last heartbeat, at database time, is at most 10 s old and reported the instrument connected
 * with its registered serial; UNKNOWN before the first heartbeat; OFFLINE otherwise (then only the manual
 * two-person path is offered).
 */
import type pg from 'pg';
import { commands } from '@ebmr/kernel';
import type { ScaleStatusView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { ClaimedReading, DeviceReadingPort, ReadingClaim } from '../../platform/ports.ts';

interface ScaleStatusRow {
  deviceCode: string;
  roomCode: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  lastHeartbeatUs: string | null;
  gatewayCode: string;
  resolution: string;
  unit: string;
}

/** Location and device refusals whose alert must survive the rolled-back command. */
const ALERTED_CODES = new Set(['EBMR-DEV-103']);

export async function scaleStatuses(app: AppContext, room: string | null): Promise<ScaleStatusView[]> {
  const { rows } = await app.pools.app.query<{ s: ScaleStatusRow[] }>('select tab.scale_status($1) as s', [room]);
  return (rows[0]?.s ?? []).map((r) => ({
    deviceCode: r.deviceCode,
    roomCode: r.roomCode,
    status: r.status,
    lastHeartbeat: r.lastHeartbeatUs === null ? null : app.formatInstant(r.lastHeartbeatUs),
    gatewayCode: r.gatewayCode,
    resolution: r.resolution,
    unit: r.unit,
  }));
}

export function createDeviceReadingPort(app: AppContext): DeviceReadingPort {
  return {
    async claim(client: pg.PoolClient, claim: ReadingClaim): Promise<ClaimedReading[]> {
      const ids = [...claim.readingIds];
      try {
        const { rows } = await client.query<{ r: { readingId: string; value: string; unit: string; raw: string; deviceCode: string; sourceTimeUs: string | null; trust: ClaimedReading['trust'] }[] }>(
          'select tab.claim_readings($1::uuid[], $2, $3::bigint, $4) as r',
          [ids, claim.room, claim.maxAgeUs.toString(), claim.purpose],
        );
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
        const code = commands.errorCode(error);
        if (code && ALERTED_CODES.has(code)) {
          // The caller's transaction is lost; record the DI-20 alert on its own connection (facts re-derived in SQL).
          await app.pools.app.query('select tab.alert_claim_refusal($1::uuid[], $2, $3)', [ids.filter(isUuid), claim.room, code]).catch(() => undefined);
        }
        throw commands.asKernelError(error);
      }
    },
    async scaleStatus(room: string | null): Promise<ScaleStatusView | null> {
      if (room === null) return null;
      return (await scaleStatuses(app, room))[0] ?? null;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID.test(s);
}
