/**
 * The load driver's options (slice 7d; D-P7-4 reference site, D-P7-5 soak). The reference site: 100 batches a day and
 * 20,000 data points a batch, 50 shop-floor sessions, 50 OPC UA tags at 1 Hz, the EMS feed and every 6a adapter at its
 * simulator's default rate, a year of generated history. `rate` multiplies every rate (3 for the soak); `scale`
 * multiplies every count (sessions, history, the review batch) for a reduced run: the cloud smoke runs at a fraction of
 * both, the measured run and the soak on the pod at scale 1.
 */

export interface LoadOptions {
  /** Minutes of measured traffic after the set-up. */
  minutes: number;
  /** Multiplier of every rate (1 the reference site, 3 the soak). */
  rate: number;
  /** Multiplier of every count (1 the reference site). */
  scale: number;
  /** Shop-floor sessions (each on its own kiosk with its own address on the loopback network). */
  sessions: number;
  /** Office sessions (QA review, release, dashboards). */
  officeSessions: number;
  /** A shop-floor session's command interval and screen refresh (seconds, at rate 1). */
  commandEverySec: number;
  viewEverySec: number;
  /** History: days of generated batches and batches a day. */
  historyDays: number;
  batchesPerDay: number;
  /** Data points a batch: the EMS and OPC UA series, published while the batches run. */
  pointsPerBatch: number;
  /** OPC UA tags at 1 Hz (sent to the series store as the EMS feed's chunks; see the record). */
  opcuaTags: number;
  /** Entries of the review batch (the "50,000-entry batch review"). */
  reviewEntries: number;
  /** Signed acts measured under ingestion (the release SLO's 100 releases). */
  signedActs: number;
  /** Feed adapters and their publish interval (seconds, at rate 1). */
  feeds: readonly ('LMS' | 'QMS' | 'LIMS' | 'CMMS' | 'EMS')[];
  feedEverySec: number;
  /** Worker poll interval (seconds). */
  pollEverySec: number;
  /** Extra server processes on the same database while the history is made (a signature's password check is CPU work of the server). */
  historyServers: number;
  /** Run the analytics methods at the end (the nightly run) and time their flag views. */
  analytics: boolean;
  /** Seconds between resource samples (RSS, handles, connections, sizes). */
  sampleEverySec: number;
  /** Where the JSON record goes (.reports/load). */
  outDir: string;
  /** What this run is (smoke, measured, soak). */
  label: string;
}

/** The reference site at scale 1 and rate 1 (D-P7-4), for `minutes` of traffic. */
export const REFERENCE: LoadOptions = {
  minutes: 60,
  rate: 1,
  scale: 1,
  sessions: 50,
  officeSessions: 6,
  commandEverySec: 30,
  viewEverySec: 5,
  historyDays: 365,
  batchesPerDay: 100,
  pointsPerBatch: 20_000,
  opcuaTags: 50,
  reviewEntries: 50_000,
  signedActs: 100,
  feeds: ['LMS', 'QMS', 'LIMS', 'CMMS', 'EMS'],
  feedEverySec: 10,
  pollEverySec: 5,
  historyServers: 3,
  analytics: true,
  sampleEverySec: 30,
  outDir: '.reports/load',
  label: 'reference',
};

/** The cloud smoke (slice 7d): 10 minutes, 6 of the 50 floor sessions at half the rate, a fiftieth of the history. */
export const SMOKE: Partial<LoadOptions> = { minutes: 10, rate: 0.5, scale: 0.02, sessions: 6, officeSessions: 2, signedActs: 12, historyServers: 1, label: 'smoke' };

/** The soak on the pod (D-P7-5): 4 hours at three times the reference rate. */
export const SOAK: Partial<LoadOptions> = { minutes: 240, rate: 3, scale: 1, label: 'soak' };

/** The options with the scale applied to the counts that follow it; the sessions stay as given (at least 1). */
export function effective(o: LoadOptions): LoadOptions & { historyBatches: number } {
  const s = o.scale;
  return {
    ...o,
    sessions: Math.max(1, Math.round(o.sessions)),
    historyBatches: Math.max(1, Math.round(o.historyDays * o.batchesPerDay * s)),
    reviewEntries: Math.max(200, Math.round(o.reviewEntries * s)),
    pointsPerBatch: Math.max(100, Math.round(o.pointsPerBatch * s)),
    opcuaTags: Math.max(2, Math.round(o.opcuaTags * Math.max(s, 0.1))),
  };
}

export function parseOptions(json: string | undefined, base: LoadOptions = REFERENCE): LoadOptions {
  const given = json ? (JSON.parse(json) as Partial<LoadOptions>) : {};
  const o = { ...base, ...given };
  for (const k of ['minutes', 'rate', 'scale', 'sessions', 'historyServers', 'commandEverySec', 'viewEverySec', 'historyDays', 'batchesPerDay', 'pointsPerBatch', 'opcuaTags', 'reviewEntries', 'signedActs', 'feedEverySec', 'pollEverySec', 'sampleEverySec'] as const) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || o[k] < 0) throw new Error(`load option ${k} must be a number of at least 0`);
  }
  if (o.rate <= 0 || o.scale <= 0) throw new Error('rate and scale must be above 0');
  return o;
}
