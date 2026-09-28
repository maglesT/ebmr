/**
 * E2E global set-up (plan section 13): unique ebmr_tablets_e2e_<hex> and ebmr_sandbox_tablets_e2e_<hex>
 * databases seeded with workers + 1 persona sets, the SPA built once, the stack started on free ports
 * (health checked on 127.0.0.1). The returned teardown stops the processes and drops the databases.
 * State reaches the workers through EBMR_E2E_STATE (a JSON file).
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { buildWeb, REPO_ROOT, setupStack, startStack, WEB_DIST } from '@ebmr/demo';
import { dropDatabase } from '@ebmr/test-kit';
import type { E2eState } from './fixtures/state.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const hex = randomBytes(5).toString('hex');
  const databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
  const root = join(REPO_ROOT, 'var', 'e2e', hex);
  const keysDir = join(root, 'keys');
  const exchangeDir = join(root, 'exchange');
  mkdirSync(keysDir, { recursive: true });
  const workers = config.workers;
  const echo = process.env['EBMR_E2E_ECHO'] === '1';
  await setupStack({ databases, keysDir, exchangeDir, personaSets: workers + 1, echo });
  await buildWeb(echo);
  const ports = { gmp: await freePort(), sandbox: await freePort(), gatewayListener: await freePort(), gateway: await freePort(), simulatorTcp: await freePort(), simulatorHttp: await freePort() };
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
