/**
 * LimitDisplay (module C4): the limit tiers of a value as the server sent them (tier, bounds, source, rounding
 * rule), shown beside the input. It never compares a value with a limit: the verdict comes only from the
 * server's view after the value is committed (DI-28, PR-08).
 */
import type { FieldView } from '@ebmr/api-contract';
import { fcls } from './classes.ts';
import { enumText } from './format.ts';
import { ft } from './messages.ts';

export type LimitViewData = FieldView['limits'][number];

/** Plain words for the bounds of one tier, e.g. "10 to 20 min" or "at least 99.0 %". */
export function boundsText(limit: Pick<LimitViewData, 'low' | 'high'>, unit: string | null): string {
  const u = unit ?? '';
  const { low, high } = limit;
  if (low && high && low.inclusive && high.inclusive) return ft('limits.range', { low: low.value, high: high.value, unit: u }).trim();
  const parts: string[] = [];
  if (low) parts.push(ft(low.inclusive ? 'limits.atLeast' : 'limits.moreThan', { low: low.value, unit: u }).trim());
  if (high) parts.push(ft(high.inclusive ? 'limits.atMost' : 'limits.lessThan', { high: high.value, unit: u }).trim());
  return parts.join(' and ');
}

export interface LimitDisplayProps {
  limits: readonly LimitViewData[];
  unit: string | null;
  /** Heading level text; defaults to "Limits". */
  title?: string;
}

export function LimitDisplay({ limits, unit, title }: LimitDisplayProps) {
  return (
    <section aria-label={title ?? ft('limits.title')}>
      <p className={fcls('sectionTitle')}>{title ?? ft('limits.title')}</p>
      {limits.length === 0 ? (
        <p className={fcls('muted')}>{ft('limits.none')}</p>
      ) : (
        <ul className={fcls('limits')}>
          {limits.map((l) => (
            <li key={`${l.tier}-${l.source.ref}`} className={fcls('limitRow')} data-tier={l.tier}>
              <span className={fcls('limitTier')}>{enumText('limits.tier', l.tier)}</span>
              <span className={fcls('limitBounds')}>{boundsText(l, unit)}</span>
              <span className={fcls('limitSource')}>
                {l.source.ref} · {l.source.text} · {l.rounding}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
