/**
 * Set-up CLI for demo and E2E databases (module C0; decision D6). Never for production: it seeds DEMO-ONLY
 * credentials and keys.
 *
 *   node --import tsx apps/tablets-server/src/cli/setup.ts --installation GMP --database ebmr_tablets_demo --keys-dir var/demo/keys
 *   node --import tsx apps/tablets-server/src/cli/setup.ts --installation SANDBOX --database ebmr_sandbox_tablets_demo --keys-dir var/demo/keys
 *
 * Phase 7 slice 7g-4 (decision 0025): what it does is in operations/installation.ts (setupInstallation), which the
 * operations screen's demo load runs too ("Load the demo data", features/operations); this file only reads the
 * arguments. The browser's first-run set-up replaces it for a new installation (iam.first_run_setup, kernel 1375).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setupInstallation } from './installation.ts';

export { DEMO_NAME, TABLETS_SQL, demoDevicesOf, demoSeedRefusal, setupInstallation, type SetupOptions } from './installation.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      installation: { type: 'string' },
      database: { type: 'string' },
      'keys-dir': { type: 'string', default: 'var/demo/keys' },
      'exchange-dir': { type: 'string', default: 'var/exchange' },
      'persona-sets': { type: 'string', default: '1' },
      recreate: { type: 'boolean', default: false },
      'gateway-spki': { type: 'string' },
      'gmp-review-batch': { type: 'boolean', default: false },
      'gmp-packaging': { type: 'boolean', default: false },
    },
  });
  if (values.installation !== 'GMP' && values.installation !== 'SANDBOX') throw new Error('--installation GMP|SANDBOX is required');
  if (!values.database) throw new Error('--database is required');
  if (process.env['EBMR_ENV'] === 'production') throw new Error('the set-up CLI seeds DEMO-ONLY credentials and refuses EBMR_ENV=production');
  await setupInstallation({
    installation: values.installation,
    database: values.database,
    keysDir: resolve(values['keys-dir']),
    exchangeDir: resolve(values['exchange-dir']),
    personaSets: Number(values['persona-sets']),
    recreate: values.recreate,
    reviewBatch: values['gmp-review-batch'],
    packaging: values['gmp-packaging'],
    backupIdentity: true,
    ...(values['gateway-spki'] ? { gatewaySpki: values['gateway-spki'] } : {}),
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`set-up failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
