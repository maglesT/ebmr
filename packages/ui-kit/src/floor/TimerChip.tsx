/**
 * TimerChip (module C4): a time constraint of the run as the server reports it (status RUNNING, WARNING,
 * BREACHED, MET, VOIDED) with a display countdown. The countdown seconds come from the caller, which derives
 * them from server instants and the monotonic clock (app/clock.ts); the status itself is the server's.
 */
import type { RunHeaderView } from '@ebmr/api-contract';
import { StatusChip } from '../primitives/StatusChip.tsx';
import type { StateTone } from '../tokens/tokens.ts';
import { fcls } from './classes.ts';
import { clockText, enumText } from './format.ts';
import { ft } from './messages.ts';

export type TimerData = RunHeaderView['timers'][number];

const TONES: Readonly<Record<TimerData['status'], StateTone>> = { RUNNING: 'info', WARNING: 'warning', BREACHED: 'error', MET: 'ok', VOIDED: 'neutral' };

export interface TimerChipProps {
  timer: TimerData;
  /** Seconds until the minimum instant (display only), or null. */
  secondsToMin: number | null;
  /** Seconds until the maximum instant (display only), or null. */
  secondsToMax: number | null;
}

export function TimerChip({ timer, secondsToMin, secondsToMax }: TimerChipProps) {
  let time: string | null = null;
  if (timer.status === 'RUNNING' || timer.status === 'WARNING') {
    if (secondsToMin !== null && secondsToMin > 0) time = ft('timer.waitRemaining', { time: clockText(secondsToMin) });
    else if (secondsToMax !== null) time = secondsToMax > 0 ? ft('timer.remaining', { time: clockText(secondsToMax) }) : ft('timer.overdue');
  }
  return (
    <span className={fcls('timer')} data-testid={`timer-${timer.constraint}`}>
      <StatusChip tone={TONES[timer.status]} label={`${timer.name}: ${enumText('timer.status', timer.status)}`} />
      {time ? (
        <span className={fcls('timerTime')} aria-live="off">
          {time}
        </span>
      ) : null}
      {timer.maxAt ? <span className={fcls('muted')}>{ft('timer.until', { at: timer.maxAt.text })}</span> : null}
    </span>
  );
}
