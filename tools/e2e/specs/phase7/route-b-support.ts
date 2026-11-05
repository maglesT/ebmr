/**
 * Phase 7 slice 7n (R7; review P7N-3): how the route B specs move between screens as a presenter does, by clicks only
 * (requirements R2 and R3): the banner's Home link, a home tile (with "Show all screens" when the role hides it), then
 * the screen's own lists and links. The shared kiosk helpers of the route specs (kiosk-batch-support.ts) still open
 * their screens by address, as route W's do.
 */
import type { Page } from '@playwright/test';
import { expect } from '../../fixtures/index.ts';

/** A home-screen tile from any screen: the banner's Home link, then the tile whose name starts with `title`. */
export async function tile(page: Page, title: string | RegExp): Promise<void> {
  await page.getByTestId('home-link').first().click();
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  await page.getByTestId('home-all-screens').click(); // declutter D3: the screens are listed under the home's "All screens"
  const name = typeof title === 'string' ? new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : title;
  const link = page.getByRole('main').getByRole('link', { name }).first();
  if ((await link.count()) === 0) {
    const all = page.getByTestId('home-show-all');
    if ((await all.count()) > 0) await all.click();
  }
  await link.click();
}

/** Planning (open production orders). */
export const planning = (page: Page): Promise<void> => tile(page, /^Planning Open production orders/);

/** The batch list of the site. */
export const batches = (page: Page): Promise<void> => tile(page, /^Batches GMP batches/);

/** The packaging order list. */
export const packagingOrders = (page: Page): Promise<void> => tile(page, /^Packaging orders/);

/** A material lot's page: Quality, Material lots, the lot. */
export async function lotPage(page: Page, lotCode: string): Promise<void> {
  await tile(page, /^Quality Deviations/);
  await page.getByRole('link', { name: 'Material lots', exact: true }).click();
  await page.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
}

/** A packaging order's page (bulk issue, finished lot): Packaging orders, the order. */
export async function packagingOrder(page: Page, orderNumber: string): Promise<void> {
  await packagingOrders(page);
  await page.getByTestId(`packaging-order-${orderNumber}`).getByRole('link', { name: orderNumber }).click();
}

/** A packaging order's line completion (coding, labels, post-use inspection), from the order's page. */
export async function lineCompletion(page: Page, orderNumber: string): Promise<void> {
  await packagingOrder(page, orderNumber);
  await page.getByTestId('packaging-completion-link').click();
}

/** A batch's run overview: Shop floor, the batch. */
export async function runOverview(page: Page, batchNumber: string): Promise<void> {
  await tile(page, /^Shop floor/);
  await page.getByRole('link', { name: `Open run ${batchNumber}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Run ');
}

/** A batch's record review: Batch record review, the batch. */
export async function reviewPage(page: Page, batchNumber: string): Promise<void> {
  await tile(page, /^Batch record review/);
  await page.getByTestId(`review-batch-${batchNumber}`).getByRole('link', { name: batchNumber, exact: true }).click();
}
