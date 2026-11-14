/**
 * The renderer watchdog against a real browser (fixtures/renderer-watchdog.ts; the I-6 E2E stalls): a click whose
 * handler never gives the main thread back. With tracing on, Playwright's action times out but the trace recorder's
 * "after" snapshot waits on the stuck page with no timeout, so without the watchdog the click returns only at the test
 * timeout. With it, the click fails a few seconds after the stall and the test is told where the page was stuck.
 * No stack needed: the page is set from a string.
 */
import { expect, test } from '../../fixtures/index.ts';
import { watchRenderer } from '../../fixtures/renderer-watchdog.ts';

const STUCK = `<!doctype html><html><body>
<button id="b">Spin</button>
<script>
function spinForever() { for (;;) { /* the main thread never returns */ } }
document.getElementById('b').addEventListener('click', () => { spinForever(); });
</script></body></html>`;

test('a page whose renderer is stuck fails the pending action at the stall limit, with its JavaScript stack, not at the test timeout @office', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(STUCK);
  await watchRenderer(page, 4_000);
  const started = Date.now();
  const error = await page.getByRole('button', { name: 'Spin' }).click({ timeout: 2_000 }).then(() => null, (e: unknown) => e);
  const took = Date.now() - started;
  expect(error).not.toBeNull();
  expect(took).toBeLessThan(20_000);
  const stall = testInfo.annotations.find((a) => a.type === 'renderer-stall');
  expect(stall?.description).toMatch(/did not answer for \d+ s/);
  expect(stall?.description).toContain('spinForever');
  await context.close().catch(() => undefined);
  // The annotation is the expected outcome here, not a defect of this test.
  testInfo.annotations.splice(testInfo.annotations.indexOf(stall!), 1);
});
