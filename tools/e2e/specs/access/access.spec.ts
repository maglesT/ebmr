/**
 * Kiosk access through the real screens (module C1; plan section 5; INV-40, DI-14, DI-38): an entry without a badge
 * tap is refused by the server even with the session's cookie and CSRF token; the terminal locks and only its own
 * person unlocks it with badge and PIN; the next person switches in with badge and PIN and gets their own session.
 */
import { randomUUID } from 'node:crypto';
import { axe, expect, signIn, test } from '../../fixtures/index.ts';
import { enterPinOn, tapInto } from '../esig/support.ts';

test.describe('kiosk access', () => {
  test('[INV-40][DI-14] an entry on a kiosk without a badge tap is refused by the server', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => {
    const operator = persona('SANDBOX', 'operator1');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    const base = e2e.url('SANDBOX');
    await evidence.step('Send a signing request from the signed-in kiosk session without a tap', 'The server answers 428 TAP_REQUIRED and records nothing', async () => {
      const s = await page.request.get(`${base}/api/session`);
      expect(s.status()).toBe(200);
      const { csrfToken } = (await s.json()) as { csrfToken: string };
      const stub = randomUUID();
      const r = await page.request.post(`${base}/api/esig/challenges`, {
        headers: { origin: base, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        data: { aggregateType: 'esig_stub', aggregateId: stub, contentVersion: '1', meaning: 'PERFORMED', clientContentHash: 'ab'.repeat(32), action: { kind: 'ESIG_STUB', stubId: stub } },
      });
      expect(r.status()).toBe(428);
      expect(((await r.json()) as { refusal: { code: string } }).refusal.code).toBe('TAP_REQUIRED');
    });
  });

  test('[DI-38][DI-14][INV-40] the kiosk locks; its own person unlocks with badge and PIN; the next person switches in with badge and PIN', { tag: '@kiosk' }, async ({ kioskPage, persona, evidence }) => {
    const operator = persona('SANDBOX', 'operator2');
    const verifier = persona('SANDBOX', 'verifier2');
    const page = await kioskPage('TEST-KIOSK-BLEND-1');
    await signIn.kiosk(page, operator);
    await expect(page.getByTestId('identity')).toContainText(`${operator.legalName} (${operator.loginName}), OPERATOR`);

    await evidence.step('Lock the kiosk', 'The lock screen covers the work and names the signed-in person', async () => {
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      await expect(page.getByRole('alertdialog', { name: 'This terminal is locked' })).toBeVisible();
      await expect(page.getByText(`Signed in: ${operator.legalName} (${operator.loginName}).`)).toBeVisible();
    }, page);
    await axe.check(page);

    await evidence.step('Unlock with badge and PIN', 'The session continues for the same person', async () => {
      await page.getByRole('button', { name: `Unlock (${operator.legalName})` }).click();
      await tapInto(page, operator.badgeUid ?? '');
      await enterPinOn(page, 'Enter your PIN', operator.pin ?? '');
      await expect(page.getByRole('alertdialog', { name: 'This terminal is locked' })).toHaveCount(0);
      await expect(page.getByTestId('identity')).toContainText(operator.legalName);
    }, page);

    await evidence.step('Switch user by badge and PIN', 'The verifier gets their own session on this kiosk; the banner names the verifier', async () => {
      await page.getByRole('button', { name: 'Switch user' }).click();
      await tapInto(page, verifier.badgeUid ?? '');
      await enterPinOn(page, 'Enter your PIN', verifier.pin ?? '');
      await expect(page.getByTestId('identity')).toContainText(`${verifier.legalName} (${verifier.loginName}), VERIFIER`);
      await expect(page.getByRole('alertdialog', { name: 'This terminal is locked' })).toHaveCount(0);
    }, page);
  });
});
