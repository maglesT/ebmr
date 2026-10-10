/**
 * The printer simulator's protocol `ebmr.sim-printer.v1` (Phase 3 slice 4a), spoken by apps/simulators (a line printer
 * or coder with its code reader and vision system) and the site gateway's printer driver. Same framing as
 * `ebmr.sim-process.v1`: JSON over TCP, one object per LF-ended line, printable ASCII only, at most MAX_SIM_LINE
 * characters, one request at a time, every answer carries the request's `id`.
 *
 *   {"id":"1","op":"hello"}                     -> {"id":"1","ok":true,"protocol":"ebmr.sim-printer.v1","serial":"PRN-0001","boot":"7"}
 *   {"id":"2","op":"load","job":{"jobId":"J-1","layoutRef":"CARTON-EU-v3","fields":{"batch":"B123",...}}}
 *                                               -> {"id":"2","ok":true,"echo":{"jobId":"J-1","layoutRef":"CARTON-EU-v3","fields":{...}}}
 *   {"id":"3","op":"clear"}                     -> {"id":"3","ok":true}
 *   {"id":"4","op":"read"}                      -> {"id":"4","ok":true,"scan":"17","running":true,"jobId":"J-1","printed":"40"}
 *   {"id":"5","op":"events","after":"12"}       -> {"id":"5","ok":true,"events":[{"no":"13","jobId":"J-1","kind":"VISION_RESULT","value":"PASS"}],"more":false}
 *   any refusal                                 -> {"id":"5","ok":false,"error":"NO_JOB","message":"..."}
 *
 * `boot` names the printer's power cycle: event numbers `no` run 1, 2, 3, ... within one boot, so a reader that
 * remembers (boot, last no) takes every event exactly once across its own restarts. `scan` advances with every scan
 * of the controller (a counter that stops moving is a stale device). `printed` counts the units printed on the job
 * held since it was loaded. Events are the printer's own: reader, vision and challenge results and its faults.
 */
import { z } from 'zod';
import { DeviceSerial } from '../process/wire.ts';
import { MAX_SIM_LINE, SimProtocolError } from '../process/sim-protocol.ts';
import { JobId, PrintFields } from './wire.ts';

export const SIM_PRINTER_PROTOCOL = 'ebmr.sim-printer.v1';
/** The most events one `events` answer carries (more follow with `more: true`). */
export const SIM_EVENTS_MAX = 40;
const PRINTABLE = /^[\x20-\x7E]*$/;

const Id = z.string().regex(/^[0-9]{1,18}$/);
const Count = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const Layout = z.string().min(1).max(64).regex(PRINTABLE);

export const SimPrinterJob = z.strictObject({ jobId: JobId, layoutRef: Layout, fields: PrintFields });
export type SimPrinterJob = z.infer<typeof SimPrinterJob>;

export const SimPrinterRequest = z.discriminatedUnion('op', [
  z.strictObject({ id: Id, op: z.literal('hello') }),
  z.strictObject({ id: Id, op: z.literal('load'), job: SimPrinterJob }),
  z.strictObject({ id: Id, op: z.literal('clear') }),
  z.strictObject({ id: Id, op: z.literal('read') }),
  z.strictObject({ id: Id, op: z.literal('events'), after: Count }),
]);
export type SimPrinterRequest = z.infer<typeof SimPrinterRequest>;

export const SimPrinterEventKind = z.enum(['READER_RESULT', 'VISION_RESULT', 'CHALLENGE_RESULT', 'FAULT']);
export type SimPrinterEventKind = z.infer<typeof SimPrinterEventKind>;
export const SimPrinterEvent = z.strictObject({
  no: z.string().regex(/^[1-9][0-9]{0,17}$/),
  jobId: JobId.nullable(),
  kind: SimPrinterEventKind,
  value: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/),
});
export type SimPrinterEvent = z.infer<typeof SimPrinterEvent>;

export const SimPrinterHello = z.strictObject({ id: Id, ok: z.literal(true), protocol: z.literal(SIM_PRINTER_PROTOCOL), serial: DeviceSerial, boot: Count });
export type SimPrinterHello = z.infer<typeof SimPrinterHello>;
export const SimPrinterLoaded = z.strictObject({ id: Id, ok: z.literal(true), echo: SimPrinterJob });
export type SimPrinterLoaded = z.infer<typeof SimPrinterLoaded>;
export const SimPrinterCleared = z.strictObject({ id: Id, ok: z.literal(true) });
export type SimPrinterCleared = z.infer<typeof SimPrinterCleared>;
export const SimPrinterStatus = z.strictObject({ id: Id, ok: z.literal(true), scan: Count, running: z.boolean(), jobId: JobId.nullable(), printed: Count });
export type SimPrinterStatus = z.infer<typeof SimPrinterStatus>;
export const SimPrinterEvents = z.strictObject({ id: Id, ok: z.literal(true), events: z.array(SimPrinterEvent).max(SIM_EVENTS_MAX), more: z.boolean() });
export type SimPrinterEvents = z.infer<typeof SimPrinterEvents>;
export const SimPrinterRefusal = z.strictObject({ id: Id, ok: z.literal(false), error: z.string().regex(/^[A-Z_]{2,40}$/), message: z.string().max(500) });
export type SimPrinterRefusal = z.infer<typeof SimPrinterRefusal>;

export type SimPrinterAnswer = SimPrinterHello | SimPrinterLoaded | SimPrinterCleared | SimPrinterStatus | SimPrinterEvents | SimPrinterRefusal;

function json(line: string): unknown {
  if (line.length > MAX_SIM_LINE) throw new SimProtocolError('the line is too long', line.slice(0, 128));
  if (!PRINTABLE.test(line)) throw new SimProtocolError('the line holds bytes outside printable ASCII', line.slice(0, 128));
  try {
    return JSON.parse(line);
  } catch {
    throw new SimProtocolError('the line is not JSON', line.slice(0, 128));
  }
}

/** A request as the printer simulator receives it; throws SimProtocolError when it is not one. */
export function parseSimPrinterRequest(line: string): SimPrinterRequest {
  const parsed = SimPrinterRequest.safeParse(json(line));
  if (!parsed.success) throw new SimProtocolError('not a request of the printer protocol', line.slice(0, 128));
  return parsed.data;
}

const ANSWER: Record<SimPrinterRequest['op'], z.ZodType<SimPrinterAnswer>> = {
  hello: SimPrinterHello,
  load: SimPrinterLoaded,
  clear: SimPrinterCleared,
  read: SimPrinterStatus,
  events: SimPrinterEvents,
};

/** The answer to `request` as the driver receives it; throws SimProtocolError on anything else (or another id). */
export function parseSimPrinterAnswer(request: SimPrinterRequest, line: string): SimPrinterAnswer {
  const value = json(line);
  const refusal = SimPrinterRefusal.safeParse(value);
  const parsed = refusal.success ? refusal : ANSWER[request.op].safeParse(value);
  if (!parsed.success) throw new SimProtocolError(`not an answer to ${request.op}`, line.slice(0, 128));
  if (parsed.data.id !== request.id) throw new SimProtocolError(`the answer is to request ${parsed.data.id}, not ${request.id}`, line.slice(0, 128));
  return parsed.data;
}
