/**
 * Set-up CLI for demo and E2E databases (module C0; decision D6). Never for production: it seeds DEMO-ONLY
 * credentials and keys.
 *
 *   node --import tsx apps/tablets-server/src/cli/setup.ts --installation GMP --database ebmr_tablets_demo --keys-dir var/demo/keys
 *   node --import tsx apps/tablets-server/src/cli/setup.ts --installation SANDBOX --database ebmr_sandbox_tablets_demo --keys-dir var/demo/keys
 *
 * GMP: creates the database, migrates kernel, site services, recipe-core and tablets SQL, bootstraps and seeds.
 * SANDBOX: provisions the sandbox through the kernel (staged bootstrap, see test-kit sandbox.ts), then seeds.
 * Both: marks demo and E2E databases (names *_demo, *_e2e_*) with tab.demo_installation, registers the DEMO-ONLY
 * seal key, runs each feature's seed, and writes into the keys directory:
 *   <kind>-seed.json          personas, terminals, service identities with DEMO-ONLY credentials
 *   <kind>-demo-devices.json  the device picker's terminals and keys (EBMR_DEMO_KEYS_FILE)
 *   <kind>-seal-key.json      DEMO-ONLY HMAC seal key (EBMR_SEAL_KEY_FILE), kept when present
 *   <kind>-secrets.json       CSRF and nonce keys (EBMR_SECRETS_FILE), kept when present
 *   sandbox-service-keys.json the sweeper's, the gateway's and the gateway API monitor's service secrets (EBMR_SERVICE_KEYS_FILE)
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { esig, withCommand, type ActorContext } from '@ebmr/kernel';
import type { DemoDeviceView } from '@ebmr/api-contract';
import {
  asAdmin,
  bootstrapInstallation,
  createGmpDatabase,
  databaseExists,
  dropDatabase,
  editionMigrationSources,
  openDatabase,
  openPersonaSession,
  passwordActor,
  personaOf,
  provisionBootstrappedSandbox,
  seedDemoSite,
  type DeviceKey,
  type SiteSeed,
} from '@ebmr/test-kit';
import { FEATURES } from '../features/index.ts';
import { publishRuleTables } from '../platform/rule-tables.ts';
import type { FeatureSeedContext } from '../features/types.ts';

export const TABLETS_SQL = new URL('../../sql', import.meta.url).pathname;

export interface SetupOptions {
  installation: 'GMP' | 'SANDBOX';
  database: string;
  keysDir: string;
  exchangeDir: string;
  personaSets: number;
  /** Drop an existing database of that name first. */
  recreate: boolean;
  /** The gateway's Ed25519 public key (SPKI DER, base64). */
  gatewaySpki?: string;
  log?: (message: string) => void;
}

const DEMO_NAME = /(_demo$|_e2e_[a-z0-9]+$)/;

function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function demoDevicesOf(seed: SiteSeed): { installation: 'GMP' | 'SANDBOX'; devices: DemoDeviceView[] } {
  return {
    installation: seed.installation,
    devices: seed.terminals
      .filter((t) => t.key?.algorithm === 'ECDSA_P256' && (t.deviceClass === 'PERSONAL' || t.deviceClass === 'SHARED' || t.deviceClass === 'GRADE_A_B'))
      .map((t) => ({
        deviceCode: t.code,
        deviceClass: t.deviceClass,
        roomCode: t.room,
        description: t.description,
        privateKeyPkcs8: t.key?.privateKeyPkcs8 ?? '',
        publicKeySpki: t.key?.publicKeySpki ?? '',
        personas: seed.personas.filter((p) => p.homeTerminal === t.code && p.set === 0).map((p) => ({ legalName: p.legalName, loginName: p.loginName, role: p.roleCode, badgeUid: p.badgeUid })),
      })),
  };
}

export async function setupInstallation(opts: SetupOptions): Promise<SiteSeed> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const kind = opts.installation;
  const prefix = kind === 'GMP' ? 'gmp' : 'sandbox';
  mkdirSync(opts.keysDir, { recursive: true, mode: 0o700 });
  for (const d of ['to-sandbox', 'to-gmp']) mkdirSync(join(opts.exchangeDir, d), { recursive: true });

  if (await databaseExists(opts.database)) {
    if (!opts.recreate) throw new Error(`database ${opts.database} exists; pass --recreate to drop it first`);
    log(`dropping ${opts.database}`);
    await dropDatabase(opts.database);
  }
  const sources = editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
  let bootstrap;
  if (kind === 'GMP') {
    log(`creating GMP database ${opts.database}`);
    await createGmpDatabase(opts.database, sources);
    bootstrap = await bootstrapInstallation(opts.database, 'GMP');
  } else {
    log(`provisioning sandbox ${opts.database}`);
    bootstrap = (await provisionBootstrappedSandbox(opts.database, sources)).bootstrap;
  }
  if (DEMO_NAME.test(opts.database)) {
    await asAdmin(opts.database, (c) => c.query('select tab.mark_demo_installation($1)', ['DEMO-ONLY installation created by the set-up CLI']));
    log('marked as a demo installation (device picker available with EBMR_DEMO=1)');
  }

  const previous = readJson<SiteSeed>(join(opts.keysDir, `${prefix}-seed.json`));
  const terminalKeys: Record<string, DeviceKey> = {};
  for (const t of previous?.terminals ?? []) if (t.key && t.code !== 'TEST-GW-01') terminalKeys[t.code] = t.key;

  const db = openDatabase(opts.database, kind);
  try {
    log('seeding terminals, personas and service identities');
    const seed = await seedDemoSite(db, kind, bootstrap, {
      personaSets: opts.personaSets,
      terminalKeys,
      ...(opts.gatewaySpki ? { gatewayPublicKeySpki: opts.gatewaySpki } : {}),
    });

    // DEMO-ONLY keys and secrets (kept across set-ups so browsers keep their imported terminal keys).
    const sealFile = join(opts.keysDir, `${prefix}-seal-key.json`);
    let seal = readJson<{ keyId: string; algorithm: 'HMAC-SHA256'; secret: string; label: string }>(sealFile);
    if (!seal) {
      seal = { keyId: `demo-${prefix}-hmac-1`, algorithm: 'HMAC-SHA256', secret: randomBytes(32).toString('base64'), label: 'DEMO-ONLY seal key' };
      writeJson(sealFile, seal);
    }
    const secretsFile = join(opts.keysDir, `${prefix}-secrets.json`);
    if (!existsSync(secretsFile)) writeJson(secretsFile, { csrfHmacKey: randomBytes(32).toString('hex'), nonceKey: randomBytes(32).toString('hex'), label: 'DEMO-ONLY' });

    const admin = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint, { reasonCode: 'DEMO_SETUP', reasonText: 'register the DEMO-ONLY seal key' });
    const key = esig.hmacSealKey(seal.keyId, Buffer.from(seal.secret, 'base64'));
    await withCommand(db.app, admin, (c) => esig.registerSealKey(c, key, 'DEMO-ONLY seal key (HMAC-SHA256)'));

    const ctx: FeatureSeedContext = {
      installation: kind,
      database: opts.database,
      pools: { admin: db.admin, app: db.app, authn: db.authn },
      persona: (k) => personaOf(seed, k),
      actorFor: async (k): Promise<ActorContext> => {
        const a = await openPersonaSession(db, seed, k);
        return { ...a, reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' };
      },
      adminActor: () => passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint, { reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' }),
      exchangeDir: opts.exchangeDir,
      gatewaySpki: opts.gatewaySpki ?? null,
      log,
    };
    // The vendor rule tables (kernel and tablets) on both installations, before any feature seed needs them.
    await publishRuleTables(ctx, await ctx.actorFor('steward'));
    for (const f of FEATURES.filter((x) => x.installations.includes(kind))) {
      if (f.module.seed) {
        log(`seeding feature ${f.name}`);
        await f.module.seed(ctx);
      }
    }

    writeJson(join(opts.keysDir, `${prefix}-seed.json`), seed);
    writeJson(join(opts.keysDir, `${prefix}-demo-devices.json`), demoDevicesOf(seed));
    if (kind === 'SANDBOX') {
      writeJson(join(opts.keysDir, 'sandbox-service-keys.json'), {
        label: 'DEMO-ONLY service secrets',
        services: seed.services.map((s) => ({ ...s, fingerprint: seed.terminals.find((t) => t.code === s.terminal)?.fingerprint ?? null, terminalKey: seed.terminals.find((t) => t.code === s.terminal)?.key ?? null })),
      });
    }
    log(`${kind} installation ${opts.database} is ready (${seed.personas.length} personas, ${seed.terminals.length} terminals)`);
    return seed;
  } finally {
    await db.close();
  }
}

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
    ...(values['gateway-spki'] ? { gatewaySpki: values['gateway-spki'] } : {}),
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`set-up failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
