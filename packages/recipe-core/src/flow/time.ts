/**
 * Runtime evaluation of one time constraint (INV-20; outline 5.2.1 general rules, 5.2.3; ADR 0004
 * decision 3). Pure: instants and durations are bigint microseconds from the kernel's trusted clock,
 * passed in by the caller. The engine calls this at every command that touches the step and from a
 * sweeper, so a breach never depends on a timer job firing.
 *
 *   - Before the minimum has elapsed, the `to` event (e.g. completing the step) is not allowed.
 *   - Beyond the maximum, an exception is raised, whether or not the `to` event has happened.
 *   - Exactly at the maximum is still within the limit; exactly at the minimum is allowed.
 */
import { durationToMicros } from './decimal.ts';
import type { TimeConstraint } from './model.ts';

export type TimeConstraintStatus = 'NOT_STARTED' | 'MIN_NOT_REACHED' | 'WITHIN' | 'WARNING' | 'MAX_BREACHED';

export interface TimeObservation {
  /** Instant of the `from` event (undefined: not happened yet). */
  fromUs?: bigint;
  /** Instant of the `to` event (undefined: not happened yet). */
  toUs?: bigint;
  /** Current trusted time, used while the `to` event is still open. */
  nowUs: bigint;
  /** Paused time inside the interval, subtracted when the constraint excludes pauses. */
  pausedUs?: bigint;
}

export interface TimeConstraintEvaluation {
  status: TimeConstraintStatus;
  elapsedUs: bigint | undefined;
  /** May the `to` event happen now (minimum reached)? */
  toEventAllowed: boolean;
  /** An exception must exist for this constraint (maximum exceeded, or `to` recorded before the minimum). */
  exception: 'MAX_BREACH' | 'MIN_BREACH' | undefined;
  remainingUs: bigint | undefined;
}

export class TimeConstraintError extends Error {}

export function evaluateTimeConstraint(tc: TimeConstraint, obs: TimeObservation): TimeConstraintEvaluation {
  const min = tc.min ? durationToMicros(tc.min.value, tc.min.unit) : undefined;
  const max = tc.max ? durationToMicros(tc.max.value, tc.max.unit) : undefined;
  const warn = tc.warnBefore ? durationToMicros(tc.warnBefore.value, tc.warnBefore.unit) : undefined;
  if ((tc.min && min === undefined) || (tc.max && max === undefined) || (tc.warnBefore && warn === undefined)) {
    throw new TimeConstraintError(`time constraint ${tc.id} has a duration that is not a whole number of microseconds in a time unit`);
  }
  if (obs.fromUs === undefined) return { status: 'NOT_STARTED', elapsedUs: undefined, toEventAllowed: min === undefined, exception: undefined, remainingUs: max };
  const endUs = obs.toUs ?? obs.nowUs;
  let elapsed = endUs - obs.fromUs;
  if (tc.pauses === 'EXCLUDED' && obs.pausedUs !== undefined) elapsed -= obs.pausedUs;
  const minReached = min === undefined || elapsed >= min;
  const remaining = max === undefined ? undefined : max - elapsed;
  if (max !== undefined && elapsed > max) {
    return { status: 'MAX_BREACHED', elapsedUs: elapsed, toEventAllowed: minReached, exception: 'MAX_BREACH', remainingUs: remaining };
  }
  if (obs.toUs !== undefined && !minReached) {
    // The event was recorded before the minimum (e.g. entered late or forced): it is an exception, never silent.
    return { status: 'MIN_NOT_REACHED', elapsedUs: elapsed, toEventAllowed: false, exception: 'MIN_BREACH', remainingUs: remaining };
  }
  if (!minReached) return { status: 'MIN_NOT_REACHED', elapsedUs: elapsed, toEventAllowed: false, exception: undefined, remainingUs: remaining };
  if (obs.toUs === undefined && remaining !== undefined && warn !== undefined && remaining <= warn) {
    return { status: 'WARNING', elapsedUs: elapsed, toEventAllowed: true, exception: undefined, remainingUs: remaining };
  }
  return { status: 'WITHIN', elapsedUs: elapsed, toEventAllowed: true, exception: undefined, remainingUs: remaining };
}
