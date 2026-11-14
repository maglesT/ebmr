/**
 * E2E global set-up (plan section 13): unique ebmr_tablets_e2e_<hex> and ebmr_sandbox_tablets_e2e_<hex>
 * databases seeded with workers + 1 persona sets, the SPA built once, the stack started on free ports
 * (health checked on 127.0.0.1). The returned teardown stops the processes and drops the databases.
 * State reaches the workers through EBMR_E2E_STATE (a JSON file).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { buildWeb, freeStackPorts, REPO_ROOT, setupStack, startStack, WEB_DIST } from '@ebmr/demo';
import { dropDatabase } from '@ebmr/test-kit';
import type { E2eState } from './fixtures/state.ts';
import { RECORDS_GROUPS } from './groups.ts';

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const hex = randomBytes(5).toString('hex');
  const databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
  const root = join(REPO_ROOT, 'var', 'e2e', hex);
  const keysDir = join(root, 'keys');
  const exchangeDir = join(root, 'exchange');
  mkdirSync(keysDir, { recursive: true });
  const workers = config.workers;
  const echo = process.env['EBMR_E2E_ECHO'] === '1';
  // The review specs (Phase 4 slice 1c) review the DEMO-ONLY batch record the set-up builds (gmp-review-batch.json); the
  // packaging-order spec (Phase 4 slice 2c) plans and fills the packaging order of its second batch.
  // Slice 7p (D-7p-8): the SR profile demo product only where sr-profile.spec.ts runs (no group, or now 'records').
  // Slice 7s (D-7s-1): P3 rabeprazole ready for the presenter only where p3-demo.spec.ts runs (no group, or 'p3-demo').
  // Session 19 (E2E speed): the review batch, the packaging order and the SR profile product only for the group whose
  // specs use them ('records', groups.ts) or a run of every spec; every other group skips about 10 minutes of set-up.
  const group = process.env['EBMR_E2E_GROUP'];
  const records = group === undefined || RECORDS_GROUPS.includes(group);
  await setupStack({
    databases, keysDir, exchangeDir, personaSets: workers + 1, echo, gmpReviewBatch: records, gmpPackaging: records,
    gmpSrProfile: records, gmpP3Demo: group === undefined || group === 'p3-demo',
  });
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
