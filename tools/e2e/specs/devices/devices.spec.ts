/**
 * Devices (module C5) through the real screens: the scale simulator behind the site gateway, ingested by the
 * sandbox server under the gateway's integration identity, shown on the kiosk of the scale's room.
 *
 *  - the live gauge is labelled "live, not recorded"; a captured weight shows the scale's device code and the raw
 *    MT-SICS line, which states exactly the value shown (DI-32);
 *  - a terminal in another room lists no scale of DISP-1, and the server refuses that terminal's own session a capture
 *    from, and the live view of, the DISP-1 scale (SCALE_NOT_IN_ROOM, 403), adding no reading (DI-20);
 *  - with the simulator OFFLINE the scale turns offline and the screen offers only the manual two-person path,
 *    with its explanation.
 * The claimed weight on a batch record (G-07 step) is covered by the journey spec (fcv.spec.ts), which runs the
 * execution (C3) and step screen (C4) end to end.
 *
 * The simulator is shared by the whole stack, so this file runs serially, takes the simulator lock of the stack
 * (withSimulator; the journey spec weighs on the same balance) and always clears the faults it injects.
 */
import { routes } from '@ebmr/api-contract';
import { openDatabase } from '@ebmr/test-kit';
import type { E2eState } from '../../fixtures/state.ts';
import { axe, expect, signIn, test, withSimulator } from '../../fixtures/index.ts';

test.describe.configure({ mode: 'serial' });

async function simulator(url: string, action: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${url}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

/** Readings stored for a scale, read by the superuser (evidence that a refused capture recorded nothing). */
async function readingsOf(state: E2eState, deviceCode: string): Promise<number> {
  const db = openDatabase(state.databases.SANDBOX, 'SANDBOX');
  try {
    const { rows } = await db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_reading where device_code = $1', [deviceCode]);
    return rows[0]?.n ?? -1;
  } finally {
    await db.close();
  }
}

test.describe('devices', () => {
  test('[DI-32][DI-20] the kiosk of the scale\'s room shows the live weight "live, not recorded"; a captured weight shows its device and raw line', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => withSimulator(e2e.state, async () => {
    const sim = e2e.state.urls.simulatorConsole;
    await simulator(sim, 'clear-faults');
    await simulator(sim, 'reset');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    const operator = persona('SANDBOX', 'operator1');
    await signIn.kiosk(page, operator);
    await page.getByRole('link', { name: /^Scales/ }).click();
    await expect(page.getByRole('heading', { name: 'Scales', level: 1 })).toBeVisible();
    const card = page.getByRole('region', { name: 'TEST-BAL-01', exact: true });
    await evidence.step('The DISP-1 kiosk shows the online scale TEST-BAL-01 with its live gauge', 'Online, labelled "live, not recorded"', async () => {
      await expect(card.getByText('Online', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(card.getByText('live, not recorded')).toBeVisible();
    }, page);
    await simulator(sim, 'place', { mass: '1.250' });
    await expect(card.getByTestId('live-value')).toHaveText('1.250 kg', { timeout: 15_000 });
    await expect(card.getByText('Stable', { exact: true })).toBeVisible();
    await simulator(sim, 'add', { mass: '0.005' });
    await evidence.step('Capture a check weight from the scale', 'The stored reading names TEST-BAL-01 and keeps the raw MT-SICS line, which states the value shown', async () => {
      await card.getByRole('button', { name: 'Capture check weight' }).click();
      const facts = card.getByTestId('reading-facts');
      await expect(facts).toBeVisible({ timeout: 20_000 });
      await expect(facts).toContainText('1.255 kg');
      await expect(facts).toContainText('TEST-BAL-01');
      await expect(facts).toContainText('TEST-GW-01');
      await expect(card.getByTestId('reading-raw')).toHaveText('S S      1.255 kg');
    }, page);
    await axe.check(page);
  }));

  test('[DI-20] a kiosk in another room lists no scale of DISP-1, and the server refuses it a capture from and the live view of TEST-BAL-01', { tag: '@kiosk' }, async ({ kioskPage, persona, api, e2e, evidence }) => withSimulator(e2e.state, async () => {
    const page = await kioskPage('TEST-KIOSK-BLEND-1');
    await signIn.kiosk(page, persona('SANDBOX', 'operator2'));
    await page.getByRole('link', { name: /^Scales/ }).click();
    await expect(page.getByText('No scale is registered to this room.')).toBeVisible();
    const base = e2e.url('SANDBOX');
    // The screen's list defaults to the session's room; the gate is the server's own (review F27): the BLEND-1
    // session itself asks for the DISP-1 scale, and the simulator lock keeps other specs from capturing meanwhile.
    await evidence.step('The BLEND-1 kiosk session asks the server for a capture from TEST-BAL-01 (DISP-1) and for its live view', 'Both are refused: SCALE_NOT_IN_ROOM (403) and 403; no reading of TEST-BAL-01 is added', async () => {
      const s = await page.request.get(`${base}/api/session`);
      expect(s.status()).toBe(200);
      const { csrfToken } = (await s.json()) as { csrfToken: string };
      const before = await readingsOf(e2e.state, 'TEST-BAL-01');
      const r = await page.request.post(`${base}/api/devices/scales/TEST-BAL-01/capture`, {
        headers: { origin: base, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
        data: { purpose: 'CHECK' },
      });
      expect(r.status()).toBe(403);
      const { code } = ((await r.json()) as { refusal: { code: string } }).refusal;
      expect(code).toBe('SCALE_NOT_IN_ROOM');
      // A stream that opened would never end: the timeout fails the step instead of waiting for the test's.
      const live = await page.request.get(`${base}/api/devices/scales/TEST-BAL-01/live`, { headers: { accept: 'text/event-stream' }, timeout: 15_000 });
      expect(live.status()).toBe(403);
      const after = await readingsOf(e2e.state, 'TEST-BAL-01');
      expect(after).toBe(before);
      return { captureStatus: r.status(), code, liveStatus: live.status(), readingsBefore: before, readingsAfter: after };
    }, page);
    // Without a session the device routes refuse outright (authentication, not the room gate).
    const anonymous = await api('SANDBOX').call(routes.devices.scales, { query: {} });
    expect(anonymous.ok).toBe(false);
  }));

  test('[DI-32] with the simulator OFFLINE the scale turns offline and only the manual two-person path is offered', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => withSimulator(e2e.state, async () => {
    const sim = e2e.state.urls.simulatorConsole;
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, persona('SANDBOX', 'operator1'));
    await page.getByRole('link', { name: /^Scales/ }).click();
    const card = page.getByRole('region', { name: 'TEST-BAL-01', exact: true });
    await expect(card.getByText('Online', { exact: true })).toBeVisible({ timeout: 30_000 });
    try {
      await simulator(sim, 'fault', { fault: 'OFFLINE', on: true });
      await evidence.step('The balance goes offline', 'The screen says "Scale offline: manual entry needs a second person" and offers no capture', async () => {
        await expect(card.getByText('Scale offline: manual entry needs a second person')).toBeVisible({ timeout: 30_000 });
        await expect(card.getByText(/a second person must then verify the step/)).toBeVisible();
        await expect(card.getByRole('button', { name: 'Capture check weight' })).toHaveCount(0);
      }, page);
    } finally {
      await simulator(sim, 'fault', { fault: 'OFFLINE', on: false });
    }
    await expect(card.getByText('Online', { exact: true })).toBeVisible({ timeout: 30_000 });
  }));
});
