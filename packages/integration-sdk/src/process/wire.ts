/**
 * Process equipment wire formats between the site gateway and the tablets server (Phase 3 slice 3a, G-06; the 3a
 * interface of docs/build-plan/phase-3/slice-3-plan.md). Same gateway authentication and session as the scale
 * uplink (bearer token of the gateway login, GATEWAY_UPLINK_PREFIX):
 *
 *   POST /gw/v1/process-readings              ProcessReadingsRequest: actual values, setpoint read-backs and alarms
 *   GET  /gw/v1/setpoint-downloads            SetpointDownloadsResponse: setpoints pending for this gateway's devices
 *   POST /gw/v1/setpoint-downloads/:id/ack    SetpointAckRequest: written and read back (or not), with the read-back
 *
 * Every value is decimal text in the tag's unit with at most the tag's fraction digits (never a JavaScript number);
 * `sourceTime` is the gateway's clock when the value was read, UTC epoch microseconds as text (as the scale wire's
 * sourceTimeUs); `sequence` is the gateway's counter per device (1, 2, 3, ... without gaps over the device's life on
 * this gateway, kept across restarts by the gateway's journal), so the server sees a lost, repeated or reordered
 * reading (DI-31). `sessionId` is the gateway's capture session: a UUID the gateway draws at each start, so a reading
 * delivered later from the journal still names the run of the gateway that took it.
 *
 * processReadingsProblems() is the pure validator of a request body: the schema plus the rules a schema cannot say
 * (known tag, the tag's unit, fraction digits, whole non-negative counters, read-backs only of setpoint tags, one
 * sequence number once per device and increasing within a batch).
 */
import { z } from 'zod';
import { DECIMAL_TEXT, scaleOf } from '../scale/decimal.ts';
import { shownValueProblem } from '../adapter/equipment-data.ts';
import { tagSpec } from './tags.ts';

export const PROCESS_READINGS_PATH = '/gw/v1/process-readings';
export const SETPOINT_DOWNLOADS_PATH = '/gw/v1/setpoint-downloads';
export const setpointAckPath = (id: string): string => `${SETPOINT_DOWNLOADS_PATH}/${encodeURIComponent(id)}/ack`;

/** GOOD: read from the device now; UNCERTAIN: the device flags the value; BAD: the device reports it invalid; STALE: the device stopped updating. */
export const ProcessQuality = z.enum(['GOOD', 'UNCERTAIN', 'BAD', 'STALE']);
export type ProcessQuality = z.infer<typeof ProcessQuality>;

/** ACTUAL: a measured value; SETPOINT_READBACK: the setpoint as the device reports it holds it; ALARM / ALARM_CLEARED: an alarm on the tag raised or cleared, with the tag's value then. */
export const ProcessReadingKind = z.enum(['ACTUAL', 'SETPOINT_READBACK', 'ALARM', 'ALARM_CLEARED']);
export type ProcessReadingKind = z.infer<typeof ProcessReadingKind>;

export const ProcessDecimal = z.string().regex(DECIMAL_TEXT, 'a decimal travels as plain decimal text');
export const ProcessSequence = z.string().regex(/^[1-9][0-9]{0,18}$/, 'a sequence number from 1, as text');
export const ProcessEpochMicros = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'UTC epoch microseconds as text');
export const DeviceSerial = z.string().regex(/^[\x21\x23-\x7E]{1,32}$/, 'a device serial number (printable, no quote)');
export const ProcessUnit = z.string().min(1).max(16);

/**
 * Phase 6 slice 6b (builder A; DI-32, DI-20): a reading taken over OPC UA keeps the device's original record with it:
 * the raw value text as the server sent it, the OPC UA status code, the source timestamp the server stamped, and the
 * enrolled endpoint (an INSTRUMENT of the device registry) whose session it came through. The value shown (`value`)
 * must state the raw value exactly (never a rounding; tablets 1210 checks it again). Absent for the JSON-lines stand-in.
 */
export const ProcessReadingNative = z.strictObject({
  raw: z.string().regex(/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$/, 'a number as the source wrote it').max(40),
  status: z.string().regex(/^0x[0-9A-F]{8}$/, 'an OPC UA status code such as 0x00000000'),
  deviceTime: z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'the source timestamp, UTC epoch microseconds as text'),
  endpointCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'the endpoint\'s device code'),
});
export type ProcessReadingNative = z.infer<typeof ProcessReadingNative>;

export const ProcessReading = z.strictObject({
  deviceSerial: DeviceSerial,
  tag: z.string().min(1).max(64),
  value: ProcessDecimal,
  unit: ProcessUnit,
  quality: ProcessQuality,
  sourceTime: ProcessEpochMicros,
  sequence: ProcessSequence,
  kind: ProcessReadingKind,
  native: ProcessReadingNative.optional(),
});
export type ProcessReading = z.infer<typeof ProcessReading>;

/** The most readings one request carries. */
export const PROCESS_BATCH_MAX = 200;

export const ProcessReadingsRequest = z.strictObject({
  sessionId: z.uuid(),
  readings: z.array(ProcessReading).min(1).max(PROCESS_BATCH_MAX),
});
export type ProcessReadingsRequest = z.infer<typeof ProcessReadingsRequest>;

/**
 * The server's answer to a batch: any 2xx answer means it holds every reading of the batch (a batch is taken whole or
 * refused whole, DI-31: never a partial transfer). Its members are the server's; the gateway reads none of them.
 */
export const ProcessReadingsResponse = z.looseObject({});

/** One setpoint the server asks the gateway to download to a device (members the gateway does not use are ignored). */
export const SetpointDownload = z.object({
  id: z.string().min(1).max(64),
  deviceSerial: DeviceSerial,
  tag: z.string().min(1).max(64),
  value: ProcessDecimal,
  unit: ProcessUnit,
});
export type SetpointDownload = z.infer<typeof SetpointDownload>;

export const SetpointDownloadsResponse = z.object({ downloads: z.array(SetpointDownload) });
export type SetpointDownloadsResponse = z.infer<typeof SetpointDownloadsResponse>;

/**
 * APPLIED: written and read back equal to the download; MISMATCH: written but the device reads back another value
 * (the read-back says which); FAILED: not written (device offline, refused the value, or the download names a device
 * or tag this gateway does not have), `message` says why.
 */
export const SetpointOutcome = z.enum(['APPLIED', 'MISMATCH', 'FAILED']);
export type SetpointOutcome = z.infer<typeof SetpointOutcome>;

export const SetpointAckRequest = z.strictObject({
  sessionId: z.uuid(),
  outcome: SetpointOutcome,
  /** The SETPOINT_READBACK reading sent for this download (also in process-readings), or null when nothing was read back. */
  readback: z
    .strictObject({ value: ProcessDecimal, unit: ProcessUnit, sourceTime: ProcessEpochMicros, sequence: ProcessSequence })
    .nullable(),
  message: z.string().min(1).max(500).nullable(),
});
export type SetpointAckRequest = z.infer<typeof SetpointAckRequest>;

/**
 * The rules of one reading a schema cannot say: a known tag, in its unit, with at most its fraction digits, a counter
 * never negative, a read-back only of a setpoint tag. Pure; empty when sound.
 */
export function processReadingProblems(r: Pick<ProcessReading, 'tag' | 'value' | 'unit' | 'kind'>): { field: 'tag' | 'unit' | 'value' | 'kind'; message: string }[] {
  const spec = tagSpec(r.tag);
  if (!spec) return [{ field: 'tag', message: `${r.tag} is not a process tag` }];
  const out: { field: 'tag' | 'unit' | 'value' | 'kind'; message: string }[] = [];
  if (r.unit !== spec.unit) out.push({ field: 'unit', message: `${r.tag} is in ${spec.unit}, not ${r.unit}` });
  if (!DECIMAL_TEXT.test(r.value)) out.push({ field: 'value', message: `${r.value} is not plain decimal text` });
  else if (scaleOf(r.value) > spec.scale) out.push({ field: 'value', message: `${r.tag} carries at most ${spec.scale} decimals` });
  if (spec.counter && r.value.startsWith('-')) out.push({ field: 'value', message: `${r.tag} is a count and never negative` });
  if (r.kind === 'SETPOINT_READBACK' && !spec.setpoint) out.push({ field: 'kind', message: `${r.tag} takes no setpoint` });
  return out;
}

export interface ProcessWireProblem {
  /** Where in the body: e.g. "readings.3.unit". */
  path: string;
  message: string;
}

/**
 * Validates a process-readings body: null when sound, otherwise every problem found. Pure (no clock, no I/O).
 * The sequence rule is per batch; continuity with what the server already holds is the server's check.
 */
export function processReadingsProblems(candidate: unknown): ProcessWireProblem[] | null {
  const parsed = ProcessReadingsRequest.safeParse(candidate);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  }
  const problems: ProcessWireProblem[] = [];
  const lastSeq = new Map<string, bigint>();
  parsed.data.readings.forEach((r, i) => {
    for (const p of processReadingProblems(r)) problems.push({ path: `readings.${i}.${p.field}`, message: p.message });
    if (r.native) {
      // DI-32: the value shown is the raw value the device sent, exactly (never a rounding of it).
      const problem = shownValueProblem(r.native.raw, r.value);
      if (problem) problems.push({ path: `readings.${i}.native.raw`, message: problem });
    }
    const seq = BigInt(r.sequence);
    const prev = lastSeq.get(r.deviceSerial);
    if (prev !== undefined && seq <= prev) {
      problems.push({ path: `readings.${i}.sequence`, message: `sequence ${r.sequence} of ${r.deviceSerial} does not follow ${prev.toString()} in this batch` });
    }
    lastSeq.set(r.deviceSerial, prev !== undefined && prev > seq ? prev : seq);
  });
  return problems.length > 0 ? problems : null;
}
