/**
 * Slice 2 quick review (high): the DEMO-ONLY seeds of the set-up CLI (--gmp-review-batch, --gmp-packaging) write
 * superuser shortcuts, among them a placeholder hold-point signature; they never run on a database that is not a demo
 * or E2E one. The CLI refuses a non-demo name before it touches any database, and the seed itself refuses a database
 * without the tab.demo_installation mark.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseExists } from '@ebmr/test-kit';
import { assertDemoInstallation } from '../../src/cli/review-batch.ts';
import { demoSeedRefusal, setupInstallation } from '../../src/cli/setup.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const dir = mkdtempSync(join(tmpdir(), 'ebmr-demo-gate-'));
let servers: TestServer[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

describe('the DEMO-ONLY seeds of the set-up CLI are gated to demo databases', () => {
  it('[meta] --gmp-review-batch and --gmp-packaging on a non-demo database name are refused before any database is created or dropped', async () => {
    const database = `ebmr_prod_${randomBytes(4).toString('hex')}`;
    const common = { installation: 'GMP' as const, database, keysDir: join(dir, 'keys'), exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, log: () => undefined };
    await expect(setupInstallation({ ...common, packaging: true })).rejects.toThrow(/DEMO-ONLY: database ebmr_prod_[0-9a-f]+ is not a demo or E2E database/);
    await expect(setupInstallation({ ...common, reviewBatch: true })).rejects.toThrow(/DEMO-ONLY/);
    // Slice 7o: the sandbox's DEMO-ONLY plant likewise.
    await expect(setupInstallation({ ...common, installation: 'SANDBOX', sandboxPlant: true })).rejects.toThrow(/DEMO-ONLY/);
    expect(await databaseExists(database)).toBe(false);
    expect(demoSeedRefusal({ database: 'ebmr_tablets_demo', packaging: true })).toBeNull();
    expect(demoSeedRefusal({ database: 'ebmr_tablets_e2e_0a1b2c', reviewBatch: true })).toBeNull();
    expect(demoSeedRefusal({ database: 'ebmr_prod' })).toBeNull();
    expect(demoSeedRefusal({ database: 'ebmr_sandbox_tablets_e2e_0a1b2c', sandboxPlant: true })).toBeNull();
    expect(demoSeedRefusal({ database: 'ebmr_sandbox_prod', sandboxPlant: true })).toMatch(/DEMO-ONLY/);
    // Slices 7p and 7s (review P7S-2): the SR profile and the P3 demo options are refused by name on a non-demo database.
    expect(demoSeedRefusal({ database: 'ebmr_prod', srProfile: true })).toMatch(/DEMO-ONLY/);
    expect(demoSeedRefusal({ database: 'ebmr_prod', p3Demo: true })).toMatch(/DEMO-ONLY/);
    expect(demoSeedRefusal({ database: 'ebmr_tablets_demo', p3Demo: true })).toBeNull();
  });

  it('[meta] the seed refuses a database without the demo-installation mark, even under a demo name check, and accepts a marked demo one', async () => {
    const plain = await startServer('GMP');
    const marked = await startServer('GMP', { demoMarker: true });
    servers = [plain, marked];
    await expect(assertDemoInstallation(plain.db, plain.database)).rejects.toThrow(/not a marked demo installation/);
    await expect(assertDemoInstallation(plain.db, `${plain.database}_demo`)).rejects.toThrow(/not a marked demo installation/);
    await expect(assertDemoInstallation(marked.db, marked.database)).resolves.toBeUndefined();
  }, 120_000);
});
