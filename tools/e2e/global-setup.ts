/**
 * E2E global set-up (plan section 13): unique ebmr_tablets_e2e_<hex> and ebmr_sandbox_tablets_e2e_<hex>
 * databases seeded with workers + 1 persona sets, the SPA built once, the stack started on free ports
 * (health checked on 127.0.0.1). The returned teardown stops the processes and drops the databases.
 * State reaches the workers through EBMR_E2E_STATE (a JSON file).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { buildWeb, freeStackPorts, REPO_ROOT, setupStack, startStack, WEB_DIST } from '@ebmr/demo';
import { dropDatabase } from '@ebmr/test-kit';
import type { E2eState } from './fixtures/state.ts';
import { RECORDS_GROUPS } from './groups.ts';
import { readSeedMeta, restoreSeed } from './seed.ts';

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const workers = config.workers;
  const echo = process.env['EBMR_E2E_ECHO'] === '1';
  // The review specs (Phase 4 slice 1c) review the DEMO-ONLY batch record the set-up builds (gmp-review-batch.json); the
  // packaging-order spec (Phase 4 slice 2c) plans and fills the packaging order of its second batch. The packaging
  // option (which builds the review batch too) is on for every group: its release path (tablets-server
  // cli/release-path.ts) also builds the GMP demo plant's units and classes, which the library and route groups name.
  // Slice 7p (D-7p-8): the SR profile demo product only where sr-profile.spec.ts runs (no group, or 'records').
  // Slice 7s (D-7s-1): P3 rabeprazole ready for the presenter only where p3-demo.spec.ts runs (no group, or 'p3-demo').
  const group = process.env['EBMR_E2E_GROUP'];
  const records = group === undefined || RECORDS_GROUPS.includes(group);
  const p3Demo = group === undefined || group === 'p3-demo';
  // Session 19 (Stage C part 2): in CI one job builds the base set-up once (seed.ts); a group whose set-up is exactly
  // that one (not 'records', not 'p3-demo', the same persona sets) restores it instead of building it again, and the
  // restore is checked against the seed's fingerprint. Without EBMR_E2E_SEED_DIR (a development machine) it builds.
  const seedDir = process.env['EBMR_E2E_SEED_DIR'];
  const seeded = seedDir !== undefined && seedDir !== '' && existsSync(join(seedDir, 'meta.json')) && !records && !p3Demo && readSeedMeta(seedDir).personaSets === workers + 1;
  let databases: { GMP: string; SANDBOX: string };
  let keysDir: string;
  let exchangeDir: string;
  if (seeded) {
    ({ databases, keysDir, exchangeDir } = await restoreSeed(seedDir));
    console.log(`end-to-end set-up restored from the seed in ${seedDir}`);
  } else {
    const hex = randomBytes(5).toString('hex');
    databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
    const base = join(REPO_ROOT, 'var', 'e2e', hex);
    keysDir = join(base, 'keys');
    exchangeDir = join(base, 'exchange');
    mkdirSync(keysDir, { recursive: true });
    await setupStack({
      databases, keysDir, exchangeDir, personaSets: workers + 1, echo, gmpReviewBatch: true, gmpPackaging: true,
      gmpSrProfile: records, gmpP3Demo: p3Demo,
    });
  }
  const root = join(keysDir, '..');
  await buildWeb(echo);
  const ports = { ...(await freeStackPorts()) };
  // Declutter D1: the library-dc group runs the kept path, from the catalogue to the released lot, with the disconnected
  // routes refused (410 DISCONNECTED, as on the platform build); the servers inherit this variable.
  if (group === 'library-dc') process.env['EBMR_DISCONNECT'] = '1';
  const stack = await startStack({ databases, keysDir, exchangeDir, ports, webDist: WEB_DIST, host: 'localhost', echo, logLevel: 'warn' });
  const state: E2eState = { databases, keysDir, exchangeDir, urls: stack.urls, ports, workers };
  const stateFile = join(root, 'state.json');
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.env['EBMR_E2E_STATE'] = stateFile;
  return async () => {
    await stack.stop();
    await dropDatabase(databases.GMP);
    await dropDatabase(databases.SANDBOX);
    if (process.env['EBMR_E2E_KEEP'] !== '1') rmSync(root, { recursive: true, force: true });
  };
}
