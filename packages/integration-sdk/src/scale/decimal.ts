/**
 * Decimal text for weights (wire rule: GMP decimals travel as plain decimal text, never as JavaScript numbers).
 * Weights are handled as integer counts of 10^-scale (bigint), so no binary floating point touches a value.
 */

/** Plain decimal text: optional minus, no leading zeros, optional fraction; never an exponent. */
export const DECIMAL_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Number of fraction digits of a decimal text ("0.001" -> 3, "1" -> 0). */
export function scaleOf(text: string): number {
  if (!DECIMAL_TEXT.test(text)) throw new RangeError(`not a decimal: ${text}`);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Integer counts of 10^-scale; refuses a value with more fraction digits than `scale` (no silent rounding). */
export function toCounts(text: string, scale: number): bigint {
  if (!DECIMAL_TEXT.test(text)) throw new RangeError(`not a decimal: ${text}`);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [int = '0', frac = ''] = body.split('.');
  if (frac.length > scale) throw new RangeError(`${text} has more than ${scale} decimals`);
  const counts = BigInt(int + frac.padEnd(scale, '0'));
  return negative ? -counts : counts;
}

/** Decimal text of `counts` x 10^-scale with exactly `scale` fraction digits ("-0.000" becomes "0.000"). */
export function fromCounts(counts: bigint, scale: number): string {
  const negative = counts < 0n;
  const digits = (negative ? -counts : counts).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  const text = scale === 0 ? int : `${int}.${frac}`;
  return negative ? `-${text}` : text;
}

/** True when `value` is a whole multiple of `resolution` (both decimal text). */
export function isMultipleOf(value: string, resolution: string): boolean {
  const scale = Math.max(scaleOf(value), scaleOf(resolution));
  const step = toCounts(resolution, scale);
  if (step <= 0n) return false;
  return toCounts(value, scale) % step === 0n;
}
