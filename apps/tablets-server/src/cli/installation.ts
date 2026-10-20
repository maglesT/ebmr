/**
 * Creating, seeding and resetting a demo, E2E or sandbox installation (module C0, decision D6). Phase 7 slice 7g-4 moved
 * this out of the set-up CLI's entry point (setup.ts, which now only reads its arguments) so that the CLI and the
 * operations screen's routes (features/operations, which import it at the time of use) run the same code. It stays in
 * src/cli, the one product directory allowed the test-kit (.dependency-cruiser.cjs): it seeds DEMO-ONLY credentials and
 * keys, never for a production GMP installation, and the routes run it only where the database allows the demo
 * conveniences (tablets 1485, EBMR-OPS-010). It is a library, not an entry point.
 *
 *  - setupInstallation: GMP creates the database, migrates kernel, site services, recipe-core and tablets SQL,
 *    bootstraps and seeds; SANDBOX provisions the sandbox through the kernel with every migration, bootstraps it (TEST-
 *    labels, kernel 1000; see test-kit sandbox.ts), then seeds. Both mark demo and E2E databases (names *_demo,
 *    *_e2e_*) with tab.demo_installation, register the DEMO-ONLY seal key, run each feature's seed (GMP also: QA's approval of a
 *    DEMO-ONLY validation summary of the release before the feature seeds, slice 7c, DI-03), and write into the keys
 *    directory:
 *      <kind>-seed.json          personas, terminals, service identities with DEMO-ONLY credentials
 *      <kind>-demo-devices.json  the device picker's terminals and keys (EBMR_DEMO_KEYS_FILE)
 *      <kind>-seal-key.json      DEMO-ONLY HMAC seal key (EBMR_SEAL_KEY_FILE), kept when present
 *      <kind>-secrets.json       CSRF and nonce keys (EBMR_SECRETS_FILE), kept when present
 *      <kind>-backup-key         with backupIdentity: the DEMO-ONLY backup encryption key (EBMR_BACKUP_KEY_FILE), kept
 *      sandbox-service-keys.json the sweeper's, the gateway's and the gateway API monitor's service secrets (EBMR_SERVICE_KEYS_FILE)
 *      gmp-service-keys.json     the GMP sweeper's service secret (EBMR_SERVICE_KEYS_FILE of the GMP server; D-P4-9)
 *      gmp-review-batch.json     with reviewBatch (GMP): the batch record built ready for review (cli/review-batch.ts)
 *    With backupIdentity (the CLI and the operations screen; not the golden set-ups, whose records it would change) it also
 *    creates the backup service identity (SERVICE_ACCOUNT, the kernel's role for CONTINUITY.BACKUP_RECORD) on its SERVER
 *    terminal and adds it to the service-keys file: the operations screen's backups run and are recorded under it.
 *  - recreateEmptyInstallation: drops the database and creates it again migrated but not set up (no accounts), marked
 *    as a demo installation when its name is one; the browser's first-run set-up then takes over.
 *  - issueSetupToken: a one-time set-up token (iam.issue_setup_token, kernel 1375), returned once; the database keeps
 *    only its SHA-256.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { esig, identity, sandbox, withCommand, type ActorContext } from '@ebmr/kernel';
import type { DemoDeviceView } from '@ebmr/api-contract';
import {
  ADMIN_URL,
  approveValidationSummary,
  asAdmin,
  bootstrapInstallation,
  createGmpDatabase,
  databaseExists,
  dropDatabase,
  editionMigrationSources,
  generateServiceKey,
  openDatabase,
  openPersonaSession,
  openServiceSession,
  passwordActor,
  personaOf,
  provisionBootstrappedSandbox,
  seedDemoSite,
  terminalOf,
  type DatabaseHandle,
  type DeviceKey,
  type ServiceKey,
  type SiteSeed,
} from '@ebmr/test-kit';
import { BACKUP_TERMINALS } from '../features/operations/backups.ts';
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
  /** Sandbox, hosted demo only: also register and bind the demo's simulated machines to the gateway. */
  demoProcessDevices?: boolean;
  /**
   * GMP, DEMO-ONLY (Phase 4 slice 1c): also build one GB-T-01 batch record ready for review (review-batch.ts), written to
   * `<keys>/gmp-review-batch.json` for the demo and the e2e specs.
   */
  reviewBatch?: boolean;
  /** GMP, DEMO-ONLY (Phase 4 slice 2c): with the review batch, also the packaging-order demo (review-batch.ts step 6). */
  packaging?: boolean;
  /** Phase 7 slice 7g-4: also the backup service identity and the DEMO-ONLY backup key (header). */
  backupIdentity?: boolean;
  /** The superuser connection to the database server (default: test-kit's, EBMR_PG_ADMIN_URL). */
  adminUrl?: string;
  log?: (message: string) => void;
}

export const DEMO_NAME = /(_demo$|_e2e_[a-z0-9]+$)/;

/** The backup service identity of a demo installation (slice 7g-4): its SERVER terminal, by kind. */
export const BACKUP_SERVICE = {
  GMP: { terminal: BACKUP_TERMINALS.GMP, legalName: 'Backup service', loginName: 'svc.backup' },
  SANDBOX: { terminal: BACKUP_TERMINALS.SANDBOX, legalName: 'TEST-backup service', loginName: 'test-svc-backup' },
} as const;

/**
 * The DEMO-ONLY seeds (--gmp-review-batch, --gmp-packaging) write superuser shortcuts (a status set complete, a hold point
 * set approved with a placeholder signature): they run only on a database named as a demo or E2E one (slice 2 review).
 */
export function demoSeedRefusal(opts: Pick<SetupOptions, 'database' | 'reviewBatch' | 'packaging'>): string | null {
  if (!opts.reviewBatch && !opts.packaging) return null;
  if (DEMO_NAME.test(opts.database)) return null;
  return `--gmp-review-batch and --gmp-packaging are DEMO-ONLY: database ${opts.database} is not a demo or E2E database (its name must end in _demo or _e2e_<hex>)`;
}

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
        // Every persona set (slice 7i, G1): a demo installation seeds one; the E2E stack one per worker, whose people the
        // browser tests sign in with the demo reader's Tap buttons as a presenter would.
        personas: seed.personas.filter((p) => p.homeTerminal === t.code).map((p) => ({ legalName: p.legalName, loginName: p.loginName, role: [p.roleCode, ...(p.alsoRoles ?? [])].join(', '), badgeUid: p.badgeUid })),
      })),
  };
}

/** The demo backup service identity's entry in the service-keys file (the shape adapterEntry and the backup job read). */
export interface BackupServiceEntry {
  key: 'backup';
  legalName: string;
  loginName: string;
  personId: string;
  accountId: string;
  roleCode: 'SERVICE_ACCOUNT';
  terminal: string;
  serviceKey: string;
  fingerprint: string;
  terminalKey: DeviceKey;
}

/**
 * The backup service identity (SERVICE_ACCOUNT; the kernel's role for CONTINUITY.BACKUP_RECORD) on its SERVER terminal,
 * through the kernel's identity administration as the other service identities are seeded (test-kit seed.ts): requested by
 * the administrator, approved by the process owner.
 */
export async function seedBackupIdentity(db: DatabaseHandle, kind: 'GMP' | 'SANDBOX', seed: SiteSeed, previous: DeviceKey | undefined): Promise<BackupServiceEntry> {
  const spec = BACKUP_SERVICE[kind];
  const reason = <T extends ActorContext>(c: T): T => ({ ...c, reasonCode: 'DEMO_SETUP', reasonText: 'the backup service identity of a demo installation', correlationId: globalThis.crypto.randomUUID() });
  const admin = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint);
  const owner = await passwordActor(db, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint);
  const key = previous ?? generateServiceKey();
  const created = await withCommand(db.app, reason(admin), async (c) => {
    await identity.registerDevice(c, { code: spec.terminal, deviceClass: 'SERVER', site: seed.siteCode, fingerprint: key.fingerprint, description: 'backup service (demo installation)' });
    const personId = await identity.createPerson(c, 'SYSTEM', spec.legalName);
    const accountId = await identity.createAccount(c, { personId, loginName: spec.loginName, kind: 'SERVICE' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode: 'SERVICE_ACCOUNT', reason: 'demo backup service identity' });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(db.app, reason(owner), (c) => identity.decideRoleGrant(c, created.grantId, true, 'demo backup service identity'));
  await identity.endSession(db.app, admin.sessionId);
  await identity.endSession(db.app, owner.sessionId);
  return {
    key: 'backup', legalName: spec.legalName, loginName: spec.loginName, personId: created.personId, accountId: created.accountId, roleCode: 'SERVICE_ACCOUNT',
    terminal: spec.terminal, serviceKey: created.secret, fingerprint: key.fingerprint, terminalKey: key,
  };
}

export async function setupInstallation(opts: SetupOptions): Promise<SiteSeed> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const adminUrl = opts.adminUrl ?? ADMIN_URL;
  const refused = demoSeedRefusal(opts);
  if (refused) throw new Error(refused);
  const kind = opts.installation;
  const prefix = kind === 'GMP' ? 'gmp' : 'sandbox';
  mkdirSync(opts.keysDir, { recursive: true, mode: 0o700 });
  for (const d of ['to-sandbox', 'to-gmp']) mkdirSync(join(opts.exchangeDir, d), { recursive: true });

  if (await databaseExists(opts.database, adminUrl)) {
    if (!opts.recreate) throw new Error(`database ${opts.database} exists; pass --recreate to drop it first`);
    log(`dropping ${opts.database}`);
    await dropDatabase(opts.database, adminUrl);
  }
  const sources = editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
  let bootstrap;
  if (kind === 'GMP') {
    log(`creating GMP database ${opts.database}`);
    await createGmpDatabase(opts.database, sources, adminUrl);
    bootstrap = await bootstrapInstallation(opts.database, 'GMP', adminUrl);
  } else {
    log(`provisioning sandbox ${opts.database}`);
    bootstrap = (await provisionBootstrappedSandbox(opts.database, sources, adminUrl)).bootstrap;
  }
  if (DEMO_NAME.test(opts.database)) {
    await asAdmin(opts.database, (c) => c.query('select tab.mark_demo_installation($1)', ['DEMO-ONLY installation created by the set-up CLI']), adminUrl);
    log('marked as a demo installation (device picker available with EBMR_DEMO=1)');
  }

  const previous = readJson<SiteSeed>(join(opts.keysDir, `${prefix}-seed.json`));
  const terminalKeys: Record<string, DeviceKey> = {};
  for (const t of previous?.terminals ?? []) if (t.key && t.code !== 'TEST-GW-01') terminalKeys[t.code] = t.key;

  const db = openDatabase(opts.database, kind, { adminUrl });
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
      ownerActor: () => passwordActor(db, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint, { reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' }),
      serviceActorFor: async (k): Promise<ActorContext> => ({ ...(await openServiceSession(db, seed, k as ServiceKey)), reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' }),
      signAs: async (signer, aggregate, meaning, expectedState): Promise<string> => {
        const p = personaOf(seed, signer);
        const t = terminalOf(seed, p.homeTerminal);
        const actor = { ...(await openPersonaSession(db, seed, signer)), reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' };
        // The set-up tool reads the content it shows the signer with the installation's own (superuser) connection: no
        // browser session exists here to preview it (tablets 0410). The challenge, the authentication and the signature
        // are the persona's, and the database's guards decide as for any signature.
        const content = await esig.contentForSigning(db.admin, aggregate.type, aggregate.id);
        const challenge = await withCommand(db.app, actor, (c) =>
          esig.createChallenge(c, { aggregateType: aggregate.type, aggregateId: aggregate.id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
        );
        const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
        const signed = await withCommand(db.app, actor, (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, key));
        return signed.signatureId;
      },
      exchangeDir: opts.exchangeDir,
      gatewaySpki: opts.gatewaySpki ?? null,
      demoProcessDevices: opts.demoProcessDevices ?? false,
      log,
    };
    // The vendor rule tables (kernel and tablets) on both installations, before any feature seed needs them. Imported
    // here, at the time of use: the features import the operations feature, which imports this module.
    const { publishRuleTables } = await import('../platform/rule-tables.ts');
    const { FEATURES } = await import('../features/index.ts');
    await publishRuleTables(ctx, await ctx.actorFor('steward'));
    if (kind === 'GMP') {
      // Slice 7c (DI-03, D-P7-12): a GMP batch is issued only on a release with an approved validation summary. The
      // demo or E2E installation's QA person approves a DEMO-ONLY summary of its release through the real signed act,
      // before any feature seed issues a batch. A production installation gets its summary from the customer's QA
      // (handbook 10-runbooks.md); this code refuses production (demoSeedRefusal).
      log('approving the DEMO-ONLY validation summary of the release (QA persona qaInvestigator)');
      await approveValidationSummary(
        {
          app: db.app,
          qa: async () => ({ ...(await openPersonaSession(db, seed, 'qaInvestigator')), reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' }),
          qaSign: (aggregate, meaning, expectedState) => ctx.signAs('qaInvestigator', aggregate, meaning, expectedState),
          systemOwner: () => passwordActor(db, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint, { reasonCode: 'DEMO_SETUP', reasonText: 'demo installation set-up' }),
        },
        { title: 'DEMO-ONLY validation summary of the demo or E2E installation' },
      );
    }
    for (const f of FEATURES.filter((x) => x.installations.includes(kind))) {
      if (f.module.seed) {
        log(`seeding feature ${f.name}`);
        await f.module.seed(ctx);
      }
    }

    if (opts.reviewBatch || opts.packaging) {
      if (kind !== 'GMP') throw new Error('--gmp-review-batch and --gmp-packaging are for the GMP installation');
      const { seedReviewBatch } = await import('./review-batch.ts');
      const batch = await seedReviewBatch({ database: opts.database, keysDir: opts.keysDir, exchangeDir: opts.exchangeDir, seed, db, log, packaging: opts.packaging === true });
      writeJson(join(opts.keysDir, 'gmp-review-batch.json'), { label: 'DEMO-ONLY review batch', ...batch });
    }

    let backup: BackupServiceEntry | null = null;
    if (opts.backupIdentity) {
      log('seeding the backup service identity');
      const previousKeys = readJson<{ services?: { terminal: string; terminalKey?: DeviceKey | null }[] }>(join(opts.keysDir, `${prefix}-service-keys.json`));
      const previousKey = previousKeys?.services?.find((s) => s.terminal === BACKUP_SERVICE[kind].terminal)?.terminalKey ?? undefined;
      backup = await seedBackupIdentity(db, kind, seed, previousKey);
      const keyFile = join(opts.keysDir, `${prefix}-backup-key`);
      if (!existsSync(keyFile)) writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    }

    writeJson(join(opts.keysDir, `${prefix}-seed.json`), seed);
    writeJson(join(opts.keysDir, `${prefix}-demo-devices.json`), demoDevicesOf(seed));
    const serviceEntry = (s: (typeof seed.services)[number]) => ({
      ...s,
      fingerprint: seed.terminals.find((t) => t.code === s.terminal)?.fingerprint ?? null,
      terminalKey: seed.terminals.find((t) => t.code === s.terminal)?.key ?? null,
    });
    const extra = backup ? [backup] : [];
    if (kind === 'SANDBOX') {
      writeJson(join(opts.keysDir, 'sandbox-service-keys.json'), { label: 'DEMO-ONLY service secrets', services: [...seed.services.map(serviceEntry), ...extra] });
    } else {
      // D-P4-9: the GMP server's in-process sweeper only (the ERP interface and the gateway run elsewhere with their own).
      writeJson(join(opts.keysDir, 'gmp-service-keys.json'), { label: 'DEMO-ONLY service secrets', services: [...seed.services.filter((s) => s.key === 'sweeper').map(serviceEntry), ...extra] });
    }
    log(`${kind} installation ${opts.database} is ready (${seed.personas.length} personas, ${seed.terminals.length} terminals)`);
    return seed;
  } finally {
    await db.close();
  }
}

/**
 * Drops `database` and creates it again, migrated and marked with its kind but not set up: no person, account or device.
 * A demo or E2E name is marked as a demo installation again. The first-run set-up of the browser takes over.
 */
export async function recreateEmptyInstallation(opts: { installation: 'GMP' | 'SANDBOX'; database: string; adminUrl?: string; log?: (m: string) => void }): Promise<void> {
  const adminUrl = opts.adminUrl ?? ADMIN_URL;
  const log = opts.log ?? (() => undefined);
  const sources = editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
  log(`dropping ${opts.database}`);
  await dropDatabase(opts.database, adminUrl);
  if (opts.installation === 'GMP') {
    log(`creating GMP database ${opts.database}`);
    await createGmpDatabase(opts.database, sources, adminUrl);
  } else {
    log(`provisioning sandbox ${opts.database}`);
    await sandbox.provisionSandboxDatabase({ adminUrl, database: opts.database, sources });
  }
  if (DEMO_NAME.test(opts.database)) {
    await asAdmin(opts.database, (c) => c.query('select tab.mark_demo_installation($1)', ['DEMO-ONLY installation reset from the operations screen']), adminUrl);
  }
}

/** A new one-time set-up token: 32 random bytes, base64url (43 characters). */
export function newSetupToken(): string {
  return randomBytes(32).toString('base64url');
}

export const setupTokenSha256 = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Stores the SHA-256 of `token` as the installation's one set-up token (kernel 1375), valid for `minutes`. */
export async function issueSetupToken(database: string, token: string, minutes: number, adminUrl?: string): Promise<void> {
  await asAdmin(database, (c) => c.query('select iam.issue_setup_token($1, $2)', [setupTokenSha256(token), minutes]), adminUrl ?? ADMIN_URL);
}
