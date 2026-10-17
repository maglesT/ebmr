/**
 * Helpers of the Phase 3 slice 6 specs (floor-tablets, planning, master-data, plant, quality):
 *  - `gmpKiosk(browser, e2e, terminal)`: a kiosk-size page on a GMP shared terminal (the `kioskPage` fixture opens
 *    sandbox terminals only);
 *  - `officeSign(page, title, persona)`: the office ceremony (review, then user ID and password) for a request titled
 *    `title`, ending when the signed dialog is closed;
 *  - `signedInApi(page, e2e)`: the typed client over a signed-in GMP page (its session, CSRF token and origin);
 *  - `importErp(api, seed, tag)`: an ERP catalogue for this worker (one product, its materials and one order) through
 *    the ERP interface's own call, unique per tag, so specs do not depend on each other;
 *  - `confirmErp(page, e2e, approver, erp)`: the QA MBR approver confirms that catalogue's new codes (site-services 0802).
 */
import type { Browser, Page } from '@playwright/test';
import { routes, type ApiClient, type ErpCatalogue } from '@ebmr/api-contract';
import type { SeededPersona, SiteSeed } from '@ebmr/test-kit';
import { expect, pickTerminal, VIEWPORTS, type E2eWorld } from './index.ts';
import { pageApi, valueOf } from './test-package.ts';

export async function gmpKiosk(browser: Browser, e2e: E2eWorld, terminal: string): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORTS.kiosk, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  await pickTerminal(page, e2e.url('GMP'), terminal);
  return page;
}

/** The office ceremony: the request's dialog, "Sign", then the signer's user ID and password. */
export async function officeSign(page: Page, title: string | RegExp, who: SeededPersona): Promise<void> {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'Sign with your user ID and password' });
  await form.getByLabel('User ID').fill(who.loginName);
  await form.getByLabel('Password').fill(who.password);
  await form.getByRole('button', { name: 'Sign', exact: true }).click();
  // The dialog shows the manifestation it signed; closing it hands the outcome back to the screen.
  await expect(dialog.getByText('Signed.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
}

export async function signedInApi(page: Page, e2e: E2eWorld): Promise<ApiClient> {
  return pageApi(page, e2e.url('GMP'), 'GMP');
}

export interface ErpWorld {
  productCode: string;
  strength: string;
  materials: { api: string; excipient: string };
  orderNo: string;
}

/** Imports a small catalogue for `tag` through the ERP interface (POST /api/erp/import, its service identity). */
export async function importErp(api: ApiClient, seed: SiteSeed, tag: string): Promise<ErpWorld> {
  const erp = seed.services.find((s) => s.roleCode === 'ERP_INTERFACE');
  const terminal = seed.terminals.find((t) => t.code === erp?.terminal);
  if (!erp || !terminal) throw new Error('the GMP seed has no ERP interface');
  const t = tag.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const world: ErpWorld = { productCode: `E2E${t}`, strength: '500 mg', materials: { api: `API-E2E${t}`, excipient: `EXC-E2E${t}` }, orderNo: `PO-E2E-${t}` };
  const catalogue: ErpCatalogue = {
    products: [{ productCode: world.productCode, strength: world.strength, productName: `E2E product ${t}`, betaLactam: false, shelfLifeMonths: 24, erpReference: `ERP-P-${t}` }],
    materials: [
      { materialCode: world.materials.api, materialName: `E2E active ${t}`, materialKind: 'API', unit: 'kg', maxRetestMonths: 24, erpReference: `ERP-M-${t}-1` },
      { materialCode: world.materials.excipient, materialName: `E2E excipient ${t}`, materialKind: 'EXCIPIENT', unit: 'kg', erpReference: `ERP-M-${t}-2` },
    ],
    orders: [
      {
        orderNo: world.orderNo,
        siteCode: seed.siteCode,
        productCode: world.productCode,
        strength: world.strength,
        batchSize: '100000',
        batchSizeUnit: 'tablets',
        bom: [{ materialCode: world.materials.api, quantity: '50.000', unit: 'kg' }],
        erpReference: `ERP-O-${t}`,
      },
    ],
  };
  valueOf('ERP import', await api.call(routes.quality.erpImport, { body: { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminal.fingerprint, catalogue } }));
  return world;
}

/**
 * The QA MBR approver confirms the new product and materials of `erp` on the ERP status screen, each through the office
 * ceremony (site-services 0802: a new code is in effect only once QA confirms it). `page` is signed in as `approver`.
 */
export async function confirmErp(page: Page, e2e: E2eWorld, approver: SeededPersona, erp: ErpWorld): Promise<void> {
  await page.goto(`${e2e.url('GMP')}/quality/erp`);
  const box = page.getByTestId('erp-pending');
  for (const label of [`${erp.productCode} ${erp.strength}`, erp.materials.api, erp.materials.excipient]) {
    const button = box.getByRole('button', { name: `Confirm ${label}`, exact: true });
    await button.click();
    await officeSign(page, new RegExp(`^Confirm the ERP (product|material) master ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), approver);
    await expect(button).toHaveCount(0);
  }
}
