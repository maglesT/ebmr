/**
 * The accessibility audit of the screens (slice 7d; outline 7.4: WCAG 2.2 AA; docs/validation/accessibility-audit.md):
 *  - axe (WCAG 2.0 to 2.2 A and AA rules) on every page of the SPA's route tree, signed in on GMP as a QA reviewer and on
 *    the sandbox as the batch issuer, and on the floor screens at a GMP kiosk: no serious or critical finding;
 *  - the office sign-in and a list-to-detail flow with the keyboard alone, the focus always visible;
 *  - every target on the floor screens at least 44 x 44 CSS px, measured;
 *  - every state chip shown by colour, icon and word.
 * The pages come from the web features' route files (read as text: the specs never import the app), with an example id
 * in each parameter; a page that names nothing shows its own "not found" or refusal state, which is audited as well.
 * The screens are main's at this commit (the sign-in page and the header change with slice 7e's branding).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { badge, expect, pickTerminal, pin, signIn, test, VIEWPORTS } from '../../fixtures/index.ts';

const FEATURES = fileURLToPath(new URL('../../../../apps/tablets-web/src/features/', import.meta.url));
const EXAMPLE_ID = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
/** Floor screens: the shop floor's own routes. */
const FLOOR = /^\/($|runs|status-board|alarms|line-station|rooms|work-queue|floor)/;

function pages(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(FEATURES);
  const out = new Set<string>(['/']);
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/createRoute\(\{[^}]*path: '(\/[^']*)'/g)) out.add((m[1] ?? '/').replace(/\$stepKey/g, 'p-disp-clear@').replace(/\$code/g, 'PL-1').replace(/\$[A-Za-z]+/g, EXAMPLE_ID));
  return [...out].sort();
}

interface Finding {
  page: string;
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

async function audit(page: Page, url: string): Promise<Finding[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ page: url, rule: v.id, impact: v.impact ?? '', help: v.help, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`.slice(0, 200)) }));
}

/** Opens a page of the SPA and waits for its screen (a heading, or the main region) before the audit. */
async function open(page: Page, base: string, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main, [role="main"], h1, h2').first()).toBeVisible();
}

/** Interactive targets smaller than 44 x 44 CSS px (WCAG 2.5.8 asks 24; outline 7.4 asks 44 on the shop floor). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="menuitem"]';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      // A field inside its label (React Aria's radios and checkboxes: the input is visually hidden, 13 x 13 px but
      // clipped to nothing) is pressed through the label: the label is the target that is measured.
      const r = (el.tagName === 'INPUT' ? (el.closest('label') ?? el) : el).getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      // A control inside a larger one (an icon in its button) is that control's target.
      if (el.closest('[aria-hidden="true"]')) continue;
      if (r.width < 44 || r.height < 44) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${String(Math.round(r.width))}x${String(Math.round(r.height))}`);
    }
    return out;
  });
}

/** State chips without their icon or word (outline 7.4: colour, icon and word). */
async function chipsWithoutWord(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-tone]'))
      .filter((el) => !el.querySelector('svg') || (el.textContent ?? '').trim() === '')
      .map((el) => el.outerHTML.slice(0, 120)),
  );
}

test.describe('accessibility audit (slice 7d)', () => {
  test('axe on every office page of the GMP installation: no serious or critical finding; every state chip has colour, icon and word', { tag: '@office' }, async ({ officePage, persona, e2e }) => {
    test.setTimeout(900_000);
    const page = await officePage('GMP', 'PC-QA-03');
    await signIn.office(page, persona('GMP', 'qaInvestigator'));
    const findings: Finding[] = [];
    const chips: string[] = [];
    const list = pages().filter((p) => !p.startsWith('/demo'));
    expect(list.length).toBeGreaterThan(60);
    for (const path of list) {
      await open(page, e2e.url('GMP'), path);
      findings.push(...(await audit(page, path)));
      chips.push(...(await chipsWithoutWord(page)).map((c) => `${path}: ${c}`));
    }
    test.info().annotations.push({ type: 'audited', description: `${String(list.length)} GMP pages` });
    expect(findings).toEqual([]);
    expect(chips).toEqual([]);
  });

  test('axe on the sandbox pages of the batch issuer, the TEST, NOT GMP watermark included: no serious or critical finding', { tag: '@office' }, async ({ officePage, persona, e2e }) => {
    test.setTimeout(600_000);
    const page = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(page, persona('SANDBOX', 'issuer'));
    const findings: Finding[] = [];
    for (const path of ['/', '/packages', '/test-packages', '/runs', '/cockpit', `/runs/${EXAMPLE_ID}`]) {
      await open(page, e2e.url('SANDBOX'), path);
      await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
      findings.push(...(await audit(page, path)));
    }
    expect(findings).toEqual([]);
  });

  test('the office sign-in and a list-to-detail flow with the keyboard alone; the focus is always visible', { tag: '@office' }, async ({ officePage, persona }) => {
    const page = await officePage('GMP', 'PC-QA-03');
    const qa = persona('GMP', 'qaInvestigator');
    const focusVisible = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return 'nothing focused';
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== 'none' && s.boxShadow !== '');
      return ring ? 'visible' : `no focus indicator on ${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}`;
    });
    // Sign in: Tab to the user ID, type, Tab to the password, type, Enter.
    await page.getByLabel('User ID').focus();
    expect(await focusVisible()).toBe('visible');
    await page.keyboard.type(qa.loginName);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    expect(await focusVisible()).toBe('visible');
    await page.keyboard.type(qa.password);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
    // From the home screen: Tab through the tiles (every focus visible), Enter opens one.
    const seen: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const v = await focusVisible();
      seen.push(v);
    }
    expect(seen.filter((v) => v !== 'visible' && v !== 'nothing focused')).toEqual([]);
    const tile = page.getByRole('link').filter({ hasText: /review|quality|records/i }).first();
    await tile.focus();
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/$/);
    // Back to where the flow began. Alt+Left is the browser's own keystroke, handled by its window, not by the page:
    // headless Chromium never receives it through Playwright's keyboard (the first run stayed on the list). The
    // history step it makes is taken here; what the app must do is show the home screen again on it.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  });

  test('the floor screens at a GMP kiosk: axe without serious or critical finding, every target at least 44 x 44 CSS px', { tag: '@kiosk' }, async ({ browser, e2e, persona }) => {
    test.setTimeout(600_000);
    const context = await browser.newContext({ viewport: VIEWPORTS.kiosk, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    try {
      const page = await context.newPage();
      await pickTerminal(page, e2e.url('GMP'), 'KIOSK-DISP-1');
      // The sign-in screen of the kiosk itself: badge prompt and keypad.
      const findings: Finding[] = [...(await audit(page, 'sign-in'))];
      const small: string[] = (await smallTargets(page)).map((t) => `sign-in: ${t}`);
      const operator = persona('GMP', 'operator1');
      await badge.tap(page, operator);
      findings.push(...(await audit(page, 'PIN keypad')));
      small.push(...(await smallTargets(page)).map((t) => `PIN keypad: ${t}`));
      await pin.enter(page, operator.pin ?? '');
      await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      const floor = pages().filter((p) => FLOOR.test(p));
      expect(floor.length).toBeGreaterThan(4);
      for (const path of floor) {
        await open(page, e2e.url('GMP'), path);
        findings.push(...(await audit(page, path)));
        small.push(...(await smallTargets(page)).map((t) => `${path}: ${t}`));
      }
      test.info().annotations.push({ type: 'audited', description: `${String(floor.length)} floor pages` });
      expect(findings).toEqual([]);
      expect(small).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
