/**
 * Devices (module C5) through the real screens: the scale simulator behind the site gateway, ingested by the
 * sandbox server under the gateway's integration identity, shown on the kiosk of the scale's room.
 *
 *  - the live gauge is labelled "live, not recorded"; a captured weight shows the scale's device code and the raw
 *    MT-SICS line, which states exactly the value shown (DI-32);
 *  - a terminal in another room has no scale to capture from (DI-20);
 *  - with the simulator OFFLINE the scale turns offline and the screen offers only the manual two-person path,
 *    with its explanation.
 * The claimed weight on a batch record (G-07 step) is covered by the journey spec (fcv.spec.ts), which runs the
 * execution (C3) and step screen (C4) end to end.
 *
 * The simulator is shared by the whole stack, so this file runs serially and always clears the faults it injects.
 */
import { routes } from '@ebmr/api-contract';
import { axe, expect, signIn, test } from '../../fixtures/index.ts';

test.describe.configure({ mode: 'serial' });

async function simulator(url: string, action: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${url}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

test.describe('devices', () => {
  test('[DI-32][DI-20] the kiosk of the scale\'s room shows the live weight "live, not recorded"; a captured weight shows its device and raw line', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => {
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
  });

  test('[DI-20] a kiosk in another room has no scale of DISP-1 to capture from', { tag: '@kiosk' }, async ({ kioskPage, persona, api }) => {
    const page = await kioskPage('TEST-KIOSK-BLEND-1');
    await signIn.kiosk(page, persona('SANDBOX', 'operator2'));
    await page.getByRole('link', { name: /^Scales/ }).click();
    await expect(page.getByText('No scale is registered to this room.')).toBeVisible();
    // Without a session the device routes refuse outright.
    const anonymous = await api('SANDBOX').call(routes.devices.scales, { query: {} });
    expect(anonymous.ok).toBe(false);
  });

  test('[DI-32] with the simulator OFFLINE the scale turns offline and only the manual two-person path is offered', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => {
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
  });
});
