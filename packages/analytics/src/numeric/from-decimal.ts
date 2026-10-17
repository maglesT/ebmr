/**
 * The one door from a GMP value to a JavaScript number (ADR 0020 point 5; CLAUDE.md: no `number` for GMP values in
 * domain code, analytics being the documented exception through this function only).
 *
 * GMP values (recorded values, limits, series samples) reach analytics as the exact decimal text of the input views.
 * `statOf` checks the decimal grammar first and only then converts, so a statistic is never computed from text that
 * is not a plain decimal (no exponent, no sign other than a leading minus, no white space, no thousands separator).
 * The number it returns is a statistic's input, never a GMP value: nothing in analytics writes it back.
 */
import { AnalyticsInputError } from '../errors.ts';

declare const decimalBrand: unique symbol;
/** Exact decimal text as an input view gives it (`-?digits(.digits)?`). */
export type DecimalText = string & { readonly [decimalBrand]: true };

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** True when `text` is decimal text in the grammar statOf accepts. */
export function isDecimalText(text: unknown): text is DecimalText {
  return typeof text === 'string' && DECIMAL.test(text);
}

/** `text` as DecimalText, or AnalyticsInputError. */
export function decimalText(text: string): DecimalText {
  if (!isDecimalText(text)) throw new AnalyticsInputError(`not decimal text: ${JSON.stringify(text)}`, text);
  return text;
}

/** The statistic input of a decimal value. Refuses anything but decimal text, and a value beyond the double range. */
export function statOf(text: DecimalText): number {
  if (!isDecimalText(text)) throw new AnalyticsInputError(`not decimal text: ${JSON.stringify(text)}`, text);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new AnalyticsInputError(`decimal text beyond the range of a statistic: ${text}`, text);
  return value === 0 ? 0 : value;
}
