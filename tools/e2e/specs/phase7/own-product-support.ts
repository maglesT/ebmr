/**
 * Support of the R4 browser flow (Phase 7 slice 7j): the sandbox test run of a master taken from a formula with the
 * required skeleton (dispensing, then blending with TB-07), through the real screens, as `runTestBatch` runs dc-mini:
 * the steward registers the TEST- lots of the new materials on the sandbox's Test lots screen, the issuer imports the
 * package and issues a TEST- batch, the floor runs both stages on the sandbox's kiosks and plant (library/skeleton-floor.ts,
 * the same acts as a GMP batch: the plant cleaned, each room cleared and each unit booked, the hold points, the stage
 * sign-offs), and the issuer exports the test-run result for GMP. DEMO-ONLY data; every name is unique per run.
 */
import type { Browser, Page } from '@playwright/test';
import { expect, signIn, type E2eWorld } from '../../fixtures/index.ts';
import { choose } from '../journey/support.ts';
import { skeletonRun, type OwnMaterial, type StageCtx } from '../library/skeleton-floor.ts';

export type { OwnMaterial, StageCtx } from '../library/skeleton-floor.ts';
import { closeFloor, type Floor } from './own-product-floor.ts';
import type { SandboxPages } from './support.ts';


/** The steward registers one TEST- lot per material on the sandbox's Test lots screen (reached from the home tile). */
export async function registerTestLots(pages: SandboxPages, lots: readonly { lotCode: string; material: OwnMaterial }[]): Promise<void> {
  const steward = pages.persona('SANDBOX', 'steward');
  const page = await pages.officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(page, steward);
  await page.getByTestId('home-all-screens').click(); // declutter D3: the screens are listed under the home's "All screens"
  await page.getByRole('link', { name: /^Test lots/ }).click();
  await expect(page.getByRole('heading', { name: 'Test lots', level: 1 })).toBeVisible();
  const form = page.getByRole('form', { name: 'Register a test lot' });
  for (const l of lots) {
    await form.getByRole('textbox', { name: 'Lot code' }).fill(l.lotCode);
    await form.getByRole('textbox', { name: 'Material code' }).fill(l.material.code);
    await form.getByRole('textbox', { name: 'Material name' }).fill(l.material.name);
    await form.getByRole('textbox', { name: 'Expires in (days)' }).fill('365');
    await form.getByRole('button', { name: 'Register the test lot' }).click();
    await expect(page.getByTestId(`test-lot-${l.lotCode}`)).toContainText('RELEASED');
  }
  await page.context().close();
}

export interface SkeletonExtras {
  /** Which approved batch size to issue (0: the first listed, the reference size). */
  sizeIndex?: number;
  /** The batch size in tablets typed in the master's input when issuing (the chosen size's; default 100000). */
  sizeUnits?: string;
  /** Steps the master adds after the dispensing of the other components, on the dispensing kiosk. */
  afterDispensing?: (page: Page, ctx: StageCtx) => Promise<void>;
  /** Steps the master adds after the blend's discharge, on the blending kiosk. */
  afterDischarge?: (page: Page, ctx: StageCtx) => Promise<void>;
  /** The lubricant added in TB-07 (kg; default 0.600). */
  lubricantKg?: string;
  /** An injectables master: the dispensing stage with the product's steps, then H-PACK (library/skeleton-floor.ts). */
  dispensingOnly?: boolean;
  /** Stages the master adds between dispensing and blending, run on their own kiosks (library/skeleton-floor.ts). */
  between?: (f: Floor) => Promise<void>;
}

/**
 * The sandbox test run of the skeleton master in package `packageHash`, to Execution complete, and the export of its
 * result for GMP. `lots` maps each material to the TEST- lot registered for it.
 */
export async function runSkeletonTestBatch(
  e2e: E2eWorld,
  pages: SandboxPages & { browser: Browser },
  packageHash: string,
  lots: readonly { lotCode: string; material: OwnMaterial }[],
  discharge: { tare: string; gross: string },
  extra: SkeletonExtras = {},
): Promise<{ runId: string; batchNumber: string; resultFile: string }> {
  const issuer = pages.persona('SANDBOX', 'issuer');

  const office = await pages.officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(office, issuer);
  await office.getByTestId('home-all-screens').click(); // declutter D3: the screens are listed under the home's "All screens"
  await office.getByRole('link', { name: /^Test-run packages/ }).click();
  const item = office.getByTestId(`package-${packageHash}`);
  await expect(item).toContainText('Exported from GMP');
  await item.getByRole('button', { name: 'Import' }).click();
  await expect(item.getByText(/^Imported /)).toBeVisible();
  await item.getByRole('link', { name: 'Issue a test batch' }).click();
  await choose(office.getByRole('radiogroup', { name: 'Batch size (approved sizes only)' }).getByRole('radio').nth(extra.sizeIndex ?? 0));
  for (const input of await office.getByRole('main').getByRole('textbox').all()) {
    if ((await input.inputValue()) === '') await input.fill(extra.sizeUnits ?? '100000');
  }
  await office.getByRole('button', { name: 'Issue the test batch' }).click();
  await expect(office).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const runId = new URL(office.url()).pathname.split('/').pop() ?? '';
  await expect(office.getByTestId('batch-number')).toHaveText(/^TEST-B\d{2}-\d{4}$/);
  const batchNumber = (await office.getByTestId('batch-number').textContent()) ?? '';

  // The floor: the skeleton's two stages with the product's own steps, on the sandbox's kiosks and plant (S11b: the same
  // acts as the GMP batch's, library/skeleton-floor.ts).
  const floor: Floor = { e2e, browser: pages.browser, inst: 'SANDBOX', batchId: runId, batchNumber, persona: (k) => pages.persona('SANDBOX', k), containers: {}, save: () => undefined };
  try {
    await skeletonRun(floor, {
      lots, discharge, lubricantKg: extra.lubricantKg ?? '0.600',
      ...(extra.afterDispensing ? { afterDispensing: extra.afterDispensing } : {}),
      ...(extra.afterDischarge ? { afterDischarge: extra.afterDischarge } : {}),
      ...(extra.dispensingOnly ? { dispensingOnly: extra.dispensingOnly } : {}),
      ...(extra.between ? { between: extra.between } : {}),
    });
  } finally {
    await closeFloor();
  }

  await office.reload();
  await expect(office.getByText('Execution complete').first()).toBeVisible();
  await office.getByRole('button', { name: 'Export the test-run result for GMP' }).click();
  const exported = office.getByTestId('run-result-export');
  await expect(exported).toHaveAttribute('data-passed', 'yes');
  const resultFile = /([0-9a-f]{64}\.json)/.exec(await exported.innerText())?.[1] ?? '';
  expect(resultFile).not.toBe('');
  await office.context().close();
  return { runId, batchNumber, resultFile };
}
