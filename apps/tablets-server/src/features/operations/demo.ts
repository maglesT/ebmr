/**
 * Demo and test data from the operations screen (Phase 7 slice 7g-4; decision 0025 point 2): load the demo data, or
 * reset the installation to a clean state, on a sandbox or a demo installation only (tablets 1485, EBMR-OPS-010, asked
 * first; D-P7g4-1). Both recreate the database the server runs on, so they run as one job at a time while the server
 * answers nothing but the job's state, the meta and the set-up state (maintenance, platform/operations.ts):
 *  1. the person's act is recorded (tab.record_demo_act: refused on a GMP installation that is not a demo one, then
 *     PLATFORM.OPERATE) and logged; the record goes with the database, the server's log keeps the line;
 *  2. the background workers stop (the adapters' workers, the analytics runner); the pools are told to expect their idle
 *     connections to end with the database;
 *  3. LOAD: the set-up the CLI runs (cli/installation.ts setupInstallation, AppContext.operations.demoTooling: the
 *     personas and terminals of test-kit, the
 *     feature seeds, optionally the GMP review batch and packaging order, the backup service identity); RESET: the
 *     database is created again migrated but not set up, with a new one-time set-up token the requester was shown;
 *  4. the server takes the new installation's seal key, demo terminals and site zone (no one is signed in any more: every
 *     session went with the database), and the analytics runner starts again.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import type { DemoJobView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { demoState } from '../../platform/installation.ts';
import { sealKeyFromFile } from '../../platform/ports.ts';
import { readPolicySiteZone } from '../../platform/site-zone.ts';

export type DemoJobKind = 'LOAD' | 'RESET';

export interface DemoJobOptions {
  kind: DemoJobKind;
  reviewBatch: boolean;
  packaging: boolean;
  /** RESET: the new installation's set-up token (its SHA-256 is stored once the database exists). */
  setupToken?: string;
}

/** The one demo job of this server process. */
export class DemoJobs {
  #state: DemoJobView['state'] = 'IDLE';
  #kind: DemoJobKind | null = null;
  #step: string | null = null;
  #error: string | null = null;
  #startedMs: number | null = null;

  view(): DemoJobView {
    return {
      state: this.#state,
      kind: this.#kind,
      step: this.#step,
      error: this.#error,
      elapsedSeconds: this.#startedMs === null ? null : String(Math.max(0, Math.floor((performance.now() - this.#startedMs) / 1000))),
    };
  }

  running(): boolean {
    return this.#state === 'RUNNING';
  }

  /** Starts `work` as the job (the caller checked that none runs); returns at once with the job's view. */
  start(kind: DemoJobKind, work: (step: (s: string) => void) => Promise<void>): DemoJobView {
    this.#state = 'RUNNING';
    this.#kind = kind;
    this.#step = 'starting';
    this.#error = null;
    this.#startedMs = performance.now();
    void work((s) => {
      this.#step = s;
    }).then(
      () => {
        this.#state = 'DONE';
        this.#step = 'done';
      },
      (e: unknown) => {
        this.#state = 'FAILED';
        this.#error = e instanceof Error ? e.message : String(e);
      },
    );
    return this.view();
  }

  /** Waits for the job in progress (tests and the server's close). */
  async settled(timeoutMs = 600_000): Promise<DemoJobView> {
    const deadline = performance.now() + timeoutMs;
    while (this.#state === 'RUNNING' && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return this.view();
  }
}

/** Logs instead of letting an idle connection that ends with the dropped database stop the process. */
function expectIdleErrors(pool: pg.Pool, log: AppContext['log']): void {
  if (pool.listenerCount('error') > 0) return;
  pool.on('error', (e) => log.warn({ err: e.message }, 'an idle database connection ended (the installation is being recreated)'));
}

/** The gateway's public key of a demo sandbox (tools/demo ensureGatewayKey writes it beside the keys), if any. */
function gatewaySpkiOf(keysDir: string): string | undefined {
  const file = join(keysDir, 'gateway-key.json');
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { publicKeySpki?: unknown };
  return typeof parsed.publicKeySpki === 'string' ? parsed.publicKeySpki : undefined;
}

/** The job's work (header, steps 2 to 4). */
export async function recreateInstallation(app: AppContext, opts: DemoJobOptions, step: (s: string) => void): Promise<void> {
  const config = app.config;
  if (!config.adminUrl) throw new Error('no EBMR_PG_ADMIN_URL: this server cannot recreate its database');
  const ops = app.operations;
  const what = opts.kind === 'LOAD' ? `The demo data is being loaded into ${config.database}.` : `${config.database} is being reset to a clean state.`;
  ops.maintenance = what;
  try {
    step('stopping the background workers');
    await ops.adapters?.stopAll();
    await ops.analytics?.stop();
    expectIdleErrors(app.pools.app, app.log);
    expectIdleErrors(app.pools.authn.pool, app.log);
    if (ops.analytics?.pool) expectIdleErrors(ops.analytics.pool, app.log);
    // The set-up CLI's own code (cli/installation.ts), handed over by the server's entry point (platform/operations.ts).
    const installation = ops.demoTooling;
    if (!installation) throw new Error('this server holds no demo tooling (it is handed over with EBMR_PG_ADMIN_URL set)');
    if (opts.kind === 'LOAD') {
      if (!config.keysDir) throw new Error('no keys directory (EBMR_KEYS_DIR or EBMR_DEMO_KEYS_FILE): the demo data has nowhere to write its DEMO-ONLY keys');
      const keysDir = config.keysDir;
      const gatewaySpki = config.installation === 'SANDBOX' ? gatewaySpkiOf(keysDir) : undefined;
      await installation.setupInstallation({
        installation: config.installation,
        database: config.database,
        keysDir,
        exchangeDir: config.exchangeDir,
        personaSets: 1,
        recreate: true,
        reviewBatch: opts.reviewBatch,
        packaging: opts.packaging,
        backupIdentity: true,
        adminUrl: config.adminUrl,
        ...(gatewaySpki ? { gatewaySpki } : {}),
        log: step,
      });
    } else {
      await installation.recreateEmptyInstallation({ installation: config.installation, database: config.database, adminUrl: config.adminUrl, log: step });
      if (opts.setupToken) await installation.issueSetupToken(config.database, opts.setupToken, 24 * 60, config.adminUrl);
    }
    step('taking the new installation');
    app.sealKey = sealKeyFromFile(config.sealKeyFile);
    const demo = await demoState(app.pools.app, config);
    app.demo = { enabled: demo.enabled, devices: demo.devices };
    // No session is left (they went with the database), so the zone of the new installation is taken (DI-27).
    const zone = await readPolicySiteZone(app.pools.app);
    if (zone !== null) app.siteZone.expectNewInstallationZone(zone);
    ops.maintenance = null;
    await app.siteZone.check();
    await ops.analytics?.start();
  } finally {
    ops.maintenance = null;
  }
}
