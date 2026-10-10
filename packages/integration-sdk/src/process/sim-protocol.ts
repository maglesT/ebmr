/**
 * The process simulators' protocol `ebmr.sim-process.v1` (Phase 3 slice 3a), spoken by apps/simulators (press and
 * coater) and the site gateway's process driver. A stand-in for a PLC or OPC UA server: JSON over TCP, one object per
 * line, each line ended by LF, printable ASCII only, at most MAX_SIM_LINE characters; one request at a time, every
 * answer carries the request's `id`.
 *
 *   {"id":"1","op":"hello"}                          -> {"id":"1","ok":true,"protocol":"ebmr.sim-process.v1","serial":"PRESS-0001","equipment":"PRESS"}
 *   {"id":"2","op":"read"}                           -> {"id":"2","ok":true,"scan":"17","running":true,
 *                                                         "values":[{"tag":"force.main_kN","value":"12.48","unit":"kN","quality":"GOOD"}, ...],
 *                                                         "setpoints":[{"tag":"force.main_kN","value":"12.50","unit":"kN"}, ...],
 *                                                         "alarms":[{"code":"MAIN_FORCE_HIGH","tag":"force.main_kN"}]}
 *   {"id":"3","op":"write","tag":"force.main_kN","value":"14.00"}
 *                                                    -> {"id":"3","ok":true}
 *   any refusal                                      -> {"id":"3","ok":false,"error":"NOT_A_SETPOINT","message":"..."}
 *
 * `scan` is the controller's scan counter: it advances with every scan, so a device whose values stopped (a frozen
 * controller or a stale data source) shows as a counter that does not move. `setpoints` are the setpoints as the
 * device reads them back; `alarms` the alarms active now. A line that is not exactly this is a protocol error, never
 * interpreted.
 */
import { z } from 'zod';
import { EQUIPMENT_KINDS } from './tags.ts';
import { DeviceSerial, ProcessDecimal, ProcessQuality, ProcessUnit } from './wire.ts';

export const SIM_PROCESS_PROTOCOL = 'ebmr.sim-process.v1';
export const MAX_SIM_LINE = 8192;
const PRINTABLE = /^[\x20-\x7E]*$/;

const Id = z.string().regex(/^[0-9]{1,18}$/);
const Tag = z.string().min(1).max(64);

export const SimRequest = z.discriminatedUnion('op', [
  z.strictObject({ id: Id, op: z.literal('hello') }),
  z.strictObject({ id: Id, op: z.literal('read') }),
  z.strictObject({ id: Id, op: z.literal('write'), tag: Tag, value: ProcessDecimal }),
]);
export type SimRequest = z.infer<typeof SimRequest>;

export const SimValue = z.strictObject({ tag: Tag, value: ProcessDecimal, unit: ProcessUnit, quality: ProcessQuality.exclude(['STALE']) });
export type SimValue = z.infer<typeof SimValue>;
export const SimSetpoint = z.strictObject({ tag: Tag, value: ProcessDecimal, unit: ProcessUnit });
export type SimSetpoint = z.infer<typeof SimSetpoint>;
export const SimAlarm = z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/), tag: Tag });
export type SimAlarm = z.infer<typeof SimAlarm>;

export const SimHello = z.strictObject({ id: Id, ok: z.literal(true), protocol: z.literal(SIM_PROCESS_PROTOCOL), serial: DeviceSerial, equipment: z.enum(EQUIPMENT_KINDS) });
export type SimHello = z.infer<typeof SimHello>;
export const SimSample = z.strictObject({
  id: Id,
  ok: z.literal(true),
  scan: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  running: z.boolean(),
  values: z.array(SimValue),
  setpoints: z.array(SimSetpoint),
  alarms: z.array(SimAlarm),
});
export type SimSample = z.infer<typeof SimSample>;
export const SimWritten = z.strictObject({ id: Id, ok: z.literal(true) });
export const SimRefusal = z.strictObject({ id: Id, ok: z.literal(false), error: z.string().regex(/^[A-Z_]{2,40}$/), message: z.string().max(500) });
export type SimRefusal = z.infer<typeof SimRefusal>;

export class SimProtocolError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'SimProtocolError';
  }
}

export function encodeSimLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function json(line: string): unknown {
  if (line.length > MAX_SIM_LINE) throw new SimProtocolError('the line is too long', line.slice(0, 128));
  if (!PRINTABLE.test(line)) throw new SimProtocolError('the line holds bytes outside printable ASCII', line.slice(0, 128));
  try {
    return JSON.parse(line);
  } catch {
    throw new SimProtocolError('the line is not JSON', line.slice(0, 128));
  }
}

/** A request as the simulator receives it; throws SimProtocolError when it is not one. */
export function parseSimRequest(line: string): SimRequest {
  const parsed = SimRequest.safeParse(json(line));
  if (!parsed.success) throw new SimProtocolError('not a request of the protocol', line.slice(0, 128));
  return parsed.data;
}

export type SimWritten = z.infer<typeof SimWritten>;
export type SimAnswer = SimHello | SimSample | SimWritten | SimRefusal;

/** The answer to `request` as the driver receives it; throws SimProtocolError on anything else (or another id). */
export function parseSimAnswer(request: SimRequest, line: string): SimAnswer {
  const value = json(line);
  const refusal = SimRefusal.safeParse(value);
  if (refusal.success) return checkId(request, refusal.data, line);
  const schema = request.op === 'hello' ? SimHello : request.op === 'read' ? SimSample : SimWritten;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SimProtocolError(`not an answer to ${request.op}`, line.slice(0, 128));
  return checkId(request, parsed.data, line);
}

function checkId<A extends SimAnswer>(request: SimRequest, answer: A, line: string): A {
  if (answer.id !== request.id) throw new SimProtocolError(`the answer is to request ${answer.id}, not ${request.id}`, line.slice(0, 128));
  return answer;
}

/** Splits a byte stream into LF-ended lines (a CR before the LF is dropped); a line over MAX_SIM_LINE goes to onGarbage. */
export class JsonLineFramer {
  private buffer = '';
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onGarbage: (fragment: string) => void = () => undefined,
  ) {}

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1');
    for (;;) {
      const i = this.buffer.indexOf('\n');
      if (i < 0) break;
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      if (line.length > 0) this.onLine(line);
    }
    if (this.buffer.length > MAX_SIM_LINE) {
      const fragment = this.buffer;
      this.buffer = '';
      this.onGarbage(fragment.slice(0, 128));
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
