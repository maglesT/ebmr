/**
 * The QMS simulator (Phase 6 slice 6a, builder B; @ebmr/integration-sdk/adapter QMS contract; D-P6a-3, D-P6a-6):
 * deviations naming lots, CAPAs and change controls, each change published on the feed with a new version token, and the
 * live answer the eBMR fetches inside the release signing transaction:
 *
 *   POST /qms/v1/deviations       {deviationRef, status, lotNumbers}      publishes qms.deviation_status (token v<n>)
 *   POST /qms/v1/capas            {capaRef, title, status, needsMasterChange, effectivenessDueDate}   qms.capa
 *   POST /qms/v1/change-controls  {changeRef, status}                     qms.change_control
 *   GET  /qms/v1/lots/:lot/deviations   200 {lotNumber, deviations: [{deviationRef, status, versionToken}]} (live;
 *                                       SLOW and LINK_CUT apply)
 * SIMULATOR, DEMO-ONLY.
 */
import { QMS } from '@ebmr/integration-sdk/adapter';
import { SystemFeed, type FeedClock } from '../system-feed/feed.ts';
import { contractPlugin } from '../system-feed/plugin.ts';
import type { FeedPlugin } from '../system-feed/server.ts';

interface Deviation {
  deviationRef: string;
  status: string;
  lotNumbers: string[];
  versionToken: string;
}

export function qmsSimulator(clock?: FeedClock): { feed: SystemFeed; plugin: FeedPlugin; deviations: Map<string, Deviation> } {
  let wrong = 0;
  const feed = new SystemFeed({
    system: 'QMS',
    ...(clock ? { clock } : {}),
    wrongIdentity: (type, p) => (type === 'qms.deviation_status' ? { ...p, lotNumbers: [`WRONG-LOT-${(++wrong).toString()}`] } : p),
  });
  const deviations = new Map<string, Deviation>();
  let token = 0;
  const next = (): string => `v${(++token).toString()}`;
  const plugin = contractPlugin(feed, QMS, {
    prefix: 'qms',
    title: 'QMS simulator',
    routes: [
      {
        path: '/qms/v1/deviations',
        messageType: 'qms.deviation_status',
        recordId: (p) => String(p['deviationRef']),
        complete: (b) => ({ ...b, versionToken: next() }),
        published: (p) => deviations.set(String(p['deviationRef']), p as unknown as Deviation),
      },
      { path: '/qms/v1/capas', messageType: 'qms.capa', recordId: (p) => String(p['capaRef']), complete: (b) => ({ ...b, versionToken: next() }) },
      { path: '/qms/v1/change-controls', messageType: 'qms.change_control', recordId: (p) => String(p['changeRef']), complete: (b) => ({ ...b, versionToken: next() }) },
    ],
    reads(method, path) {
      const m = /^\/qms\/v1\/lots\/([^/]+)\/deviations$/.exec(path);
      if (method !== 'GET' || !m) return undefined;
      const lotNumber = decodeURIComponent(m[1] ?? '');
      const list = [...deviations.values()]
        .filter((d) => d.lotNumbers.includes(lotNumber))
        .map((d) => ({ deviationRef: d.deviationRef, status: d.status, versionToken: d.versionToken }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.deviationRef), Buffer.from(b.deviationRef)));
      return { status: 200, read: true, body: { lotNumber, deviations: list } };
    },
    consoleRows: () => [...deviations.values()].map((d) => [d.deviationRef, `${d.status} ${d.versionToken} lots ${d.lotNumbers.join(', ')}`]),
    state: () => ({ deviations: [...deviations.values()] }),
  });
  return { feed, plugin, deviations };
}
