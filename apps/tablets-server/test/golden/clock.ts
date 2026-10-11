/**
 * The golden batches' clock (D-S6-6): the test PostgreSQL runs under libfaketime with a timestamp file
 * (FAKETIME_TIMESTAMP_FILE, FAKETIME_NO_CACHE=1), named to the tests by EBMR_FAKETIME_FILE. The driver "waits" only by
 * moving that clock forward, never back; nothing in the GMP code reads a test clock, and the simulators in the test read
 * time from the database. Without EBMR_FAKETIME_FILE the golden tests do not run (the `golden` CI job sets it).
 *
 * Two forms of the file (libfaketime's own):
 *   +<seconds>s          an offset: the database's clock runs at real speed, that far ahead of the host's;
 *   YYYY-MM-DD HH:MM:SS  a frozen instant (UTC): the database's clock stands still until the driver moves it.
 * GB-T-01 freezes the clock (Phase 3 slice 6d): each act then happens at an instant fixed by the driver's own sequence
 * (it ticks a second before each act), so the times and the durations the server measures (blend, lubrication, massing,
 * inspection) are the same on every run and the normalised true copy has one hash (D-S6-7).
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const FAKETIME_FILE = process.env['EBMR_FAKETIME_FILE'] ?? '';
export const goldenClockAvailable = FAKETIME_FILE !== '';

const OFFSET = /^\+(\d+)s\n?$/;
const FROZEN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\n?$/;

/** The offset the database clock runs ahead of the host clock, in whole seconds (offset form only). */
export function offsetSeconds(): bigint {
  const text = readFileSync(FAKETIME_FILE, 'utf8');
  const m = OFFSET.exec(text);
  if (!m) throw new Error(`the faketime file holds ${JSON.stringify(text)}, not +<seconds>s`);
  return BigInt(m[1] ?? '0');
}

/** The frozen instant, in epoch seconds, or null when the file holds an offset. */
export function frozenSeconds(): bigint | null {
  const m = FROZEN.exec(readFileSync(FAKETIME_FILE, 'utf8'));
  return m ? BigInt(Date.parse(`${m[1] ?? ''}T${m[2] ?? ''}Z`)) / 1000n : null;
}

function writeFrozen(epochSeconds: bigint): void {
  const iso = new Date(Number(epochSeconds) * 1000).toISOString();
  writeFileSync(FAKETIME_FILE, `${iso.slice(0, 10)} ${iso.slice(11, 19)}\n`);
}

/**
 * Freezes the database's clock at `epochSeconds` (UTC), which must not be earlier than the clock now (the clock only moves
 * forward).
 */
export function freezeAt(epochSeconds: bigint): void {
  const frozen = frozenSeconds();
  const now = frozen ?? BigInt(Math.floor(Date.now() / 1000)) + offsetSeconds();
  if (epochSeconds < now) throw new Error(`the golden clock only moves forward (asked to freeze at ${String(epochSeconds)}, now ${String(now)})`);
  writeFrozen(epochSeconds);
}

/** Moves the database clock forward by `seconds` (whole seconds, > 0). Moving it back is refused. */
export function advanceSeconds(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`the golden clock only moves forward, by whole seconds (asked ${String(seconds)})`);
  const frozen = frozenSeconds();
  if (frozen !== null) writeFrozen(frozen + BigInt(seconds));
  else writeFileSync(FAKETIME_FILE, `+${String(offsetSeconds() + BigInt(seconds))}s\n`);
}

/** Moves the database clock forward by `minutes` (whole minutes, > 0). Moving it back is refused. */
export function advanceMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error(`the golden clock only moves forward, by whole minutes (asked ${String(minutes)})`);
  advanceSeconds(minutes * 60);
}
