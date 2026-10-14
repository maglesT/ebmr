/**
 * The LMS simulator (Phase 6 slice 6a, builder B; LMS contract): a person's qualification as the LMS holds it
 * (QUALIFIED, REVOKED, EXPIRED), published on the feed; the heartbeat drives the LMS_QUALIFICATION mirror's freshness.
 *
 *   POST /lms/v1/qualifications  {personNumber, qualificationCode, status, validFrom, validTo}
 * SIMULATOR, DEMO-ONLY.
 */
import { LMS } from '@ebmr/integration-sdk/adapter';
import { SystemFeed, type FeedClock } from '../system-feed/feed.ts';
import { contractPlugin } from '../system-feed/plugin.ts';
import type { FeedPlugin } from '../system-feed/server.ts';

export function lmsSimulator(clock?: FeedClock): { feed: SystemFeed; plugin: FeedPlugin } {
  let wrong = 0;
  const feed = new SystemFeed({ system: 'LMS', ...(clock ? { clock } : {}), wrongIdentity: (_t, p) => ({ ...p, personNumber: `NOBODY-${(++wrong).toString()}` }) });
  const plugin = contractPlugin(feed, LMS, {
    prefix: 'lms',
    title: 'LMS simulator',
    routes: [{ path: '/lms/v1/qualifications', messageType: 'lms.qualification', recordId: (p) => `${String(p['personNumber'])}/${String(p['qualificationCode'])}` }],
  });
  return { feed, plugin };
}
