/**
 * Printer and coder wire formats between the site gateway and the tablets server (Phase 3 slice 4a, G-21, K-20; the
 * 4a interface of docs/build-plan/phase-3/slice-4-plan.md). Same gateway authentication, session and delivery rules
 * as the process uplink (bearer token of the gateway login):
 *
 *   GET  /gw/v1/print-jobs              PrintJobsResponse: the jobs the server released for this gateway's printers
 *   POST /gw/v1/print-jobs/:id/ack      PrintJobAckRequest: the printer's echo of the loaded job, LOADED or not
 *   POST /gw/v1/print-events            PrintEventsRequest: printed counts, reader, vision and challenge results, faults
 *
 * The variable data of a job (batch, dates, MRP, GTIN or NDC, serial pool) always comes from the record; the gateway
 * loads it on the printer as given and never makes or changes a value (PR-36: no keying at the device). The printer
 * echoes what it holds; any difference from the job refuses the load (MISMATCH) and the gateway clears the printer.
 *
 * Dates are the record's calendar dates, `YYYY-MM-DD` or `YYYY-MM` (month precision), never formatted for a market:
 * the layout (`layoutRef`) renders them, plain and uncoded for India-domestic packs (IN-31). Counts and amounts are
 * decimal text, never JavaScript numbers. `sourceTime` is the gateway's clock in UTC epoch microseconds as text;
 * `sequence` is the gateway's counter per printer (1, 2, 3, ... without gaps, kept across restarts by the journal),
 * so the server sees a lost, repeated or reordered event (DI-31). `sessionId` is the gateway's capture session.
 */
import { z } from 'zod';
import { DECIMAL_TEXT, scaleOf } from '../scale/decimal.ts';
import { DeviceSerial, ProcessEpochMicros, ProcessSequence } from '../process/wire.ts';

export const PRINT_JOBS_PATH = '/gw/v1/print-jobs';
export const PRINT_EVENTS_PATH = '/gw/v1/print-events';
export const printJobAckPath = (id: string): string => `${PRINT_JOBS_PATH}/${encodeURIComponent(id)}/ack`;

const PRINTABLE = /^[\x20-\x7E]*$/;

/** A calendar date of the record: YYYY-MM-DD, or YYYY-MM for a month-precision date (an expiry by month). */
export const RecordDate = z
  .string()
  .regex(/^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$/, 'a record date YYYY-MM-DD or YYYY-MM')
  .refine((s) => s.length === 7 || validDay(s), 'not a calendar date');

function validDay(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return d >= 1 && d <= days;
}

/** The GS1 check digit of a GTIN (mod 10, weights 3 and 1 from the right, check digit excluded). */
export function gs1CheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  for (let i = 0; i < digitsWithoutCheck.length; i += 1) {
    const d = digitsWithoutCheck.charCodeAt(digitsWithoutCheck.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** A GTIN-14 with a valid GS1 check digit. */
export const Gtin = z
  .string()
  .regex(/^[0-9]{14}$/, 'a GTIN of 14 digits')
  .refine((g) => gs1CheckDigit(g.slice(0, 13)) === Number(g.slice(13)), 'the GTIN check digit is wrong');

/** A US NDC with its hyphens: 10 digits (4-4-2, 5-3-2, 5-4-1) or the 12-digit format (6-4-2). */
export const Ndc = z.string().regex(/^([0-9]{4}-[0-9]{4}-[0-9]{2}|[0-9]{5}-[0-9]{3}-[0-9]{2}|[0-9]{5}-[0-9]{4}-[0-9]{1}|[0-9]{6}-[0-9]{4}-[0-9]{2})$/, 'an NDC with hyphens (4-4-2, 5-3-2, 5-4-1 or 6-4-2)');

/** A batch (lot) number as the record holds it: upper-case letters, digits, '-', '/' and '.'. */
export const BatchText = z.string().regex(/^[A-Z0-9][A-Z0-9/.-]{0,19}$/, 'a batch number (A-Z, 0-9, - / ., at most 20)');

/** Maximum retail price for India-domestic packs, in rupees as decimal text (at most 2 decimals, positive). */
export const MrpText = z
  .string()
  .regex(DECIMAL_TEXT, 'an MRP as decimal text')
  .refine((s) => !s.startsWith('-') && scaleOf(s) <= 2 && !/^0(\.0*)?$/.test(s), 'an MRP is positive with at most 2 decimals');

export const JobId = z.string().regex(/^[\x21-\x7E]{1,64}$/, 'a job id (printable, no space)');

/** The variable data of a print job, from the record. Optional members are absent, never null or empty. */
export const PrintFields = z.strictObject({
  batch: BatchText,
  mfgDate: RecordDate,
  expiryDate: RecordDate,
  mrp: MrpText.optional(),
  gtin: Gtin.optional(),
  ndc: Ndc.optional(),
  serialPoolId: z.string().regex(/^[\x21-\x7E]{1,64}$/).optional(),
});
export type PrintFields = z.infer<typeof PrintFields>;

export const PRINT_FIELD_NAMES = ['batch', 'mfgDate', 'expiryDate', 'mrp', 'gtin', 'ndc', 'serialPoolId'] as const;
export type PrintFieldName = (typeof PRINT_FIELD_NAMES)[number];

/** One job the server released for a printer of this gateway. */
export const PrintJob = z.object({
  id: JobId,
  deviceSerial: DeviceSerial,
  packagingOrder: z.string().min(1).max(64).regex(PRINTABLE),
  artworkSet: z.string().min(1).max(64).regex(PRINTABLE),
  fields: PrintFields,
  layoutRef: z.string().min(1).max(64).regex(PRINTABLE),
});
export type PrintJob = z.infer<typeof PrintJob>;

/**
 * The list as the gateway first reads it: each job is then checked on its own (PrintJob), so one job the gateway
 * cannot take is acknowledged FAILED and does not hide the others.
 */
export const PrintJobsResponse = z.object({ jobs: z.array(z.looseObject({ id: JobId })) });
export type PrintJobsResponse = z.infer<typeof PrintJobsResponse>;

/** LOADED: the printer holds the job and echoes it unchanged; MISMATCH: it echoes something else (the gateway clears it); FAILED: not loaded. */
export const PrintJobOutcome = z.enum(['LOADED', 'MISMATCH', 'FAILED']);
export type PrintJobOutcome = z.infer<typeof PrintJobOutcome>;

export const PrintJobAckRequest = z.strictObject({
  sessionId: z.uuid(),
  outcome: PrintJobOutcome,
  /** The fields as the printer echoed them (null when nothing was loaded or echoed). */
  echoedFields: PrintFields.nullable(),
  /** The gateway's clock when the echo (or the failure) arrived. */
  sourceTime: ProcessEpochMicros,
  /** Why, for MISMATCH and FAILED; null for LOADED. */
  message: z.string().min(1).max(500).nullable(),
});
export type PrintJobAckRequest = z.infer<typeof PrintJobAckRequest>;

/**
 * PRINTED_COUNT: units printed on the job since it was loaded, cumulative, whole decimal text (a repeated value adds
 * nothing); READER_RESULT / VISION_RESULT: the code reader's or vision system's verdict on a printed unit, PASS or FAIL;
 * CHALLENGE_RESULT: a challenge of the reader or vision system with a known-bad test unit, PASS (rejected as it must
 * be) or FAIL; FAULT: a fault code (upper-case, e.g. OFFLINE, STALE, MISPRINT), its end as `<code>_CLEARED`.
 */
export const PrintEventKind = z.enum(['PRINTED_COUNT', 'READER_RESULT', 'VISION_RESULT', 'CHALLENGE_RESULT', 'FAULT']);
export type PrintEventKind = z.infer<typeof PrintEventKind>;

export const PRINT_RESULT = /^(PASS|FAIL)$/;
export const FAULT_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const COUNT = /^(0|[1-9][0-9]{0,17})$/;

export const PrintEvent = z.strictObject({
  deviceSerial: DeviceSerial,
  /** The job the printer held; null only for a FAULT while no job was loaded. */
  jobId: JobId.nullable(),
  kind: PrintEventKind,
  value: z.string().min(1).max(48),
  sourceTime: ProcessEpochMicros,
  sequence: ProcessSequence,
});
export type PrintEvent = z.infer<typeof PrintEvent>;

/** The most events one request carries. */
export const PRINT_EVENTS_BATCH_MAX = 200;

export const PrintEventsRequest = z.strictObject({
  sessionId: z.uuid(),
  events: z.array(PrintEvent).min(1).max(PRINT_EVENTS_BATCH_MAX),
});
export type PrintEventsRequest = z.infer<typeof PrintEventsRequest>;

/** Any 2xx answer means the server holds every event of the batch (taken whole or refused whole); the gateway reads none of its members. */
export const PrintWireResponse = z.looseObject({});

/** The rules of one event a schema cannot say: the value's form for its kind, a job for everything but a FAULT. Pure; empty when sound. */
export function printEventProblems(e: Pick<PrintEvent, 'kind' | 'value' | 'jobId'>): { field: 'value' | 'jobId'; message: string }[] {
  const out: { field: 'value' | 'jobId'; message: string }[] = [];
  if (e.kind === 'PRINTED_COUNT' && !COUNT.test(e.value)) out.push({ field: 'value', message: `a printed count is whole non-negative decimal text, not ${e.value}` });
  if ((e.kind === 'READER_RESULT' || e.kind === 'VISION_RESULT' || e.kind === 'CHALLENGE_RESULT') && !PRINT_RESULT.test(e.value)) out.push({ field: 'value', message: `${e.kind} is PASS or FAIL, not ${e.value}` });
  if (e.kind === 'FAULT' && !FAULT_CODE.test(e.value)) out.push({ field: 'value', message: `a fault is an upper-case code, not ${e.value}` });
  if (e.kind !== 'FAULT' && e.jobId === null) out.push({ field: 'jobId', message: `${e.kind} belongs to a job` });
  return out;
}

export interface PrintWireProblem {
  path: string;
  message: string;
}

/** Validates a print-events body: null when sound, otherwise every problem. Pure. The sequence rule is per batch (continuity is the server's check). */
export function printEventsProblems(candidate: unknown): PrintWireProblem[] | null {
  const parsed = PrintEventsRequest.safeParse(candidate);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  const problems: PrintWireProblem[] = [];
  const lastSeq = new Map<string, bigint>();
  parsed.data.events.forEach((e, i) => {
    for (const p of printEventProblems(e)) problems.push({ path: `events.${i}.${p.field}`, message: p.message });
    const seq = BigInt(e.sequence);
    const prev = lastSeq.get(e.deviceSerial);
    if (prev !== undefined && seq <= prev) problems.push({ path: `events.${i}.sequence`, message: `sequence ${e.sequence} of ${e.deviceSerial} does not follow ${prev.toString()} in this batch` });
    lastSeq.set(e.deviceSerial, prev !== undefined && prev > seq ? prev : seq);
  });
  return problems.length > 0 ? problems : null;
}

/** Validates an acknowledgement body: null when sound. LOADED carries the echo and no message; MISMATCH carries both; FAILED a message. */
export function printJobAckProblems(candidate: unknown): PrintWireProblem[] | null {
  const parsed = PrintJobAckRequest.safeParse(candidate);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  const a = parsed.data;
  const problems: PrintWireProblem[] = [];
  if (a.outcome !== 'FAILED' && a.echoedFields === null) problems.push({ path: 'echoedFields', message: `${a.outcome} carries the printer's echo` });
  if (a.outcome === 'LOADED' && a.message !== null) problems.push({ path: 'message', message: 'LOADED carries no message' });
  if (a.outcome !== 'LOADED' && a.message === null) problems.push({ path: 'message', message: `${a.outcome} says why` });
  return problems.length > 0 ? problems : null;
}

/** The fields whose echo differs from the job (absent on one side and present on the other counts). Pure; empty when equal. */
export function echoMismatches(sent: PrintFields, echoed: PrintFields): PrintFieldName[] {
  return PRINT_FIELD_NAMES.filter((k) => sent[k] !== echoed[k]);
}
