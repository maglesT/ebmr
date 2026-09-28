/**
 * MT-SICS codec (Mettler Toledo Standard Interface Command Set, level 0/1 subset) for the scale simulator, the
 * site gateway's driver and the server's raw-string check (DI-32: the stored raw line must match the value).
 *
 * Host commands: S (stable weight), SI (weight immediately), T (tare), Z (zero), I4 (serial number), @ (reset).
 * Balance responses, one line each, terminated by CR LF:
 *   "S S <value> <unit>"   stable weight          "S D <value> <unit>"   dynamic (not stable) weight
 *   "T S <value> <unit>"   tare taken             "S I" / "T I" / "Z I"  command not executable now
 *   "S +" / "S -"          overload / underload   "Z A"                  zero set
 *   "I4 A \"<serial>\""    serial number          "ES" / "ET" / "EL"     syntax / transmission / logic error
 * The weight field is right-aligned in 10 characters. Every line is printable ASCII; anything else is a
 * protocol error (a garbled line is never interpreted as a weight).
 */
import { DECIMAL_TEXT } from './decimal.ts';

export const MT_SICS_COMMANDS = ['S', 'SI', 'T', 'Z', 'I4', '@'] as const;
export type MtSicsCommand = (typeof MT_SICS_COMMANDS)[number];

export const LINE_END = '\r\n';
/** Longest response line accepted; longer input is garbage. */
export const MAX_LINE_LENGTH = 128;
const PRINTABLE = /^[\x20-\x7E]*$/;
export const UNIT_PATTERN = /^[A-Za-z]{1,5}$/;
export const SERIAL_PATTERN = /^[\x21\x23-\x7E]{1,32}$/;

export type MtSicsResponse =
  /** A weight line: S S / S D (after S or SI), T S (after T). */
  | { kind: 'WEIGHT'; command: 'S' | 'T'; stability: 'S' | 'D'; value: string; unit: string; raw: string }
  /** A status-only line: not executable (I), overload (+), underload (-), acknowledged (A). */
  | { kind: 'STATUS'; command: 'S' | 'T' | 'Z' | 'I4'; status: 'A' | 'I' | '+' | '-'; raw: string }
  | { kind: 'SERIAL'; serial: string; raw: string }
  | { kind: 'ERROR'; code: 'ES' | 'ET' | 'EL'; raw: string };

export class MtSicsProtocolError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'MtSicsProtocolError';
  }
}

export function encodeCommand(command: MtSicsCommand): string {
  return `${command}${LINE_END}`;
}

/** Parses a command line as the balance receives it (simulator); null when it is not a known command. */
export function parseCommand(line: string): MtSicsCommand | null {
  const text = line.trim();
  return (MT_SICS_COMMANDS as readonly string[]).includes(text) ? (text as MtSicsCommand) : null;
}

const WEIGHT = /^(S|T) (S|D) +(-?[0-9]+(?:\.[0-9]+)?) ([A-Za-z]{1,5})$/;
const STATUS = /^(S|T|Z|I4) (A|I|\+|-)$/;
const SERIAL = /^I4 A "([\x21\x23-\x7E]{1,32})"$/;
const ERROR = /^(ES|ET|EL)$/;

/**
 * Parses one response line (without its CR LF). Throws MtSicsProtocolError for anything that is not a
 * well-formed response, so a garbled line never becomes a value.
 */
export function parseResponse(line: string): MtSicsResponse {
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) throw new MtSicsProtocolError('empty or over-long response line', line);
  if (!PRINTABLE.test(line)) throw new MtSicsProtocolError('response line holds non-printable characters', line);
  let m = WEIGHT.exec(line);
  if (m) {
    const value = m[3] ?? '';
    if (!DECIMAL_TEXT.test(value)) throw new MtSicsProtocolError(`weight field ${value} is not a plain decimal`, line);
    return { kind: 'WEIGHT', command: m[1] as 'S' | 'T', stability: m[2] as 'S' | 'D', value, unit: m[4] ?? '', raw: line };
  }
  m = SERIAL.exec(line);
  if (m) return { kind: 'SERIAL', serial: m[1] ?? '', raw: line };
  m = STATUS.exec(line);
  if (m) {
    const command = m[1] as 'S' | 'T' | 'Z' | 'I4';
    const status = m[2] as 'A' | 'I' | '+' | '-';
    if (command === 'I4' && status !== 'I') throw new MtSicsProtocolError('I4 A without a serial number', line);
    return { kind: 'STATUS', command, status, raw: line };
  }
  m = ERROR.exec(line);
  if (m) return { kind: 'ERROR', code: m[1] as 'ES' | 'ET' | 'EL', raw: line };
  throw new MtSicsProtocolError('not an MT-SICS response', line);
}

/** A weight line exactly as a balance writes it (weight field right-aligned in 10 characters). */
export function formatWeight(command: 'S' | 'T', stability: 'S' | 'D', value: string, unit: string): string {
  if (!DECIMAL_TEXT.test(value)) throw new RangeError(`not a decimal: ${value}`);
  if (!UNIT_PATTERN.test(unit)) throw new RangeError(`not a unit: ${unit}`);
  return `${command} ${stability} ${value.padStart(10, ' ')} ${unit}`;
}

export function formatStatus(command: 'S' | 'T' | 'Z' | 'I4', status: 'A' | 'I' | '+' | '-'): string {
  if (command === 'I4' && status === 'A') throw new RangeError('I4 A carries a serial: use formatSerial');
  return `${command} ${status}`;
}

export function formatSerial(serial: string): string {
  if (!SERIAL_PATTERN.test(serial)) throw new RangeError(`not a serial number: ${serial}`);
  return `I4 A "${serial}"`;
}

export function formatError(code: 'ES' | 'ET' | 'EL'): string {
  return code;
}

/** What a stored raw line says about a weighing, in reading terms (the server's DI-32 cross-check). */
export interface RawInterpretation {
  value: string | null;
  unit: string | null;
  stable: boolean;
  status: 'OK' | 'UNSTABLE' | 'OVERLOAD' | 'UNDERLOAD' | 'ERROR';
}

/** Interprets the raw line of a weight request (S or SI). Throws for a garbled line. */
export function interpretWeightLine(raw: string): RawInterpretation {
  const r = parseResponse(raw);
  if (r.kind === 'WEIGHT' && r.command === 'S') {
    return r.stability === 'S' ? { value: r.value, unit: r.unit, stable: true, status: 'OK' } : { value: r.value, unit: r.unit, stable: false, status: 'UNSTABLE' };
  }
  if (r.kind === 'STATUS' && r.command === 'S' && r.status === '+') return { value: null, unit: null, stable: false, status: 'OVERLOAD' };
  if (r.kind === 'STATUS' && r.command === 'S' && r.status === '-') return { value: null, unit: null, stable: false, status: 'UNDERLOAD' };
  return { value: null, unit: null, stable: false, status: 'ERROR' };
}

/**
 * Line framing for a byte stream: collects bytes, splits on LF (a preceding CR is dropped) and keeps each line
 * exactly as received. A line longer than MAX_LINE_LENGTH is reported as garbage rather than buffered forever.
 */
export class LineFramer {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void, private readonly onGarbage: (fragment: string) => void = () => undefined) {}

  push(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');
    for (;;) {
      const lf = this.buffer.indexOf('\n');
      if (lf < 0) break;
      let line = this.buffer.slice(0, lf);
      this.buffer = this.buffer.slice(lf + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.onLine(line);
    }
    if (this.buffer.length > MAX_LINE_LENGTH) {
      const fragment = this.buffer;
      this.buffer = '';
      this.onGarbage(fragment);
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
