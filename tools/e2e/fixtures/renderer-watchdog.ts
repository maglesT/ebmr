/**
 * A watchdog for a page whose renderer stops answering (review of the I-6 E2E stalls, November 2026).
 *
 * Seen twice on CI (library-inj-gmp, library-inj-aseptic): a page's renderer main thread stopped answering in the
 * middle of an action (a click at "performing click action", a fill at its actionability check). The action itself
 * timed out at the action timeout, but Playwright's trace recorder then captures the "after" DOM snapshot of the call
 * by evaluating script in that same page, with no timeout of its own (playwright-core 1.56.1,
 * server/trace/recorder/tracing.js onAfterCall -> _captureSnapshot). So the action's result never reached the test,
 * and the test waited for its whole test timeout (an hour) instead of failing after 30 s.
 *
 * The watchdog asks the page for a trivial evaluation over its own CDP session every PROBE_MS. When an answer is
 * STALL_MS late, the renderer is stuck: it records where (a JavaScript stack when the main thread is running script,
 * through a debugger pause; otherwise that it is not in script), attaches that to the test, and closes the page from
 * the browser side. Every pending call on the page (the action, the trace snapshot) then fails at once, so the test
 * fails about STALL_MS after the stall with the reason attached, rather than at the test timeout.
 *
 * STALL_MS is the configured action timeout (30 s, playwright.config.ts): a page whose main thread cannot answer a
 * one-line evaluation for that long cannot complete any action within the action timeout either, so the watchdog never
 * fails a page that an action could still have used.
 */
import { test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

export const PROBE_MS = 5_000;
export const STALL_MS = 30_000;
const PAUSE_WAIT_MS = 5_000;

/** The probe and the diagnosis, over a CDP session: an interface so the logic can be tested without a browser. */
export interface Probe {
  /** Resolves when the page answered a trivial evaluation (rejects or never settles otherwise). */
  ping(): Promise<unknown>;
  /** Where the main thread is: a JavaScript stack, or null when it does not pause (not running script). */
  where(): Promise<string[] | null>;
  /** Closes the page from the browser side. */
  close(): Promise<void>;
}

export interface Clock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

/**
 * Watches a page through `probe`; `report` receives the stall's description once. Returns the stop function.
 * A probe that rejects (the page navigating or closing) counts as an answer: only silence is a stall.
 */
export function watch(probe: Probe, clock: Clock, report: (text: string) => void, stallMs = STALL_MS): () => void {
  let since: number | null = null;
  let fired = false;
  const tick = () => {
    if (fired) return;
    if (since === null) {
      const started = clock.now();
      since = started;
      probe.ping().then(
        () => { if (since === started) since = null; },
        () => { if (since === started) since = null; },
      );
      return;
    }
    const silent = clock.now() - since;
    if (silent < stallMs) return;
    fired = true;
    stop();
    void (async () => {
      const stack = await probe.where().catch(() => null);
      report(
        `The page's renderer did not answer for ${Math.round(silent / 1000)} s (main thread stuck); ` +
          (stack && stack.length > 0 ? `it was running script at:\n  ${stack.join('\n  ')}` : 'it was not running script (no JavaScript stack: a native stall).') +
          '\nThe page is closed so that the pending action fails now instead of at the test timeout.',
      );
      await probe.close().catch(() => undefined);
    })();
  };
  const stop = clock.every(Math.min(PROBE_MS, stallMs / 4), tick);
  return stop;
}

function cdpProbe(page: Page, session: CDPSession): Probe {
  return {
    ping: () => session.send('Runtime.evaluate', { expression: '1', returnByValue: true }),
    where: async () => {
      const paused = new Promise<string[]>((resolve) => {
        session.once('Debugger.paused', (e) => {
          resolve(e.callFrames.slice(0, 15).map((f) => `${f.functionName || '(anonymous)'} ${f.url}:${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1}`));
        });
      });
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PAUSE_WAIT_MS).unref());
      // Debugger.pause interrupts running script (Chromium lets it through to a busy main thread); Debugger.enable does
      // not, so it is sent when the watch starts (watchRenderer).
      void session.send('Debugger.pause').catch(() => undefined);
      return Promise.race([paused, timeout]);
    },
    close: () => page.close({ runBeforeUnload: false }),
  };
}

const nodeClock: Clock = {
  now: () => performance.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    id.unref();
    return () => clearInterval(id);
  },
};

/** Starts the watchdog on a page of a test; it stops when the page closes. */
export async function watchRenderer(page: Page, stallMs = STALL_MS): Promise<void> {
  const session = await page.context().newCDPSession(page);
  // The debugger on this session only to read a stuck page's stack: breakpoints inactive, so a `debugger` statement
  // or a pause on an exception never stops the page.
  await session.send('Debugger.enable');
  await session.send('Debugger.setBreakpointsActive', { active: false });
  await session.send('Debugger.setPauseOnExceptions', { state: 'none' });
  const stop = watch(cdpProbe(page, session), nodeClock, (text) => {
    process.stderr.write(`[renderer-watchdog] ${page.url()}: ${text}\n`);
    try {
      const info = test.info();
      info.annotations.push({ type: 'renderer-stall', description: text });
      void info.attach('renderer stall', { body: `${page.url()}\n${text}`, contentType: 'text/plain' }).catch(() => undefined);
    } catch {
      // Outside a test (a worker fixture): stderr carries it.
    }
  }, stallMs);
  page.once('close', stop);
}

/** Watches every page the context opens from now on (call it before the context's first page). */
export function watchPages(context: BrowserContext): void {
  context.on('page', (page) => void watchRenderer(page).catch(() => undefined));
}
