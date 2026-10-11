/**
 * The golden batches' clock (D-S6-6): the test PostgreSQL runs under libfaketime with an offset file
 * (FAKETIME_TIMESTAMP_FILE, FAKETIME_NO_CACHE=1), named to the tests by EBMR_FAKETIME_FILE. The driver "waits" only by
 * moving that offset forward, never back; nothing in the GMP code reads a test clock, and the simulators in the test read
 * time from the database. Without EBMR_FAKETIME_FILE the golden tests do not run (the `golden` CI job sets it).
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const FAKETIME_FILE = process.env['EBMR_FAKETIME_FILE'] ?? '';
export const goldenClockAvailable = FAKETIME_FILE !== '';

const OFFSET = /^\+(\d+)s\n?$/;

/** The offset the database clock runs ahead of the host clock, in whole seconds. */
export function offsetSeconds(): bigint {
  const text = readFileSync(FAKETIME_FILE, 'utf8');
  const m = OFFSET.exec(text);
  if (!m) throw new Error(`the faketime offset file holds ${JSON.stringify(text)}, not +<seconds>s`);
  return BigInt(m[1] ?? '0');
}

/** Moves the database clock forward by `minutes` (whole minutes, > 0). Moving it back is refused. */
export function advanceMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error(`the golden clock only moves forward, by whole minutes (asked ${String(minutes)})`);
  writeFileSync(FAKETIME_FILE, `+${String(offsetSeconds() + BigInt(minutes) * 60n)}s\n`);
}
