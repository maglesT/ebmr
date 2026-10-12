/**
 * Process readings for the device-to-entry path (Phase 4 slice 1b, D-P4-10), part of namespace `devices`: the recent
 * readings the step's bound press or coater sent, which a SETPOINT_READBACK, ACTUAL or ALARM entry may stand on. The
 * entry names only the reading (BLOCK_ENTRY data {source: 'EQUIPMENT', readingId}); the server claims it in the entry's
 * command and copies tag, value, unit, quality and receipt time from the stored reading (tablets 0820 and 1111: the step's
 * bound device, within the step's window, each reading once).
 */
import { z } from 'zod';
import { DecimalString, Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

export const ProcessReadingView = z.strictObject({
  readingId: Uuid,
  deviceCode: z.string(),
  kind: z.enum(['ACTUAL', 'SETPOINT_READBACK', 'ALARM', 'ALARM_CLEARED']),
  tag: z.string(),
  value: DecimalString,
  unit: z.string(),
  quality: z.string(),
  receivedAt: Instant,
  /** Whether an entry already stands on it (each reading is used once). */
  used: z.boolean(),
  /** Whether it is still inside the step's window (only such a reading can reach an entry). */
  current: z.boolean(),
});
export type ProcessReadingView = z.infer<typeof ProcessReadingView>;

export const deviceReadings = {
  processReadings: defineRoute({
    id: 'devices.processReadings',
    method: 'GET',
    path: '/api/devices/process-readings',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The latest readings of the process device a step of a batch is bound to (newest first, at most 50), for an entry from the equipment',
    query: z.strictObject({ batchId: Uuid, stepKey: z.string().min(1).max(200) }),
    response: z.strictObject({ deviceCode: z.string().nullable(), windowSeconds: z.number().int().nonnegative(), readings: z.array(ProcessReadingView) }),
  }),
} as const;
