/**
 * The reads the release cockpit shows, read again after every act (route ids, so `useRefresh` invalidates each by its
 * prefix). Nothing is updated in the browser: the server's answer after the act is what the screen shows.
 */
import { routes, type GrelItemView, type ManufacturerReleaseState, type RouteResponse } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';

// The slice 4 views, named from their routes (the contract's index does not export them by name).
export type LotMarketsView = RouteResponse<typeof routes.release.markets>;
export type MarketDispositionView = LotMarketsView['dispositions'][number];
export type MarketDispositionState = MarketDispositionView['state'];
export type ExportMarket = MarketDispositionView['market'];
export type MarketAddEvaluationView = RouteResponse<typeof routes.release.marketAdd>;
export type MarketAddOutcome = MarketAddEvaluationView['outcome'];
export type MarketChangeView = MarketDispositionView['changes'][number];
export type QpCertificationView = MarketDispositionView['certifications'][number];

export const RELEASE_READS: readonly string[] = [
  routes.release.queue.id,
  routes.release.lot.id,
  routes.release.grel.id,
  routes.release.markets.id,
  routes.release.marketAdd.id,
  routes.release.batchMarketAdd.id,
  routes.review.batch.id,
  routes.notifications.list.id,
];

/** The chip tone of a market disposition state (display only). */
export function marketTone(s: MarketDispositionState): StateTone {
  switch (s) {
    case 'RELEASED':
    case 'CERTIFIED':
      return 'ok';
    case 'READY':
    case 'AWAITING_QP_CERTIFICATION':
      return 'info';
    case 'REJECTED':
    case 'REJECTED_BY_QP':
    case 'INELIGIBLE':
      return 'error';
    case 'RELEASE_SUSPENDED':
      return 'warning';
    case 'REMOVED':
      return 'neutral';
    default:
      return 'pending';
  }
}

/** The chip tone of a market-add outcome (display only). */
export function addTone(o: MarketAddOutcome): StateTone {
  return o === 'MET' ? 'ok' : o === 'UNMET_RECOVERABLE' ? 'warning' : 'error';
}

/** The chip tone of a manufacturer release state (display only). */
export function releaseTone(s: ManufacturerReleaseState): StateTone {
  switch (s) {
    case 'RELEASED':
      return 'ok';
    case 'READY':
      return 'info';
    case 'REJECTED':
      return 'error';
    default:
      return 'pending';
  }
}

/** The chip tone of a G-REL item status (display only). */
export function itemTone(s: 'GREEN' | 'RED' | 'NA'): StateTone {
  return s === 'GREEN' ? 'ok' : s === 'RED' ? 'error' : 'neutral';
}

export function itemWord(s: 'GREEN' | 'RED' | 'NA'): string {
  return s === 'GREEN' ? 'Green' : s === 'RED' ? 'Red' : 'Not applicable';
}

type Evidence = GrelItemView['evidence'][number];

/** Where a piece of evidence opens in this web app, or null when no screen shows it yet (the label is shown instead). */
export function evidenceLink(e: Evidence): { to: string; params: Record<string, string> } | null {
  switch (e.kind) {
    case 'BATCH':
      return { to: '/review/$batchId', params: { batchId: e.ref } };
    case 'LOT':
      return { to: '/quality/lots/$lotId', params: { lotId: e.ref } };
    case 'DEVIATION':
      return { to: '/quality/deviations/$deviationId', params: { deviationId: e.ref } };
    case 'CONTAINER':
    case 'EXCEPTION':
      return null;
    default:
      return null;
  }
}

/** "MANUFACTURER_RELEASED" -> "Manufacturer released". */
export function words(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase().replace(/\b(qa|qc|ppq|ap|lims)\b/g, (w) => w.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}
