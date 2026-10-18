/**
 * The operators' command line for the full export and the periodic evaluation pack (records-cli.ts; Phase 7 slice
 * 7b-2): the export is written and registered, the pack generated through a login of the reporting role ebmr_report and
 * stored; a usage error and a refusal of the database give their exit codes.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/records/records-cli.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { ExportWorld } from './export-world.ts';
import { testActor } from './helpers.ts';

let db: TestDatabase;
let w: ExportWorld;
let dir: string;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ExportWorld.create(db);
  await w.closedIncident('CLI incident');
  dir = mkdtempSync(join(tmpdir(), 'ebmr-records-cli-'));
}, 300_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db?.drop();
});

describe('the records command line (Phase 7 slice 7b-2)', () => {
  it('[DI-08][DI-11] full-export writes and registers the export; evaluation-pack stores the pack read through the reporting role; usage and refusals give exit codes 2 and 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const url = urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' });
      const reportUrl = urlFor(db.name, { name: 'ebmr_report', password: 'ebmr_report' });
      const actor = JSON.stringify(w.lead);
      expect(await main(['full-export', '--url', url, '--actor-json', actor, '--out', join(dir, 'export')])).toBe(0);
      expect(readdirSync(join(dir, 'export'))).toContain('manifest.json');
      const sha = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('export SHA-256'))?.split(': ')[1];
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect((await db.app.query('select 1 from records.full_export where manifest_sha256 = $1', [sha])).rows).toHaveLength(1);

      const from = (await db.app.query<{ t: string }>("select (clock_timestamp() - interval '1 day')::text as t")).rows[0]!.t;
      const to = await w.now();
      const out = join(dir, 'pack.json');
      expect(await main(['evaluation-pack', '--url', url, '--report-url', reportUrl, '--actor-json', actor, '--from', from, '--to', to, '--seed', 'cli', '--sample', '3', '--out', out])).toBe(0);
      const packSha = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('pack SHA-256'))?.split(': ')[1];
      expect((await db.app.query<{ pack: string }>('select pack from records.evaluation_pack where pack_sha256 = $1', [packSha])).rows[0]?.pack).toBe(readFileSync(out, 'utf8'));

      expect(await main(['full-export', '--url', url])).toBe(2);
      expect(await main(['unknown', '--url', url, '--actor-json', actor])).toBe(2);
      const operator = await testActor(db, { roleCode: 'OPERATOR' });
      expect(await main(['full-export', '--url', url, '--actor-json', JSON.stringify(operator), '--out', join(dir, 'refused')])).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/EBMR-IAM-040/);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
