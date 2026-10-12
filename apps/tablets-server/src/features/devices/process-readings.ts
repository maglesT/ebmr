/**
 * The device-to-entry path's read (Phase 4 slice 1b, D-P4-10): the latest readings of the process device a step of a batch
 * is bound to (tab.step_device, tablets 0820), newest first, each with whether an entry already stands on it and whether
 * it is still inside the step's window (tab.step_link_status's maxAgeUs, the age the claim of tablets 1111 allows). The
 * screen offers the current, unused ones; the entry then names only the reading (execution/block-entries.ts), and the
 * database decides when it is claimed.
 */
import type { HandlerContext } from '../../platform/http/bind.ts';
import type { AppContext } from '../../platform/context.ts';
import type { routes } from '@ebmr/api-contract';

type Ctx = HandlerContext<typeof routes.devices.processReadings>;

const LIMIT = 50;

/** The MBR node id of a step instance key (`p-coat@L-COAT=1` is node p-coat). */
export const stepOfKey = (stepKey: string): string => stepKey.split('@')[0] ?? stepKey;

export async function processReadings(app: AppContext, ctx: Ctx) {
  ctx.requireSession();
  const pool = app.pools.app;
  const step = stepOfKey(ctx.query.stepKey);
  const bound = await pool.query<{ device_code: string; process_device_id: string; bound_at: string }>(
    'select d.device_code, b.process_device_id, b.bound_at::text from tab.step_device b join tab.process_device d on d.id = b.process_device_id where b.batch_id = $1 and b.step = $2',
    [ctx.query.batchId, step],
  );
  const b = bound.rows[0];
  if (!b) return { deviceCode: null, windowSeconds: 0, readings: [] };
  const link = await pool.query<{ s: { maxAgeUs?: string; nowUs?: string } }>('select tab.step_link_status($1, $2) as s', [ctx.query.batchId, step]);
  const maxAge = BigInt(link.rows[0]?.s.maxAgeUs ?? '0');
  const now = BigInt(link.rows[0]?.s.nowUs ?? '0');
  const { rows } = await pool.query<{ id: string; kind: 'ACTUAL' | 'SETPOINT_READBACK' | 'ALARM' | 'ALARM_CLEARED'; tag: string; value: string; unit: string; quality: string; received_us: string; used: boolean }>(
    `select r.id, r.kind, r.tag, r.value, r.unit, r.quality, r.received_us::text as received_us,
            exists (select 1 from tab.process_reading_use u where u.reading_id = r.id) as used
       from tab.process_reading r
      where r.process_device_id = $1 and r.received_at >= $2::timestamptz
      order by r.received_at desc, r.id desc limit ${String(LIMIT)}`,
    [b.process_device_id, b.bound_at],
  );
  return {
    deviceCode: b.device_code,
    windowSeconds: Number(maxAge / 1_000_000n),
    readings: rows.map((r) => ({
      readingId: r.id,
      deviceCode: b.device_code,
      kind: r.kind,
      tag: r.tag,
      value: r.value,
      unit: r.unit,
      quality: r.quality,
      receivedAt: app.formatInstant(r.received_us),
      used: r.used,
      current: now - BigInt(r.received_us) <= maxAge,
    })),
  };
}
