/**
 * Phase 7 slice 7i (G1, hosted demo of 20 October 2026): on a demo installation a presenter signs the floor people in on
 * any kiosk with the demo badge reader's Tap buttons (DEMO-ONLY). KIOSK-BLEND-1 is no person's home terminal, so before
 * this slice it offered no button at all, and a badge UID cannot be typed or pasted (BADGE-AUTOFILL). Now it lists every
 * badge holder of the installation under "Other people" (those whose home it is, under "Works here"). The Tap button
 * sends the badge UID as the reader would; the PIN and the server's checks follow as for any tap.
 */
import { expect, pin, signIn, test } from '../../fixtures/index.ts';
import { gmpKiosk } from '../../fixtures/slice6.ts';

test('G1 (slice 7i): on KIOSK-BLEND-1 a person whose home kiosk is another one signs in by pressing their Tap button of the demo badge reader @office', async ({ browser, e2e, persona }) => {
  test.setTimeout(180_000);
  const arjun = persona('GMP', 'operator2');
  const priya = persona('GMP', 'operator1');
  const page = await gmpKiosk(browser, e2e, 'KIOSK-BLEND-1');
  try {
    const reader = page.getByRole('region', { name: 'Demo badge reader' });
    await expect(reader).toBeVisible();
    const others = reader.getByRole('region', { name: 'Other people' });
    await expect(others.getByRole('button', { name: `Tap ${arjun.legalName}`, exact: true })).toBeVisible();
    await expect(others.getByRole('button', { name: `Tap ${priya.legalName}`, exact: true })).toBeVisible();
    // Pressed, not read: the button sends the badge UID; no reader burst (readerTap) is used here.
    await others.getByRole('button', { name: `Tap ${arjun.legalName}`, exact: true }).click();
    await pin.enter(page, arjun.pin ?? '');
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
    await expect(page.getByTestId('identity')).toContainText(`${arjun.legalName} (${arjun.loginName})`);
  } finally {
    await page.context().close();
  }
  // The shared sign-in helper's presenter path works the same way (gmp-kiosk-batch.spec.ts signs in with it).
  const again = await gmpKiosk(browser, e2e, 'KIOSK-BLEND-1');
  try {
    await signIn.kiosk(again, priya, undefined, 'demoButton');
    await expect(again.getByTestId('identity')).toContainText(`${priya.legalName} (${priya.loginName})`);
  } finally {
    await again.context().close();
  }
});
