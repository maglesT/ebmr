/**
 * The analytics runner's worker thread (slice 7d, finding P6A7-4 measured by the load run: SLO-5, no event-loop block
 * over 200 ms). The runner (runner.ts, unchanged) lives here with its own connection as ebmr_analytics: its reads, the
 * canonical sort and hash of whole inputs, the methods and the recording run on this thread's event loop, never on the
 * server's. The parent (threaded.ts) owns the timer and asks for each operation by message; the site zone comes with
 * every request (the server's site policy, DI-27); log lines go back to the server's logger.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { analyticsRoleProblem, createAnalyticsPool } from './pool.ts';
import { AnalyticsRunner, type EffectiveVersion, type RunTrigger } from './runner.ts';

export interface AnalyticsWorkerData {
  url: string;
  commit: string;
  nightlyHour?: number;
  /** The site zone when the worker starts. */
  siteZone: string;
}

export type AnalyticsRequest =
  | { id: number; siteZone: string; op: 'tick' | 'nightlyDue' | 'pollCompleted' | 'pause' | 'stop' | 'roleProblem' }
  | { id: number; siteZone: string; op: 'runAll'; trigger: RunTrigger }
  | { id: number; siteZone: string; op: 'runVersionAll'; version: EffectiveVersion; trigger: RunTrigger }
  | { id: number; siteZone: string; op: 'runVersion'; version: EffectiveVersion; trigger: RunTrigger; referenceSet: string | null };

export type AnalyticsMessage =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; obj: Record<string, unknown>; msg: string };

/** A log object as plain data (an Error does not cross the thread as itself). */
function plain(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, v instanceof Error ? { message: v.message, stack: v.stack } : v]));
}

if (parentPort) {
  const port = parentPort;
  const data = workerData as AnalyticsWorkerData;
  let zone = data.siteZone;
  const post = (m: AnalyticsMessage) => port.postMessage(m);
  const logAt = (level: 'info' | 'warn' | 'error' | 'debug') => (obj: unknown, msg?: string) => post({ type: 'log', level, obj: plain(obj), msg: msg ?? '' });
  const log = { info: logAt('info'), warn: logAt('warn'), error: logAt('error'), debug: logAt('debug') } as unknown as ConstructorParameters<typeof AnalyticsRunner>[0]['log'];
  const pool = createAnalyticsPool(data.url);
  // Phase 7 slice 7g-4: an idle connection that ends (a demo load or reset drops the database, a server restart) is
  // logged; unhandled, it would end the worker and with it every analytics run until the server restarts.
  pool.on('error', (e) => log.warn({ err: e.message }, 'analytics runner: an idle database connection ended'));
  // R3.12: so is one lost while handed out between queries (the runner reaches no platform code to share the helper).
  pool.on('connect', (client) => client.on('error', (e) => log.warn({ err: e.message }, 'analytics runner: a database connection ended')));
  const runner = new AnalyticsRunner({
    pool,
    log,
    siteZone: () => zone,
    commit: data.commit,
    ...(data.nightlyHour !== undefined ? { nightlyHour: data.nightlyHour } : {}),
  });
  const handle = (r: AnalyticsRequest): Promise<unknown> => {
    switch (r.op) {
      case 'roleProblem':
        // P6A7-8 (DI-51): the parent starts its timer only when this connection is the analytics role alone.
        return analyticsRoleProblem(pool);
      case 'tick':
        return runner.tick();
      case 'nightlyDue':
        return runner.nightlyDue();
      case 'pollCompleted':
        return runner.pollCompleted();
      case 'pause':
        // Phase 7 slice 7g-4: waits for the work in progress (the timer is the parent's); the pool stays open.
        return runner.pause();
      case 'stop':
        return runner.stop();
      case 'runAll':
        return runner.runAll(r.trigger);
      case 'runVersionAll':
        return runner.runVersionAll(r.version, r.trigger);
      case 'runVersion':
        return runner.runVersion(r.version, r.trigger, r.referenceSet);
    }
  };
  port.on('message', (r: AnalyticsRequest) => {
    zone = r.siteZone;
    handle(r).then(
      (value) => post({ type: 'reply', id: r.id, ok: true, value: value ?? null }),
      (error: unknown) => post({ type: 'reply', id: r.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}
