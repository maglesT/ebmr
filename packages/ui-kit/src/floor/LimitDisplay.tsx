/**
 * LimitDisplay (module C4): the limit tiers of a value as the server sent them (tier, bounds, source, rounding
 * rule), shown beside the input. It never compares a value with a limit: the verdict comes only from the
 * server's view after the value is committed (DI-28, PR-08).
 */
import { Fragment } from 'react';
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

/** Short bounds for the one-line view: "10–20 min" for a closed range (the unit once, on the first tier), else the words. */
function shortBounds(limit: Pick<LimitViewData, 'low' | 'high'>, unit: string | null, withUnit: boolean): string {
  const { low, high } = limit;
  const u = withUnit ? (unit ?? '') : '';
  if (low && high && low.inclusive && high.inclusive) return ft('limits.compactRange', { low: low.value, high: high.value, unit: u }).trim();
  return boundsText(limit, unit);
}

/**
 * Declutter D3: one line, one entry per limit kind ("Registered 10–20 min · Action 12–18 · Alert 14–16"); the source
 * document and rounding rule of each tier stay one tap away under "Details".
 */
export function LimitDisplay({ limits, unit, title }: LimitDisplayProps) {
  const name = title ?? ft('limits.title');
  return (
    <section aria-label={name} className={fcls('limitBlock')}>
      {limits.length === 0 ? (
        <p className={fcls('muted')}>{ft('limits.none')}</p>
      ) : (
        <>
          <p className={fcls('limitLine')}>
            {limits.map((l, i) => (
              <Fragment key={`${l.tier}-${l.source.ref}`}>
                {i > 0 ? <span aria-hidden="true"> · </span> : null}
                <span className={fcls('limitItem')} data-tier={l.tier}>
                  <span className={fcls('limitTier')}>{enumText('limits.short', l.tier)}</span> <span className={fcls('limitBounds')}>{shortBounds(l, unit, i === 0)}</span>
                </span>
              </Fragment>
            ))}
          </p>
          <details className={fcls('limitDetails')}>
            <summary>{ft('limits.details')}</summary>
            <ul className={fcls('limits')}>
              {limits.map((l) => (
                <li key={`${l.tier}-${l.source.ref}`} className={fcls('limitSource')} data-tier={l.tier}>
                  {enumText('limits.tier', l.tier)} {boundsText(l, unit)}: {l.source.ref} · {l.source.text} · {l.rounding}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
