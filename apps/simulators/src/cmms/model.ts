/**
 * The CMMS simulator (Phase 6 slice 6a, builder B; CMMS contract): calibrations with their due dates and maintenance
 * work orders, published on the feed; the heartbeat drives the CMMS_CALIBRATION and CMMS_MAINTENANCE mirrors' freshness.
 *
 *   POST /cmms/v1/calibrations  {equipmentCode, calibrationRef, performedAt, result, dueOn}
 *   POST /cmms/v1/work-orders   {equipmentCode, workOrder, kind, status, dueOn}
 * SIMULATOR, DEMO-ONLY.
 */
import { CMMS } from '@ebmr/integration-sdk/adapter';
import { SystemFeed, type FeedClock } from '../system-feed/feed.ts';
import { contractPlugin } from '../system-feed/plugin.ts';
import type { FeedPlugin } from '../system-feed/server.ts';

export function cmmsSimulator(clock?: FeedClock): { feed: SystemFeed; plugin: FeedPlugin } {
  let wrong = 0;
  const feed = new SystemFeed({ system: 'CMMS', ...(clock ? { clock } : {}), wrongIdentity: (_t, p) => ({ ...p, equipmentCode: `NO-SUCH-UNIT-${(++wrong).toString()}` }) });
  const plugin = contractPlugin(feed, CMMS, {
    prefix: 'cmms',
    title: 'CMMS simulator',
    routes: [
      { path: '/cmms/v1/calibrations', messageType: 'cmms.calibration', recordId: (p) => `${String(p['equipmentCode'])}/${String(p['calibrationRef'])}` },
      { path: '/cmms/v1/work-orders', messageType: 'cmms.maintenance', recordId: (p) => `${String(p['equipmentCode'])}/${String(p['workOrder'])}` },
    ],
  });
  return { feed, plugin };
}
