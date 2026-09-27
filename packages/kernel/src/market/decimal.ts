/**
 * Exact comparison of canonical decimal strings as scaled bigints. GMP values never become a
 * JavaScript `number`. Canonical form: no exponent, no leading zeros, no trailing fractional zeros,
 * no "+" and no "-0" (e.g. "30", "7.5", "0.22"); equal numbers therefore have equal strings.
 */
import { MarketRuleError } from './errors.ts';

const CANONICAL = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

export function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL.test(value) && value !== '-0';
}

interface Scaled {
  digits: bigint;
  scale: number;
}

function scaled(value: string): Scaled {
  if (!isCanonicalDecimal(value)) throw new MarketRuleError('EBMR-MKT-020', `${JSON.stringify(value)} is not a canonical decimal string`);
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = body.split('.');
  const digits = BigInt(whole + fraction);
  return { digits: negative ? -digits : digits, scale: fraction.length };
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = scaled(a);
  const y = scaled(b);
  const scale = Math.max(x.scale, y.scale);
  const left = x.digits * 10n ** BigInt(scale - x.scale);
  const right = y.digits * 10n ** BigInt(scale - y.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}
