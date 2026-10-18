/**
 * The analytics runner in its own worker thread (slice 7d; Phase 6A residual P6A7-4, measured by the load run's SLO-5:
 * the nightly run read, sorted and hashed whole inputs and ran the methods on the server's event loop, which then
 * answered nobody for up to 0.9 s at 2 % of the reference site's history, and would for far longer at its full year).
 * ThreadedAnalyticsRunner has the runner's operations (start, stop, tick, nightlyDue, pollCompleted, runAll,
 * runVersionAll, runVersion) and does them in worker-entry.ts, where the unchanged AnalyticsRunner works on its own
 * connection; only the requests and the run reports cross the threads. The timer stays here: when to look is the
 * server's; what is recorded and when is the database's, as before (runner.ts header).
 *
 * The worker loads its TypeScript entry through tsx's scoped import, as the designer's simulation worker does
 * (features/designer/simulation.ts; the server runs from source). A worker that stops or fails ends the runner: the
 * pending and later requests are refused with the reason, and the failure is logged (advisory analytics only; no GMP
 * data is affected). In-process runners (runner.ts) remain for tests with their own method implementations.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import { POLL_MS, type EffectiveVersion, type RunReport, type RunTrigger } from './runner.ts';
import type { AnalyticsMessage, AnalyticsRequest, AnalyticsWorkerData } from './worker-entry.ts';

/** The operations of the runner the server and its tests use, in process (AnalyticsRunner) or in a worker thread. */
export interface AnalyticsRunnerApi {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
  nightlyDue(): Promise<boolean>;
  pollCompleted(): Promise<string[]>;
  runAll(trigger: RunTrigger): Promise<RunReport[]>;
  runVersionAll(v: EffectiveVersion, trigger: RunTrigger): Promise<RunReport[]>;
  runVersion(v: EffectiveVersion, trigger: RunTrigger, referenceSet?: string | null): Promise<RunReport>;
}

export interface ThreadedRunnerOptions {
  url: string;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  siteZone: () => string;
  commit: string;
  pollMs?: number;
  nightlyHour?: number;
}

const BOOTSTRAP = `import { workerData } from 'node:worker_threads';
let api;
try {
  api = await import(workerData.loader);
} catch (error) {
  throw new Error('The analytics worker cannot start: the TypeScript loader tsx/esm/api could not be loaded (' + (error && error.message) + ').');
}
await api.tsImport(workerData.entry, workerData.base);`;

/** The file URL of tsx's ES-module API (as features/designer/simulation.ts resolves it; the runner imports no feature). */
function tsxLoaderUrl(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports?: Record<string, { import?: { default?: string } } | undefined> };
  const rel = pkg.exports?.['./esm/api']?.import?.default;
  if (!rel) throw new Error('The analytics worker cannot start: this tsx version has no ES-module API (tsx/esm/api).');
  return pathToFileURL(join(dirname(pkgPath), rel)).href;
}

/** A request without the fields `ask` fills in, for each kind of request. */
type Without<T> = T extends unknown ? Omit<T, 'id' | 'siteZone'> : never;
type RequestBody = Without<AnalyticsRequest>;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class ThreadedAnalyticsRunner implements AnalyticsRunnerApi {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ended: string | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly o: ThreadedRunnerOptions) {
    const data: AnalyticsWorkerData = { url: o.url, commit: o.commit, siteZone: o.siteZone(), ...(o.nightlyHour !== undefined ? { nightlyHour: o.nightlyHour } : {}) };
    this.worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(BOOTSTRAP)}`), {
      workerData: { ...data, loader: tsxLoaderUrl(), entry: new URL('./worker-entry.ts', import.meta.url).href, base: import.meta.url },
    });
    this.worker.unref();
    this.worker.on('message', (m: AnalyticsMessage) => {
      if (m.type === 'log') {
        this.o.log[m.level](m.obj, m.msg);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    });
    this.worker.on('error', (e) => this.end(`the analytics worker failed: ${e.message}`, true));
    this.worker.on('exit', (code) => this.end(`the analytics worker stopped (exit code ${String(code)})`, this.stopping === null));
  }

  private end(reason: string, unexpected: boolean): void {
    if (this.ended) return;
    this.ended = reason;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (unexpected) this.o.log.error({ reason }, 'analytics runner: its worker ended; no analytics run until the server restarts (advisory analytics only; no GMP data is affected)');
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  private ask<T>(r: RequestBody): Promise<T> {
    if (this.ended) return Promise.reject(new Error(this.ended));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...r, id, siteZone: this.o.siteZone() });
    });
  }

  /** Starts the timer; the first tick sets the poll's baseline and the nightly day (runner.ts). */
  start(): void {
    if (this.timer || this.ended || this.stopping) return;
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Stops the timer, lets the worker finish the work in progress and close its pool, then ends the thread. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.ask({ op: 'stop' }).catch(() => undefined);
      await this.worker.terminate().catch(() => undefined);
      this.end('the analytics worker stopped (the runner was stopped)', false);
    })();
    return this.stopping;
  }

  /** One look (never throws, as the runner's own tick). */
  tick(): Promise<void> {
    return this.ask<null>({ op: 'tick' }).then(
      () => undefined,
      (error: unknown) => {
        if (!this.ended) this.o.log.error({ err: error }, 'analytics runner: a scheduled look failed (advisory analytics only; no GMP data is affected)');
      },
    );
  }

  nightlyDue(): Promise<boolean> {
    return this.ask({ op: 'nightlyDue' });
  }

  pollCompleted(): Promise<string[]> {
    return this.ask({ op: 'pollCompleted' });
  }

  runAll(trigger: RunTrigger): Promise<RunReport[]> {
    return this.ask({ op: 'runAll', trigger });
  }

  runVersionAll(version: EffectiveVersion, trigger: RunTrigger): Promise<RunReport[]> {
    return this.ask({ op: 'runVersionAll', version, trigger });
  }

  runVersion(version: EffectiveVersion, trigger: RunTrigger, referenceSet: string | null = null): Promise<RunReport> {
    return this.ask({ op: 'runVersion', version, trigger, referenceSet });
  }
}
