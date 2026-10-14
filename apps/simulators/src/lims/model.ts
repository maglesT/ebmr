/**
 * The LIMS simulator (Phase 6 slice 6a, builder B; LIMS contract; D-P6a-4): sample results with the raw value and unit
 * as the LIMS records them, published on the feed.
 *
 *   POST /lims/v1/results  {sampleId, lotNumber, testCode, specificationRef, result, conformance, state, recordedAt}
 * SIMULATOR, DEMO-ONLY.
 */
import { LIMS } from '@ebmr/integration-sdk/adapter';
import { SystemFeed, type FeedClock } from '../system-feed/feed.ts';
import { contractPlugin } from '../system-feed/plugin.ts';
import type { FeedPlugin } from '../system-feed/server.ts';

export function limsSimulator(clock?: FeedClock): { feed: SystemFeed; plugin: FeedPlugin } {
  let wrong = 0;
  const feed = new SystemFeed({ system: 'LIMS', ...(clock ? { clock } : {}), wrongIdentity: (_t, p) => ({ ...p, lotNumber: `WRONG-LOT-${(++wrong).toString()}` }) });
  const plugin = contractPlugin(feed, LIMS, {
    prefix: 'lims',
    title: 'LIMS simulator',
    routes: [{ path: '/lims/v1/results', messageType: 'lims.sample_result', recordId: (p) => `${String(p['sampleId'])}/${String(p['testCode'])}` }],
  });
  return { feed, plugin };
}
