/**
 * Phase 7 slice 7g-4 (decision 0025 point 2): what the operations screens act on in the running server, held in the
 * AppContext so that the feature that owns a worker (the integrations feature its adapters, buildApp the analytics
 * runner) hands its control over without the operations feature importing it.
 *
 *  - adapters: the integration adapters' workers (features/integrations/adapters/start.ts); null until the integrations
 *    feature has started (GMP only).
 *  - analytics: the analytics runner (GMP with EBMR_ANALYTICS on); null otherwise.
 *  - maintenance: set while a demo load or reset recreates the database; every API request but the meta, the set-up state
 *    and the job's own state is refused meanwhile (MAINTENANCE, 503; app.ts).
 */
import type pg from 'pg';
import type { IntegrationSourceSystem } from '@ebmr/api-contract';
import { refusal, type HttpRefusal } from './http/refusal.ts';

export interface AdapterWorkerState {
  code: string;
  system: IntegrationSourceSystem;
  running: boolean;
  state: 'IDLE' | 'RUNNING' | 'RETRYING' | 'BLOCKED' | 'STOPPED';
  /** Why it is not running when it was refused (EBMR-INT-034, not configured, STAND_IN), or its last error. */
  problem: string | null;
}

export interface AdapterControl {
  /** Every ACTIVE adapter registration of the database, with this server's worker for it (or STOPPED). */
  list(): Promise<AdapterWorkerState[]>;
  /** Starts the adapter's worker; the refusal (why it may not start) or null when it runs. Never throws for a refusal. */
  start(code: string): Promise<string | null>;
  /** Stops the adapter's worker (no-op when none runs). */
  stop(code: string): Promise<void>;
  /** Stops every worker (the server closes, or a demo load or reset recreates the database). */
  stopAll(): Promise<void>;
}

export interface AnalyticsControl {
  running(): boolean;
  /** Starts the runner; false when it refused (its connection is not the analytics role alone, P6A7-8). */
  start(): Promise<boolean>;
  stop(): Promise<void>;
  /** The runner's own pool (a demo load or reset listens for its idle connections ending with the database). */
  pool: pg.Pool;
}

/**
 * The demo tooling (cli/installation.ts: the set-up CLI's own code, which seeds DEMO-ONLY credentials through the
 * test-kit). The server's entry point hands it over only to a server with EBMR_PG_ADMIN_URL (main.ts), so no feature
 * imports it and a production GMP server never loads it.
 */
export interface DemoTooling {
  setupInstallation(opts: {
    installation: 'GMP' | 'SANDBOX';
    database: string;
    keysDir: string;
    exchangeDir: string;
    personaSets: number;
    recreate: boolean;
    reviewBatch?: boolean;
    packaging?: boolean;
    backupIdentity?: boolean;
    adminUrl?: string;
    gatewaySpki?: string;
    log?: (message: string) => void;
  }): Promise<unknown>;
  recreateEmptyInstallation(opts: { installation: 'GMP' | 'SANDBOX'; database: string; adminUrl?: string; log?: (m: string) => void }): Promise<void>;
  issueSetupToken(database: string, token: string, minutes: number, adminUrl?: string): Promise<void>;
}

export interface OperationsRuntime {
  adapters: AdapterControl | null;
  analytics: AnalyticsControl | null;
  /** The demo tooling, on a server with EBMR_PG_ADMIN_URL only (main.ts); null otherwise. */
  demoTooling: DemoTooling | null;
  /** What the server is doing that keeps every other request out (a demo load or reset), or null. */
  maintenance: string | null;
}

export const newOperationsRuntime = (): OperationsRuntime => ({ adapters: null, analytics: null, demoTooling: null, maintenance: null });

/** The API paths answered during maintenance: what the SPA needs to show that it is under way and when it ends. */
export const MAINTENANCE_OPEN_PATHS: readonly string[] = ['/api/meta', '/api/setup/state', '/api/operations/demo/job'];

export function maintenanceRefusal(what: string): HttpRefusal {
  return refusal(503, {
    code: 'MAINTENANCE',
    kind: 'NOT_ENABLED',
    whatHappened: 'The installation is being recreated. Nothing was done.',
    why: what,
    controls: ['DI-05'],
    whatYouCanDo: ['Wait until the operations screen says the job has ended, then sign in again.'],
    whoCanHelp: ['The system administrator'],
  });
}
