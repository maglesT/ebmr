/**
 * Exact decimal literals for the static analyses (limit nesting, guard decision procedure, time
 * constraint network).
 *
 * These analyses only compare, add, subtract, halve and scale by integers; they never round. They run
 * on scaled bigints, so no GMP value ever passes through a JavaScript `number` and no floating-point
 * error can arise. Everything that rounds (limit comparison, display, calculations) goes through the
 * expression language (`ExpressionService`, @ebmr/expr). A property test proves this module orders
 * decimals exactly as the expression language does.
 */

/** Plain decimal literal: optional minus, no exponent, no leading zeros, trailing zeros allowed ("95.0"). */
const LITERAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export interface ScaledDecimal {
  /** The unscaled integer: value = digits / 10^scale. */
  digits: bigint;
  /** Number of fractional digits (a count). */
  scale: number;
}

export function isDecimalLiteral(text: unknown): text is string {
  if (typeof text !== 'string' || !LITERAL.test(text)) return false;
  // Negative zero ("-0", "-0.00") is not a meaningful GMP value.
  return !(text.startsWith('-') && /^-0(\.0+)?$/.test(text));
}

export function parseDecimal(text: string): ScaledDecimal {
  if (!isDecimalLiteral(text)) throw new RangeError(`${JSON.stringify(text)} is not a decimal literal`);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const whole = dot < 0 ? body : body.slice(0, dot);
  const fraction = dot < 0 ? '' : body.slice(dot + 1);
  const digits = BigInt(whole + fraction);
  return { digits: negative ? -digits : digits, scale: fraction.length };
}

/** Number of decimals as written ("95.0" -> 1, "105" -> 0). */
export function decimalsOf(text: string): number {
  return parseDecimal(text).scale;
}

function align(a: ScaledDecimal, b: ScaledDecimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.digits * 10n ** BigInt(scale - a.scale), b.digits * 10n ** BigInt(scale - b.scale), scale];
}

export function format(d: ScaledDecimal): string {
  const negative = d.digits < 0n;
  let text = (negative ? -d.digits : d.digits).toString();
  if (d.scale > 0) {
    text = text.padStart(d.scale + 1, '0');
    text = `${text.slice(0, text.length - d.scale)}.${text.slice(text.length - d.scale)}`;
  }
  return negative && d.digits !== 0n ? `-${text}` : text;
}

/** Canonical form: no trailing fractional zeros ("95.0" -> "95", "0.50" -> "0.5"). */
export function canonicalDecimal(text: string): string {
  let d = parseDecimal(text);
  while (d.scale > 0 && d.digits % 10n === 0n) d = { digits: d.digits / 10n, scale: d.scale - 1 };
  return format(d);
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = align(parseDecimal(a), parseDecimal(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: string, b: string): string {
  const [x, y, scale] = align(parseDecimal(a), parseDecimal(b));
  return format({ digits: x + y, scale });
}

export function subtractDecimal(a: string, b: string): string {
  const [x, y, scale] = align(parseDecimal(a), parseDecimal(b));
  return format({ digits: x - y, scale });
}

export function negateDecimal(a: string): string {
  const d = parseDecimal(a);
  return format({ digits: -d.digits, scale: d.scale });
}

/** Exact midpoint (a + b) / 2, one more decimal than the operands. */
export function midpointDecimal(a: string, b: string): string {
  const [x, y, scale] = align(parseDecimal(a), parseDecimal(b));
  return format({ digits: (x + y) * 5n, scale: scale + 1 });
}

/** One unit of the last written decimal place ("95.0" -> "0.1", "105" -> "1"). */
export function ulpOf(text: string): string {
  const { scale } = parseDecimal(text);
  return format({ digits: 1n, scale });
}

export function minDecimal(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>((m, v) => (m === undefined || compareDecimal(v, m) < 0 ? v : m), undefined);
}

export function maxDecimal(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>((m, v) => (m === undefined || compareDecimal(v, m) > 0 ? v : m), undefined);
}

// ---------------------------------------------------------------------------------------------
// Durations. Time constraints are GMP values (hold times, timers); they are converted exactly to
// bigint microseconds, the kernel's unit for instants and durations (kernel time module).

/** UCUM time units accepted for durations, with their exact size in microseconds. */
export const TIME_UNIT_MICROS: Readonly<Record<string, bigint>> = {
  ms: 1_000n,
  s: 1_000_000n,
  min: 60_000_000n,
  h: 3_600_000_000n,
  d: 86_400_000_000n,
};

export function isTimeUnit(unit: string): boolean {
  return Object.hasOwn(TIME_UNIT_MICROS, unit);
}

/**
 * Exact microseconds of a duration, or undefined when the unit is not a time unit or the value is
 * not a whole number of microseconds (a limit finer than a microsecond cannot be enforced).
 */
export function durationToMicros(value: string, unit: string): bigint | undefined {
  const factor = TIME_UNIT_MICROS[unit];
  if (factor === undefined || !isDecimalLiteral(value)) return undefined;
  const d = parseDecimal(value);
  const scaled = d.digits * factor;
  const divisor = 10n ** BigInt(d.scale);
  if (scaled % divisor !== 0n) return undefined;
  return scaled / divisor;
}

/** Microseconds rendered in the largest time unit that expresses them exactly (for messages). */
export function formatMicros(us: bigint): string {
  const negative = us < 0n;
  const abs = negative ? -us : us;
  const units: [string, bigint][] = [
    ['d', 86_400_000_000n],
    ['h', 3_600_000_000n],
    ['min', 60_000_000n],
    ['s', 1_000_000n],
    ['ms', 1_000n],
  ];
  for (const [unit, size] of units) {
    if (abs !== 0n && abs % size === 0n) return `${negative ? '-' : ''}${(abs / size).toString()} ${unit}`;
  }
  return `${negative ? '-' : ''}${format({ digits: abs, scale: 6 })} s`;
}
