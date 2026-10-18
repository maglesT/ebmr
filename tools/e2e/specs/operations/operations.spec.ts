/**
 * Phase 7 slice 7g-4 (decision 0025 point 2: nobody types a command to use the system), one browser flow per area on a
 * server of its own: a GMP demo installation created migrated but not set up, with the one-time set-up token an installer
 * prints (its SHA-256 stored through iam.issue_setup_token, kernel 1375), served by its own server process:
 *  1. the first-run set-up in the browser: the site, the first administrator and process owner, the seal key; the
 *     administrator signs in on this browser and changes the first password;
 *  2. the demo data loaded from the operations screen (the installation recreated with the personas, terminals and
 *     feature seeds), the browser starting again on the device picker;
 *  3. a backup taken from the screen and listed with its size, time and hash, and a copy offered to save;
 *  4. an adapter's worker started and stopped from the integration health page, at an LMS simulator started from the
 *     simulators' test console; a fault switched on there is seen on the health page;
 *  5. the installation reset to a clean state: the browser starting again on the first-run set-up.
 * The flows run one after the other on the same installation (serial); every name is unique per run, and the database
 * and the files are removed afterwards.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { REPO_ROOT, SERVER_MAIN, spawnNode, waitForHttp, WEB_DIST, type RunningProcess } from '@ebmr/demo';
import { asAdmin, createGmpDatabase, dropDatabase, editionMigrationSources, openDatabase, type SiteSeed } from '@ebmr/test-kit';
import { axe, cspViolations, expect, test, VIEWPORTS } from '../../fixtures/index.ts';
import { administration, endSessions, registerAdapter, setMirrorMode } from '../phase6/support.ts';

test.describe.configure({ mode: 'serial' });

const hex = randomBytes(5).toString('hex');
const database = `ebmr_ops_e2e_${hex}`;
const root = join(REPO_ROOT, 'var', 'e2e-ops', hex);
const keys = join(root, 'keys');
const ADMIN = { legalName: 'Kavya Iyer', loginName: `kavya.${hex}`, first: 'First-Admin-Password-1', next: 'Changed-Admin-Password-2026' };
const OWNER = { legalName: 'Rahul Menon', loginName: `rahul.${hex}` };
let server: RunningProcess | null = null;
let origin = '';
let setupToken = '';
let page: Page;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const CSP_LISTENER = `
  window.__ebmrCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__ebmrCsp.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
`;

async function officePage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORTS.office, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  await context.addInitScript(CSP_LISTENER);
  return context.newPage();
}

const seed = (): SiteSeed => JSON.parse(readFileSync(join(keys, 'gmp-seed.json'), 'utf8')) as SiteSeed;

async function signInOffice(p: Page, login: string, password: string): Promise<void> {
  await expect(p.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await p.getByLabel('User ID').fill(login);
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Sign in' }).click();
}

/** Waits for the demo job on the page to end (it recreates the database) and starts the application again. */
async function awaitJob(p: Page): Promise<void> {
  await expect(p.getByTestId('demo-job-state')).toHaveAttribute('data-state', 'DONE', { timeout: 540_000 });
  await p.getByRole('button', { name: 'Start the application again' }).click();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  for (const d of [keys, join(root, 'exchange', 'to-sandbox'), join(root, 'exchange', 'to-gmp'), join(root, 'backups')]) mkdirSync(d, { recursive: true });
  await createGmpDatabase(database, editionMigrationSources([{ namespace: 'tablets', directory: join(REPO_ROOT, 'apps/tablets-server/sql') }]));
  await asAdmin(database, (c) => c.query("select tab.mark_demo_installation('E2E operations flows')"));
  setupToken = randomBytes(32).toString('base64url');
  await asAdmin(database, (c) => c.query('select iam.issue_setup_token($1, 60)', [createHash('sha256').update(setupToken, 'utf8').digest('hex')]));
  const port = await freePort();
  origin = `http://localhost:${String(port)}`;
  const admin = new URL(process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres');
  server = spawnNode({
    name: 'ops',
    entry: SERVER_MAIN,
    echo: process.env['EBMR_E2E_ECHO'] === '1',
    env: {
      EBMR_INSTALLATION: 'GMP',
      EBMR_ENV: 'development',
      EBMR_DATABASE: database,
      EBMR_PG_HOST: admin.hostname,
      EBMR_PG_PORT: admin.port === '' ? '5432' : admin.port,
      EBMR_PUBLIC_ORIGIN: origin,
      EBMR_HOST: 'localhost',
      EBMR_PORT: String(port),
      EBMR_DEMO: '1',
      EBMR_WEB_DIST: WEB_DIST,
      EBMR_KEYS_DIR: keys,
      EBMR_DEMO_KEYS_FILE: join(keys, 'gmp-demo-devices.json'),
      EBMR_SEAL_KEY_FILE: join(keys, 'gmp-seal-key.json'),
      EBMR_SERVICE_KEYS_FILE: join(keys, 'gmp-service-keys.json'),
      EBMR_EXCHANGE_DIR: join(root, 'exchange'),
      EBMR_BACKUP_DIR: join(root, 'backups'),
      EBMR_BACKUP_KEY_FILE: join(keys, 'gmp-backup-key'),
      EBMR_PG_ADMIN_URL: admin.toString(),
      EBMR_ANALYTICS: 'off',
      EBMR_LOG_LEVEL: 'warn',
    },
  });
  await waitForHttp(`http://127.0.0.1:${String(port)}/api/meta`, 90_000, server.child);
  page = await officePage(browser);
});

test.afterAll(async () => {
  await page?.context().close();
  await server?.stop();
  await dropDatabase(database);
  if (process.env['EBMR_E2E_KEEP'] !== '1') rmSync(root, { recursive: true, force: true });
});

test('[DI-18][DI-20] the first-run set-up of a new installation in the browser: the token, the site, the administrator and the process owner, the seal key; the administrator signs in on this browser and changes the first password @office', async ({ evidence }) => {
  test.setTimeout(180_000);
  await evidence.step('Open the new installation', 'The set-up is shown instead of the sign-in; the installation is GMP and a demo installation, its kind not chosen here; the time zone in force is shown', async () => {
    await page.goto(`${origin}/`);
    await expect(page.getByRole('heading', { name: 'Set up this installation' })).toBeVisible();
    await expect(page.getByTestId('setup-zone')).toContainText('Asia/Kolkata');
    await expect(page.getByRole('textbox', { name: /time zone/i })).toHaveCount(0);
    await axe.check(page);
  }, page);
  await evidence.step('Fill in the set-up and send it', 'The installation is set up: site E2E-OPS, the two accounts, the seal key generated', async () => {
    await page.getByLabel('Set-up token (printed by the installer)').fill(setupToken);
    await page.getByRole('textbox', { name: 'Site code' }).fill('E2E-OPS');
    await page.getByRole('textbox', { name: 'Site name' }).fill('E2E operations site');
    await page.getByRole('textbox', { name: "Administrator's legal name" }).fill(ADMIN.legalName);
    await page.getByRole('textbox', { name: "Administrator's user ID" }).fill(ADMIN.loginName);
    await page.getByLabel("Administrator's first password", { exact: true }).fill(ADMIN.first);
    await page.getByLabel("Administrator's first password again").fill(ADMIN.first);
    await page.getByRole('textbox', { name: "Process owner's legal name" }).fill(OWNER.legalName);
    await page.getByRole('textbox', { name: "Process owner's user ID" }).fill(OWNER.loginName);
    await page.getByLabel("Process owner's first password", { exact: true }).fill('First-Owner-Password-1');
    await page.getByLabel("Process owner's first password again").fill('First-Owner-Password-1');
    await page.getByRole('button', { name: 'Set up the installation' }).click();
    await expect(page.getByTestId('setup-done')).toContainText(`The system administrator ${ADMIN.loginName}`);
    await expect(page.getByTestId('setup-done')).toContainText('was generated and registered');
  }, page);
  await evidence.step('Sign in as the administrator with the first password', 'The first password must be changed first; then the administrator is signed in on this browser, the console of the set-up', async () => {
    await page.getByRole('button', { name: 'Go to the sign-in' }).click();
    await signInOffice(page, ADMIN.loginName, ADMIN.first);
    await expect(page.getByLabel('New password')).toBeVisible();
    await page.getByLabel('New password').fill(ADMIN.next);
    await page.getByLabel('Repeat the new password').fill(ADMIN.next);
    await page.getByRole('button', { name: 'Continue' }).click();
    await signInOffice(page, ADMIN.loginName, ADMIN.next);
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
    await expect(page.getByTestId('identity')).toContainText(`${ADMIN.legalName} (${ADMIN.loginName}), SYSTEM_ADMINISTRATOR`);
    expect(await cspViolations(page)).toEqual([]);
  }, page);
});

test('[DI-05] the demo data is loaded from the operations screen after the database name is typed to confirm; the browser starts again on the demo terminals @office', async ({ evidence }) => {
  test.setTimeout(600_000);
  await evidence.step('Open Operations, then Demo and test data', 'The page says what is lost and offers the load and the reset', async () => {
    await page.getByRole('link', { name: /^Operations/ }).click();
    await page.getByRole('link', { name: 'Demo and test data' }).click();
    await expect(page.getByTestId('demo-contents')).toContainText('2 persons');
  }, page);
  await evidence.step('Load the demo data', 'The job recreates the installation with the demo data and ends', async () => {
    await page.getByRole('textbox', { name: 'Reason (recorded)' }).fill('demo data for the E2E flows');
    await page.getByRole('textbox', { name: /Type the database name/ }).fill(database);
    await page.getByRole('button', { name: 'Load the demo data' }).click();
    await expect(page.getByTestId('demo-job')).toBeVisible();
    await awaitJob(page);
  }, page);
  await evidence.step('The application starts again', 'This browser\'s terminal went with the old installation: the device picker lists the demo terminals; the demo administrator signs in on PC-QA-01', async () => {
    await page.goto(`${origin}/demo/devices`);
    await page.getByRole('button', { name: 'Use this terminal PC-QA-01' }).click();
    const s = seed();
    await signInOffice(page, s.bootstrap.admin.loginName, s.bootstrap.admin.password);
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
    return { personas: s.personas.length };
  }, page);
});

test('[DI-45] a backup is taken from the screen with a reason and listed with its size, time and hash; a copy is offered to save @office', async ({ evidence }) => {
  test.setTimeout(240_000);
  await evidence.step('Open Operations, then Backups, and take a backup', 'The backup is listed with its size, the time it was taken and its SHA-256', async () => {
    await page.goto(`${origin}/operations/backups`);
    await page.getByRole('textbox', { name: 'Reason (recorded with the request)' }).fill('before the E2E demo');
    await page.getByRole('button', { name: 'Take a backup now' }).click();
    await expect(page.getByText(/^Backup .* taken\.$/)).toBeVisible({ timeout: 120_000 });
    const row = page.getByTestId('backup-list').locator('tbody tr').first();
    await expect(row).toContainText('bytes');
    await expect(row.locator('code')).toHaveText(/^[0-9a-f]{64}$/);
    await axe.check(page);
  }, page);
  await evidence.step('Take a copy', 'The stored artefact is offered to save, as stored (encrypted)', async () => {
    await page.getByRole('button', { name: 'Take a copy' }).first().click();
    await expect(page.getByRole('link', { name: /^Save .*\.dump\.enc$/ })).toBeVisible();
  }, page);
});

test('[DI-31] an adapter\'s worker is started and stopped from the integration health page at a simulator started from the test console; a fault switched on there is seen on the health page @office', async ({ evidence }) => {
  test.setTimeout(300_000);
  let endpoint = '';
  await evidence.step('Start the LMS simulator from the test console', 'The simulator runs; its endpoint is shown', async () => {
    await page.goto(`${origin}/operations/simulators`);
    await page.getByRole('textbox', { name: /Reason/ }).fill('LMS feed for the E2E flow');
    await page.getByRole('button', { name: 'Start the LMS simulator' }).click();
    endpoint = (await page.getByTestId('simulator-endpoint-LMS').textContent({ timeout: 60_000 })) ?? '';
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/lms\/v1$/);
  }, page);
  // The LMS adapter's registration and the mirror mode are arranged in the database (the adapter registration screen is
  // slice 7g-1's); its service-keys entry names the simulator's endpoint.
  const db = openDatabase(database, 'GMP');
  let code = '';
  try {
    const s = seed();
    const adm = await administration(db, s);
    const adapter = await registerAdapter(db, s, adm, 'LMS');
    await setMirrorMode(db, adm, 'LMS_QUALIFICATION', 'MIRROR');
    await endSessions(db, adm.admin, adm.owner, adapter.actor);
    code = adapter.code;
    const file = join(keys, 'gmp-service-keys.json');
    const current = JSON.parse(readFileSync(file, 'utf8')) as { services: unknown[] };
    current.services.push({ terminal: 'SRV-LMS-ADAPTER-01', ...adapter.credentials, endpoint });
    writeFileSync(file, JSON.stringify(current, null, 2));
  } finally {
    await db.close();
  }
  await evidence.step('Start the adapter from the integration health page', 'The worker runs and is idle between its cycles', async () => {
    await page.goto(`${origin}/integrations`);
    const row = page.getByTestId(`worker-${code}`);
    await expect(row).toHaveAttribute('data-running', 'false');
    await page.getByRole('textbox', { name: /Reason \(recorded with the start/ }).fill('the LMS feed is ready');
    await row.getByRole('button', { name: `Start ${code}` }).click();
    await expect(row).toHaveAttribute('data-running', 'true');
    await expect(row).toContainText(/Idle|Running/);
  }, page);
  await evidence.step('Cut the simulator\'s link (a fault of the test console)', 'The health page shows the worker retrying with the transport error', async () => {
    await page.goto(`${origin}/operations/simulators`);
    await page.getByTestId('simulator-LMS').getByRole('button', { name: 'Switch on Link cut' }).click();
    await expect(page.getByTestId('fault-LMS-LINK_CUT')).toHaveAttribute('data-on', 'true');
    await page.goto(`${origin}/integrations`);
    await expect(page.getByTestId(`worker-${code}`)).toContainText('Retrying', { timeout: 60_000 });
  }, page);
  await evidence.step('Stop the adapter', 'The worker is stopped; the stop is listed with the reason', async () => {
    const row = page.getByTestId(`worker-${code}`);
    await page.getByRole('textbox', { name: /Reason \(recorded with the start/ }).fill('end of the E2E flow');
    await row.getByRole('button', { name: `Stop ${code}` }).click();
    await expect(row).toHaveAttribute('data-running', 'false');
    await expect(page.getByTestId('worker-acts')).toContainText(`Adapter stop ${code}`);
  }, page);
  await page.goto(`${origin}/operations/simulators`);
  await page.getByRole('button', { name: 'Stop the LMS simulator' }).click();
  await expect(page.getByTestId('simulator-LMS')).toHaveAttribute('data-running', 'false');
});

test('[DI-05] the installation is reset to a clean state from the operations screen; the set-up token is shown once and the browser starts again on the first-run set-up @office', async ({ evidence }) => {
  test.setTimeout(600_000);
  await evidence.step('Reset to a clean state', 'The set-up token of the clean installation is shown once; the job ends', async () => {
    await page.goto(`${origin}/operations/demo`);
    await page.getByRole('textbox', { name: 'Reason (recorded)' }).fill('clean installation after the E2E flows');
    await page.getByRole('textbox', { name: /Type the database name/ }).fill(database);
    await page.getByRole('button', { name: 'Reset to a clean state' }).click();
    await expect(page.getByTestId('setup-token')).toHaveText(/^[A-Za-z0-9_-]{43}$/);
    await awaitJob(page);
  }, page);
  await evidence.step('The application starts again', 'The installation awaits its first-run set-up', async () => {
    await expect(page.getByRole('heading', { name: 'Set up this installation' })).toBeVisible({ timeout: 30_000 });
  }, page);
});
