/**
 * Deliberate waits of the end-to-end specs, measured (session 19, E2E speed): every wait a spec makes on purpose goes
 * through `waitFor`, which records it on the test as an annotation `wait:<kind>` with the total milliseconds, so the
 * merged report shows how much of a long test is waiting rather than working:
 *  - badge-pace: keeping a badge under the server's tap limit at one terminal (DI-19; the limit is not changed);
 *  - rate-limit: backing off after a "Too many attempts" answer;
 *  - process-timer: a step's minimum duration on the trusted clock (a blend time, a disintegration stage).
 */
import { test, type Page } from '@playwright/test';

export type WaitKind = 'badge-pace' | 'rate-limit' | 'process-timer';

export async function waitFor(page: Page, ms: number, kind: WaitKind): Promise<void> {
  record(kind, ms);
  await page.waitForTimeout(ms);
}

/** Adds `ms` to the current test's `wait:<kind>` annotation (no test running: nothing recorded). */
export function record(kind: WaitKind, ms: number): void {
  let info: ReturnType<typeof test.info>;
  try {
    info = test.info();
  } catch {
    return;
  }
  const type = `wait:${kind}`;
  const found = info.annotations.find((a) => a.type === type);
  const total = Math.round((found ? Number(found.description ?? '0') : 0) + ms);
  if (found) found.description = String(total);
  else info.annotations.push({ type, description: String(total) });
}
