import { chromium } from '/home/user/ebmr/.claude/worktrees/p7-0/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright/index.mjs';
import fs from 'node:fs';
export const BASE = 'https://lms.taxizee.com';
export const DIR = '/tmp/claude-0/-home-user-ebmr/069a1e16-0f7a-5192-adea-7d43d4522c15/scratchpad/learnova-test';
export async function open(persona, opts = {}) {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY }, headless: true });
  const sp = `${DIR}/state/${persona}.json`;
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: (fs.existsSync(sp) && !opts.fresh) ? sp : undefined, timezoneId: 'Asia/Kolkata' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const log = [];
  page.on('console', m => { if (m.type() === 'error') log.push('console: ' + m.text().slice(0, 300)); });
  page.on('response', r => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`); });
  return { browser, ctx, page, log, save: async () => ctx.storageState({ path: sp }) };
}
export async function shot(page, name, full = true) {
  await page.screenshot({ path: `${DIR}/screenshots/${name}.jpg`, type: 'jpeg', quality: 60, fullPage: full });
}
export async function text(page, max = 3000) {
  return (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, max);
}
