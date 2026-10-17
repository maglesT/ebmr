/**
 * Shared parts of the analytics screens (Phase 6A slice 6A-1; ADR 0020; draft control DI-51): the advisory band every
 * screen shows (advisory analytics, not for GMP decisions, with the method and version and the data age), the label of
 * every statistic, and the reads refreshed after an act.
 */
import type { ReactNode } from 'react';
import { routes } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';

export const ANALYTICS_READS: readonly string[] = [routes.analytics.catalog.id, routes.analytics.methods.id, routes.analytics.monitor.id, routes.analytics.flags.id, routes.analytics.flag.id];

export const VERDICTS = [
  { value: 'TRUE_SIGNAL', label: 'Real issue' },
  { value: 'FALSE_ALARM', label: 'False alarm' },
  { value: 'NOT_ASSESSABLE', label: 'Not assessable' },
] as const;
export type Verdict = (typeof VERDICTS)[number]['value'];
export const verdictLabel = (v: string): string => VERDICTS.find((x) => x.value === v)?.label ?? v;

/** The band at the top of every analytics screen. */
export function AdvisoryBand({ v, children }: { v: { method: { id: string; version: number } | null; dataAgeSeconds: number }; children?: ReactNode }) {
  return (
    <div data-testid="analytics-advisory">
      <Banner tone="info" title="Advisory analytics, not for GMP decisions">
        These results point QA at records to look at. They never change a batch record, a review or a release; decisions are taken on the records they link to.
        {v.method ? ` Method ${v.method.id} version ${v.method.version.toString()}.` : ' Each item names its own method and version.'} Data age{' '}
        {v.dataAgeSeconds.toString()} s.
        {children}
      </Banner>
    </div>
  );
}

/** A statistic, labelled as such (never a GMP value; ADR 0020 point 5). */
export function Stat({ value }: { value: number | null }) {
  return <span title="Advisory, not a GMP value">{value === null ? 'n/a' : `${value.toPrecision(4)} (advisory)`}</span>;
}
