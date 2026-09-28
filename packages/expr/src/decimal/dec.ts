/**
 * Dec: the only number type for GMP values (quantities, limits, yields, results).
 *
 * - Backed by its own decimal.js clone at 34 significant digits (IEEE 754 decimal128 precision),
 *   never the global decimal.js configuration, so no other code can change how we round.
 * - Arithmetic results are the exact result correctly rounded to 34 significant digits, half-even
 *   (decimal.js rounds + - * / and sqrt correctly). Compendial rounding (half-up at a limit's
 *   decimals or significant figures) is a separate, explicit step (rounding/rounding.ts).
 * - Values are created only from decimal strings. A JavaScript number is refused at the boundary:
 *   binary floating point cannot hold 94.95 exactly.
 * - A value never holds more than 34 significant digits, NaN, an infinity or a negative zero.
 * - Canonical text: no exponent, no leading zeros, no trailing fractional zeros, no "+", no "-0"
 *   (the kernel's canonical decimal form, packages/kernel/src/market/decimal.ts).
 * - Converting a Dec to a JavaScript number is impossible by design (toPrimitive throws).
 */
import Decimal from 'decimal.js';

export const DEC_SIGNIFICANT_DIGITS = 34;
/** Parsed values must lie within 10^-1000 .. 10^1000 (keeps canonical text bounded). */
const MAX_PARSE_EXPONENT = 1000;
const MAX_TEXT_LENGTH = 400;

const D = Decimal.clone({
  precision: DEC_SIGNIFICANT_DIGITS,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -9e15,
  maxE: 9e15,
  modulo: Decimal.ROUND_DOWN,
  crypto: false,
});
type DInstance = InstanceType<typeof D>;

export type DecErrorCode =
  | 'DEC_NOT_A_STRING'
  | 'DEC_SYNTAX'
  | 'DEC_TOO_PRECISE'
  | 'DEC_EXPONENT_RANGE'
  | 'DEC_DIVISION_BY_ZERO'
  | 'DEC_DOMAIN'
  | 'DEC_NOT_FINITE'
  | 'DEC_UNDERFLOW'
  | 'DEC_NOT_A_SAFE_INTEGER';

export class DecError extends Error {
  readonly code: DecErrorCode;
  constructor(code: DecErrorCode, message: string) {
    super(message);
    this.name = 'DecError';
    this.code = code;
  }
}

/** Rounding directions used by explicit rounding steps (never by ordinary arithmetic). */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN' | 'CEILING' | 'FLOOR';

const MODE: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
  CEILING: Decimal.ROUND_CEIL,
  FLOOR: Decimal.ROUND_FLOOR,
};

const SYNTAX = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

function finite(r: DInstance, what: string): DInstance {
  if (!r.isFinite()) throw new DecError('DEC_NOT_FINITE', `${what} is outside the representable range`);
  return r.isZero() && r.isNegative() ? new D(0) : r;
}

export class Dec {
  /** decimal.js value; normalised (no -0), finite, at most 34 significant digits. */
  private readonly d: DInstance;

  private constructor(d: DInstance) {
    this.d = d;
  }

  static readonly ZERO = new Dec(new D(0));
  static readonly ONE = new Dec(new D(1));
  static readonly HUNDRED = new Dec(new D(100));

  /**
   * Parses a decimal string exactly ("94.95", "-0.5", "1e-6"). Refuses JavaScript numbers, NaN,
   * infinities, "+" signs, blanks and values with more than 34 significant digits.
   */
  static parse(text: string): Dec {
    const value: unknown = text;
    if (typeof value !== 'string') {
      throw new DecError('DEC_NOT_A_STRING', `GMP values must be decimal strings, never a JavaScript ${typeof value} (binary floating point is not exact)`);
    }
    if (value.length === 0 || value.length > MAX_TEXT_LENGTH || !SYNTAX.test(value)) {
      throw new DecError('DEC_SYNTAX', `"${value.slice(0, 40)}" is not a decimal number (digits, an optional point and fraction, an optional exponent)`);
    }
    const d = new D(value);
    if (!d.isZero() && (d.e > MAX_PARSE_EXPONENT || d.e < -MAX_PARSE_EXPONENT)) {
      throw new DecError('DEC_EXPONENT_RANGE', `"${value.slice(0, 40)}" is outside 1e-${MAX_PARSE_EXPONENT} .. 1e${MAX_PARSE_EXPONENT}`);
    }
    if (d.sd() > DEC_SIGNIFICANT_DIGITS) {
      throw new DecError('DEC_TOO_PRECISE', `"${value.slice(0, 40)}" has more than ${DEC_SIGNIFICANT_DIGITS} significant digits and cannot be held exactly`);
    }
    return new Dec(finite(d, value));
  }

  /** True if `text` parses (without throwing). */
  static isValid(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    try {
      Dec.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  /** A count or index (never a measured GMP value) as a Dec. Only safe integers are accepted. */
  static fromInteger(n: number | bigint): Dec {
    if (typeof n === 'bigint') return Dec.fromScaled(n, 0);
    if (!Number.isSafeInteger(n)) throw new DecError('DEC_NOT_A_SAFE_INTEGER', `${String(n)} is not a safe integer count`);
    return new Dec(new D(n));
  }

  /**
   * coefficient x 10^exponent, exactly. Refuses results with more than 34 significant digits:
   * callers that need rounding use decimal/exact.ts (fromRational).
   */
  static fromScaled(coefficient: bigint, exponent: number): Dec {
    if (!Number.isSafeInteger(exponent)) throw new DecError('DEC_EXPONENT_RANGE', 'exponent must be a safe integer');
    const d = new D(`${coefficient.toString()}e${exponent}`);
    if (d.sd() > DEC_SIGNIFICANT_DIGITS) {
      throw new DecError('DEC_TOO_PRECISE', `${coefficient.toString()}e${exponent} has more than ${DEC_SIGNIFICANT_DIGITS} significant digits`);
    }
    return new Dec(finite(d, 'value'));
  }

  static isDec(x: unknown): x is Dec {
    return x instanceof Dec;
  }

  static min(a: Dec, b: Dec): Dec {
    return a.lte(b) ? a : b;
  }

  static max(a: Dec, b: Dec): Dec {
    return a.gte(b) ? a : b;
  }

  plus(o: Dec): Dec {
    return new Dec(finite(this.d.plus(o.d), 'sum'));
  }

  minus(o: Dec): Dec {
    return new Dec(finite(this.d.minus(o.d), 'difference'));
  }

  times(o: Dec): Dec {
    const r = finite(this.d.times(o.d), 'product');
    if (r.isZero() && !this.d.isZero() && !o.d.isZero()) throw new DecError('DEC_UNDERFLOW', 'product underflows to zero');
    return new Dec(r);
  }

  /** Division; a zero divisor raises DEC_DIVISION_BY_ZERO (never Infinity, NaN or a silent zero). */
  div(o: Dec): Dec {
    if (o.d.isZero()) throw new DecError('DEC_DIVISION_BY_ZERO', 'division by zero');
    const r = finite(this.d.div(o.d), 'quotient');
    if (r.isZero() && !this.d.isZero()) throw new DecError('DEC_UNDERFLOW', 'quotient underflows to zero');
    return new Dec(r);
  }

  neg(): Dec {
    return this.d.isZero() ? this : new Dec(this.d.neg());
  }

  abs(): Dec {
    return new Dec(this.d.abs());
  }

  /** Correctly rounded square root; a negative operand raises DEC_DOMAIN. */
  sqrt(): Dec {
    if (this.d.isNegative()) throw new DecError('DEC_DOMAIN', 'square root of a negative value');
    return new Dec(finite(this.d.sqrt(), 'square root'));
  }

  cmp(o: Dec): -1 | 0 | 1 {
    const c = this.d.cmp(o.d);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }

  eq(o: Dec): boolean {
    return this.d.eq(o.d);
  }

  lt(o: Dec): boolean {
    return this.d.lt(o.d);
  }

  lte(o: Dec): boolean {
    return this.d.lte(o.d);
  }

  gt(o: Dec): boolean {
    return this.d.gt(o.d);
  }

  gte(o: Dec): boolean {
    return this.d.gte(o.d);
  }

  isZero(): boolean {
    return this.d.isZero();
  }

  isNegative(): boolean {
    return this.d.isNegative() && !this.d.isZero();
  }

  isPositive(): boolean {
    return this.d.isPositive() && !this.d.isZero();
  }

  isInteger(): boolean {
    return this.d.isInteger();
  }

  sign(): -1 | 0 | 1 {
    return this.d.isZero() ? 0 : this.d.isNegative() ? -1 : 1;
  }

  /** Number of significant digits of the value (trailing zeros of an integer not counted). */
  significantDigits(): number {
    return this.d.isZero() ? 1 : this.d.sd();
  }

  /** Number of digits after the decimal point in the canonical text. */
  decimalPlaces(): number {
    return this.d.decimalPlaces();
  }

  /** Base-10 exponent of the most significant digit (94.95 -> 1; 0.05 -> -2; 0 -> 0). */
  exponent(): number {
    return this.d.isZero() ? 0 : this.d.e;
  }

  /** Explicit rounding to a number of decimal places (only for comparison with a limit and display). */
  roundToDecimals(decimals: number, mode: RoundingMode): Dec {
    if (!Number.isSafeInteger(decimals) || decimals < 0) throw new DecError('DEC_DOMAIN', 'decimal places must be a non-negative integer');
    return new Dec(finite(this.d.toDecimalPlaces(decimals, MODE[mode]), 'rounded value'));
  }

  /** Explicit rounding to a number of significant figures (only for comparison with a limit and display). */
  roundToSignificant(figures: number, mode: RoundingMode): Dec {
    if (!Number.isSafeInteger(figures) || figures < 1) throw new DecError('DEC_DOMAIN', 'significant figures must be a positive integer');
    return new Dec(finite(this.d.toSignificantDigits(figures, MODE[mode]), 'rounded value'));
  }

  /** Largest integer not greater than the value (for counts of whole units). */
  floor(): Dec {
    return new Dec(finite(this.d.floor(), 'floor'));
  }

  /** Smallest integer not less than the value. */
  ceil(): Dec {
    return new Dec(finite(this.d.ceil(), 'ceiling'));
  }

  /** Exact integer representation: value = coefficient x 10^exponent, coefficient without trailing zeros. */
  toScaled(): { coefficient: bigint; exponent: number } {
    if (this.d.isZero()) return { coefficient: 0n, exponent: 0 };
    const text = this.toString();
    const negative = text.startsWith('-');
    const body = negative ? text.slice(1) : text;
    const point = body.indexOf('.');
    const whole = point < 0 ? body : body.slice(0, point);
    const fraction = point < 0 ? '' : body.slice(point + 1);
    let digits = (whole + fraction).replace(/^0+/, '');
    let exponent = -fraction.length;
    while (digits.length > 1 && digits.endsWith('0')) {
      digits = digits.slice(0, -1);
      exponent += 1;
    }
    const coefficient = BigInt(digits);
    return { coefficient: negative ? -coefficient : coefficient, exponent };
  }

  /** Canonical text: plain notation, no trailing fractional zeros, no "-0". */
  toString(): string {
    return this.d.isZero() ? '0' : this.d.toFixed();
  }

  /**
   * Text with exactly `decimals` decimal places after explicit rounding (display only; no locale,
   * no grouping separators). A rounded negative zero is shown without the sign.
   */
  toFixed(decimals: number, mode: RoundingMode): string {
    if (!Number.isSafeInteger(decimals) || decimals < 0) throw new DecError('DEC_DOMAIN', 'decimal places must be a non-negative integer');
    const text = this.d.toFixed(decimals, MODE[mode]);
    return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](hint: string): string {
    if (hint === 'string') return this.toString();
    throw new TypeError('A Dec never becomes a JavaScript number: use toString() or the Dec methods');
  }
}
