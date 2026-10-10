/**
 * Namespace `devices` (C5; both installations since Phase 3 slice 2b, each with its own gateways): scales behind the site gateway (Phase 2 apps plan section 10).
 * A capture is a trigger, not a user's GMP write: the gateway journals the reading, the server ingests it
 * under the integration identity, and the committing G-07 or G-22 entry claims it by id.
 */
import { z } from 'zod';
import { DecimalString, Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

export const ScaleStatusView = z.strictObject({
  deviceCode: z.string(),
  roomCode: z.string().nullable(),
  /** OFFLINE after a heartbeat gap over 10 s: the step then offers only the manual two-person path. */
  status: z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']),
  lastHeartbeat: Instant.nullable(),
  gatewayCode: z.string().nullable(),
  resolution: DecimalString.nullable(),
  unit: z.string().nullable(),
});
export type ScaleStatusView = z.infer<typeof ScaleStatusView>;

export const ReadingView = z.strictObject({
  readingId: Uuid,
  deviceCode: z.string(),
  gatewayCode: z.string(),
  value: DecimalString,
  unit: z.string(),
  stable: z.boolean(),
  status: z.enum(['OK', 'UNSTABLE', 'OVERLOAD', 'UNDERLOAD', 'OFFLINE', 'ERROR']),
  /** The raw line from the instrument (MT-SICS), kept with the value (DI-32). */
  raw: z.string(),
  sourceTime: Instant.nullable(),
  recordedAt: Instant,
  trust: z.enum(['DEVICE_SYNCED', 'DEVICE_UNSYNCED']),
  purpose: z.enum(['TARE', 'GROSS', 'CHECK']).nullable(),
});
export type ReadingView = z.infer<typeof ReadingView>;

/** One live display sample (SSE); display only, never recorded. */
export const LiveReadingEvent = z.strictObject({
  deviceCode: z.string(),
  value: DecimalString.nullable(),
  unit: z.string().nullable(),
  stable: z.boolean(),
  status: z.enum(['OK', 'UNSTABLE', 'OVERLOAD', 'UNDERLOAD', 'OFFLINE', 'ERROR']),
});

export const devices = {
  scales: defineRoute({
    id: 'devices.scales',
    method: 'GET',
    path: '/api/devices/scales',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Scales of a room with their status',
    query: z.strictObject({ room: z.string().optional() }),
    response: z.strictObject({ scales: z.array(ScaleStatusView) }),
  }),
  capture: defineRoute({
    id: 'devices.capture',
    method: 'POST',
    path: '/api/devices/scales/:code/capture',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'Ask the gateway for a stable reading; returns it once ingested (claimed later by the committing entry)',
    params: z.strictObject({ code: z.string().min(1) }),
    body: z.strictObject({ purpose: z.enum(['TARE', 'GROSS', 'CHECK']) }),
    response: ReadingView,
  }),
  live: defineRoute({
    id: 'devices.live',
    method: 'GET',
    path: '/api/devices/scales/:code/live',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    stream: 'SSE',
    summary: 'Live display stream of a scale (server-sent events; display only, "live, not recorded")',
    params: z.strictObject({ code: z.string().min(1) }),
    response: LiveReadingEvent,
  }),
} as const;
