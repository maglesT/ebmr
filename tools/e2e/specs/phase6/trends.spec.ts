/**
 * Phase 6 exit (slice 6j-b), the trend viewer (DI-32; D-P6b-L-2): the EMS sends two chunks of room DISP-1's humidity
 * through its registered adapter (plant.receive_series_chunk), native samples with their source times, raw values and
 * status codes, one of them BAD; the series is the batch's because the batch occupied the room then (the DEMO-ONLY review
 * batch of the set-up). QA opens the trends of the batch: every sample as received, the BAD one without a value and
 * breaking the line; zoom and pan move over the samples.
 *
 * The restored archive: the GMP database is backed up and restored with the kernel's own backup path (continuity
 * dumpDatabase and restoreDatabase, as the restore drill uses them) into a new database, a second GMP server is started on
 * it, and the same trend re-renders there from the restored chunks, sample for sample, and still zooms. The restored
 * database and its server exist only for this test.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { continuity } from '@ebmr/kernel';
import { SERVER_MAIN, serverEnv, spawnNode, waitForHttp, WEB_DIST, type RunningProcess, type StartStackOptions } from '@ebmr/demo';
import pg from 'pg';
import { ADMIN_URL, dropDatabase, urlFor } from '@ebmr/test-kit';
import { axe, cspViolations, expect, pickTerminal, signIn, test, VIEWPORTS } from '../../fixtures/index.ts';
import { administration, endSessions, envelope, occupancyWindow, receive, registerAdapter, withDb } from './support.ts';

const TAG = 'room.rh_pct';

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

interface Sample {
  sourceTime: string;
  serverTime: string | null;
  raw: string;
  value: string | null;
  status: string;
}

/** A chunk of the EMS feed with the hash its source computes (integration-sdk seriesChunkText, recomputed by the database). */
function chunk(chunkNo: string, samples: Sample[]): Record<string, unknown> {
  const head = ['AREA', 'DISP-1', TAG, '%RH', chunkNo].join('|');
  const text = [head, ...samples.map((s) => [s.sourceTime, s.serverTime ?? '', s.raw, s.value ?? '', s.status].join('|'))].join('\n');
  const chunkHash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { subjectKind: 'AREA', subjectCode: 'DISP-1', tag: TAG, unit: '%RH', chunkNo, samples, chunkHash };
}

/** The trend of the batch's humidity: the chart, its window line, and the sample rows as text. */
async function openTrend(page: Page, origin: string, batchId: string): Promise<{ window: string; rows: string[] }> {
  await page.goto(`${origin}/trends?batchId=${batchId}&tag=${TAG}`);
  await expect(page.getByRole('heading', { name: 'Trends', level: 1 })).toBeVisible();
  const chart = page.getByTestId('trend-chart');
  await expect(chart).toBeVisible();
  await expect(page.getByRole('img', { name: `Trend of ${TAG}` })).toBeVisible();
  const rows = await page.getByTestId('trend-samples').locator('tbody tr').allInnerTexts();
  return { window: await page.getByTestId('trend-window').innerText(), rows: rows.map((r) => r.replace(/\s+/g, ' ').trim()) };
}

/** Zoom in, pan later and back, show all: the window narrows to fewer samples and comes back to every one. */
async function zoomAndPan(page: Page, total: number): Promise<number> {
  const window = page.getByTestId('trend-window');
  const zoom = page.getByRole('group', { name: 'Zoom' });
  await expect(window).toContainText(`${total} of ${total} samples`);
  await expect(window).toContainText('(all)');
  await zoom.getByRole('button', { name: 'Zoom in' }).click();
  await expect(window).toContainText('(zoomed)');
  const shown = await page.getByTestId('trend-samples').locator('tbody tr').count();
  expect(shown).toBeLessThan(total);
  const chart = page.getByTestId('trend-chart');
  const from = BigInt((await chart.getAttribute('data-from-us')) ?? '0');
  await zoom.getByRole('button', { name: 'Later' }).click();
  await expect.poll(async () => BigInt((await chart.getAttribute('data-from-us')) ?? '0') > from).toBe(true);
  await zoom.getByRole('button', { name: 'Earlier' }).click();
  await expect(chart).toHaveAttribute('data-from-us', from.toString());
  await zoom.getByRole('button', { name: 'Show all' }).click();
  await expect(window).toContainText(`${total} of ${total} samples`);
  await expect(window).toContainText('(all)');
  return shown;
}

test('[DI-32] the trend viewer draws a batch\'s room series from the native samples as received, zooms and pans; after a backup and restore of the database the same trend re-renders interactively from the restored chunks @office', async ({ browser, e2e, officePage, persona, evidence }) => {
  test.setTimeout(420_000);
  const { batchId } = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId: string };
  // Twelve samples inside the time the batch occupied DISP-1 (the set-up's occupancy; the series binds to the batch by
  // its source times); the ninth is BAD (no value).
  let samples: Sample[] = [];
  await withDb(e2e, 'GMP', async (db, seed) => {
    const w = await occupancyWindow(db, batchId, 'DISP-1');
    // After any chunk an earlier run of this spec put into the window (a chunk never overlaps another in source time).
    const before = await db.admin.query<{ n: string; to: string }>(
      `select coalesce(max(s.chunk_no), 0)::text as n, coalesce(max(s.to_us) filter (where s.to_us between $2::bigint and $3::bigint), 0)::text as to
         from plant.series s join plant.area a on a.id = s.area_id where a.code = 'DISP-1' and s.tag = $1`,
      [TAG, w.fromUs.toString(), w.toUs.toString()],
    );
    const last = BigInt(before.rows[0]?.n ?? '0');
    const lastTo = BigInt(before.rows[0]?.to ?? '0');
    const fromUs = lastTo >= w.fromUs ? lastTo + 1n : w.fromUs;
    // One sample every 10 ms (a short excerpt of the room's feed): many runs fit in the occupancy of a few seconds.
    const step = 10_000n;
    if (fromUs + step * 13n > w.toUs) throw new Error('the batch\'s occupancy of DISP-1 has no room left for another run of this spec (a fresh E2E database has)');
    samples = Array.from({ length: 12 }, (_, i) => {
      const at = fromUs + step * BigInt(i + 1);
      const v = `${45 + (i % 4)}.${(i * 7) % 10}`;
      return i === 8
        ? { sourceTime: at.toString(), serverTime: null, raw: 'NaN', value: null, status: '0x80000000' }
        : { sourceTime: at.toString(), serverTime: (at + 40n).toString(), raw: v, value: v, status: '0x00000000' };
    });
    const adm = await administration(db, seed);
    const ems = await registerAdapter(db, seed, adm, 'EMS');
    await endSessions(db, adm.admin, adm.owner);
    // The feed's next chunk numbers (a chunk number is recorded once per room and tag).
    for (const [no, part] of [[(last + 1n).toString(), samples.slice(0, 6)], [(last + 2n).toString(), samples.slice(6)]] as const) {
      const r = await receive(db, ems, 'plant.receive_series_chunk', envelope(ems, 'ems.series_chunk', chunk(no, part)));
      expect(r).toMatchObject({ outcome: 'ACCEPTED' });
    }
  });

  const qa = persona('GMP', 'qaInvestigator');
  const page = await officePage('GMP', 'PC-QA-01');
  await signIn.office(page, qa);
  let live: { window: string; rows: string[] } = { window: '', rows: [] };
  await evidence.step('QA opens the trends of the batch for the room humidity', 'Every sample as received with its source time, raw value, status and chunk; the BAD sample has no value and breaks the line', async () => {
    live = await openTrend(page, e2e.url('GMP'), batchId);
    // Every sample sent, as received (the series of the batch holds only this spec's chunks on a fresh database).
    for (const x of samples) {
      const cells = page.getByTestId(`trend-sample-${x.sourceTime}`).locator('td');
      await expect(cells.nth(1)).toHaveText(x.raw);
      await expect(cells.nth(2)).toHaveText(x.value ?? 'No value');
      await expect(cells.nth(3)).toHaveText(x.status);
    }
    const unvalued = live.rows.filter((r) => r.includes('No value')).length;
    expect(unvalued).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('trend-point')).toHaveCount(live.rows.length - unvalued);
    // The BAD sample breaks the line: at least one more run than BAD samples inside it.
    expect(await page.getByTestId('trend-run').count()).toBeGreaterThanOrEqual(2);
    await axe.check(page);
    return { samples: live.rows.length, runs: await page.getByTestId('trend-run').count() };
  }, page);

  await evidence.step('Zoom in, pan and show all', 'The window narrows to fewer samples, moves later and earlier, and comes back to all of them', async () => {
    const shown = await zoomAndPan(page, live.rows.length);
    return { zoomedSamples: shown };
  }, page);
  expect(await cspViolations(page)).toEqual([]);

  // The backup and restore (the kernel's backup path), and a GMP server on the restored database.
  // An E2E database name (the set-up marks only *_e2e_<hex> databases as demo installations, decision D6).
  const restored = `ebmr_tablets_e2e_${randomBytes(5).toString('hex')}`;
  const work = join(e2e.state.keysDir, '..', `restore-${randomBytes(3).toString('hex')}`);
  mkdirSync(work, { recursive: true });
  let server: RunningProcess | null = null;
  let origin = '';
  try {
    await evidence.step('Back up the GMP database and restore it into a new database; start a GMP server on the restored database', 'The backup passes its fixity check and the restored server answers', async () => {
      const artefact = await continuity.dumpDatabase({ sourceUrl: urlFor(e2e.state.databases.GMP), directory: work, backupId: `e2e-trend-${randomBytes(3).toString('hex')}`, snapshotTakenAt: new Date().toISOString() });
      expect(await continuity.verifyFixity(artefact)).toBe(true);
      await continuity.restoreDatabase({ adminUrl: ADMIN_URL, artefact, targetDatabase: restored, sourceDatabase: e2e.state.databases.GMP, isolate: false, workDir: work });
      // The restored copy carries the source's demo marker, which names the source database: a copy is not a demo installation
      // until the set-up marks it (decision D6). The E2E set-up marks it, so the browser can pick its demo terminal there.
      const copy = new pg.Client({ connectionString: urlFor(restored) });
      await copy.connect();
      try {
        await copy.query('delete from tab.demo_installation');
        await copy.query("select tab.mark_demo_installation('E2E: copy restored from the backup for the DI-32 trend re-render')");
      } finally {
        await copy.end();
      }
      const port = await freePort();
      const origins = { gmp: `http://localhost:${port}`, sandbox: e2e.url('SANDBOX') };
      origin = origins.gmp;
      const opts: StartStackOptions = {
        databases: { GMP: restored, SANDBOX: e2e.state.databases.SANDBOX }, keysDir: e2e.state.keysDir, exchangeDir: e2e.state.exchangeDir,
        ports: { sandbox: 0, gatewayListener: 0, gateway: 0, simulatorTcp: 0, simulatorHttp: 0, gmp: port }, webDist: WEB_DIST, host: 'localhost', echo: false, logLevel: 'warn',
      };
      server = spawnNode({ name: 'gmp-restored', entry: SERVER_MAIN, env: serverEnv('GMP', opts, origins), echo: false });
      await waitForHttp(`http://127.0.0.1:${port}/api/meta`, 90_000, server.child);
      return { backupSha256: artefact.artefactSha256.slice(0, 16), restoredDatabase: restored };
    });

    const context = await browser.newContext({ viewport: VIEWPORTS.office, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    const again = await context.newPage();
    try {
      await pickTerminal(again, origin, 'PC-QA-01');
      await signIn.office(again, qa);
      await evidence.step('QA opens the same trend on the restored database', 'The trend re-renders from the restored chunks, sample for sample, and zooms and pans as before', async () => {
        const back = await openTrend(again, origin, batchId);
        expect(back.rows).toEqual(live.rows);
        expect(back.window).toBe(live.window);
        await zoomAndPan(again, live.rows.length);
        return { samples: back.rows.length };
      }, again);
    } finally {
      await context.close();
    }
  } finally {
    const s = server as RunningProcess | null;
    if (s) await s.stop();
    await dropDatabase(restored);
    rmSync(work, { recursive: true, force: true });
  }
});
