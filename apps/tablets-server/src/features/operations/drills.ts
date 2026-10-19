/**
 * The drills and the installation hardening check from the operations screen (Phase 7 slice 7g, work package 2; decision
 * 0025 point 3; controls DI-45, DI-46, DI-48, DI-13; kernel 1395, tablets 1525). Each is what a command did:
 *
 *  - The restore drill (ops/backup/drill.sh, the kernel's drill-cli `drill`): a person asks for it with a reason
 *    (continuity.request_drill: CONTINUITY.BACKUP_RUN); the server runs the kernel's own drill as a job on the operations
 *    job runner (continuity.runRestoreDrill: a backup restored into an isolated database that no application can reach,
 *    record counts and hashes compared, chains verified, sample records opened with their audit trails), and the backup
 *    service identity records it (continuity.recordRestoreDrill: a SYSTEM source holding CONTINUITY.BACKUP_RECORD; a
 *    failed drill raises its alarm). It needs the server's backup configuration and an administration connection
 *    (EBMR_PG_ADMIN_URL) to create and drop the isolated database.
 *  - The upgrade drill (tools/drills `upgrade`): decision D-P7R-4: it needs administration access to the cluster and
 *    creates databases, so it runs on a sandbox or staging installation only; the database refuses its request on a GMP
 *    installation (EBMR-OPS-041) and the GMP screen shows the drill records and offers no run. The server runs the drill
 *    tool itself as a child process (as it runs the simulators), with the password out of its argument list, and the
 *    backup service identity records the outcome (continuity.record_upgrade_drill).
 *  - The hardening check (`security:hardening`, tools/security `hardening`): run by the server as a child process with the
 *    server's own configuration and the hardening check's database login (EBMR_HARDENING_DB_URL, a monitoring role, or
 *    EBMR_PG_ADMIN_URL; without one the screen runs no check); the person's record holds every
 *    check with its evidence (continuity.record_hardening_check: PLATFORM.OPERATE; a failed check raises its alarm).
 *
 * One drill job runs at a time (the job runner of demo.ts, with the drills' own kinds); the screen reads its state with
 * the records. Reports are written under the backup directory (drills/) or a temporary directory.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuity, identity, type ActorContext } from '@ebmr/kernel';
import type { DrillJobView, DrillsView, HardeningRunView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { backupIdentityOf, backupProblem, backupServiceActor } from './backups.ts';
import { DemoJobs } from './demo.ts';

export type DrillKind = 'RESTORE' | 'UPGRADE';
export const DRILL_REASON = 'DRILL_REQUEST';

/** The repository root of this installation (the installer runs the server from it, tools/install). */
const ROOT = new URL('../../../../../', import.meta.url).pathname;
const DRILLS_CLI = join(ROOT, 'tools', 'drills', 'src', 'cli.ts');
const SECURITY_CLI = join(ROOT, 'tools', 'security', 'src', 'cli.ts');

/** The drill job of this server process. */
export class DrillJobs extends DemoJobs<DrillKind> {}

export function restoreDrillProblem(app: AppContext): string | null {
  if (!app.config.adminUrl) return 'This server has no administration connection (EBMR_PG_ADMIN_URL), so it cannot create the isolated database a restore drill restores into.';
  return backupProblem(app);
}

export function upgradeDrillProblem(app: AppContext): string | null {
  if (app.installation === 'GMP') return 'The upgrade drill runs on a sandbox or staging installation only: it needs administration access to the database cluster and creates databases (D-P7R-4). This screen shows the drill records.';
  if (!app.config.adminUrl) return 'This server has no administration connection (EBMR_PG_ADMIN_URL), so it cannot copy a database to upgrade.';
  if (!existsSync(DRILLS_CLI)) return `The drill tool is not installed with this server (${DRILLS_CLI}).`;
  if (!backupIdentityOf(app)) return 'No backup service identity is configured (the service-keys file): the drill is recorded by it.';
  return null;
}

export function hardeningProblem(app: AppContext): string | null {
  if (!app.config.hardeningDbUrl) return 'This server has no login for the hardening check\'s database checks (EBMR_HARDENING_DB_URL, a monitoring role, or EBMR_PG_ADMIN_URL): without it the PostgreSQL settings, client authentication and roles are not judged.';
  return existsSync(SECURITY_CLI) ? null : `The hardening check tool is not installed with this server (${SECURITY_CLI}).`;
}

const hardeningNotConfigured = (why: string) =>
  refusal(503, {
    code: 'HARDENING_NOT_CONFIGURED',
    kind: 'NOT_ENABLED',
    whatHappened: 'No hardening check was run.',
    why,
    controls: ['DI-13'],
    whatYouCanDo: ['Ask the system administrator to configure the hardening check\'s database login.'],
    whoCanHelp: ['The system administrator'],
  });

const drillRefused = (why: string) =>
  refusal(409, {
    code: 'DRILL_NOT_POSSIBLE',
    kind: 'NOT_ENABLED',
    whatHappened: 'No drill was started.',
    why,
    controls: ['DI-45'],
    whatYouCanDo: ['Read the reason; the records of earlier drills stay on this screen.'],
    whoCanHelp: ['The system administrator'],
  });

/** Refuses before the request is recorded when the server cannot run the drill (the request's own transaction rolls back). */
export function assertDrillRunnable(app: AppContext, jobs: DrillJobs, kind: DrillKind): void {
  const problem = kind === 'RESTORE' ? restoreDrillProblem(app) : upgradeDrillProblem(app);
  if (problem) throw drillRefused(problem);
  if (jobs.running()) throw drillRefused('A drill is already running; wait until it ends.');
}

interface OverviewRow {
  restoreDrills: { drillId: string; sourceDatabase: string; restoredDatabase: string; backupSha256: string | null; result: 'PASS' | 'FAIL'; failures: string[]; tablesCompared: string; tablesMatching: string; chainsVerified: string; reportSha256: string; reportUri: string; startedAtUs: string; finishedAtUs: string; recordedAtUs: string }[];
  upgradeDrills: { drillId: string; requestId: string; sourceDatabase: string; fromRelease: string; result: 'PASS' | 'FAIL'; failures: string[]; tablesCompared: string; tablesChanged: string; chainsVerified: string; migrationsApplied: string; reportSha256: string; reportUri: string; recordedAtUs: string }[];
  requests: { requestId: string; kind: DrillKind; reason: string; sourceDatabase: string | null; by: string; recordedAtUs: string }[];
  hardeningChecks: { checkRunId: string; result: 'PASS' | 'FAIL'; checks: HardeningRunView['checks']; reportSha256: string; reason: string; by: string; recordedAtUs: string }[];
}

const hardeningView = (app: AppContext, h: OverviewRow['hardeningChecks'][number]): HardeningRunView => ({
  checkRunId: h.checkRunId, result: h.result, checks: h.checks, reportSha256: h.reportSha256, reason: h.reason, by: h.by, recordedAt: app.formatInstant(h.recordedAtUs),
});

async function overview(app: AppContext, tokenHash: string): Promise<OverviewRow> {
  const { rows } = await app.pools.app.query<{ r: OverviewRow }>('select tab.drill_overview($1) as r', [tokenHash]);
  const r = rows[0]?.r;
  if (!r) throw new Error('tab.drill_overview returned nothing');
  return r;
}

export async function drillsView(app: AppContext, jobs: DrillJobs, tokenHash: string): Promise<DrillsView> {
  const r = await overview(app, tokenHash);
  const restore = restoreDrillProblem(app);
  const upgrade = upgradeDrillProblem(app);
  const hardening = hardeningProblem(app);
  return {
    installation: app.installation,
    restore: { runnable: restore === null, problem: restore },
    upgrade: { runnable: upgrade === null, problem: upgrade },
    hardening: { runnable: hardening === null, problem: hardening },
    job: jobs.view(),
    restoreDrills: r.restoreDrills.map(({ startedAtUs, finishedAtUs, recordedAtUs, ...d }) => ({
      ...d,
      startedAt: app.formatInstant(startedAtUs),
      finishedAt: app.formatInstant(finishedAtUs),
      recordedAt: app.formatInstant(recordedAtUs),
    })),
    upgradeDrills: r.upgradeDrills.map(({ recordedAtUs, ...d }) => ({ ...d, recordedAt: app.formatInstant(recordedAtUs) })),
    requests: r.requests.map(({ recordedAtUs, ...q }) => ({ ...q, recordedAt: app.formatInstant(recordedAtUs) })),
    hardeningChecks: r.hardeningChecks.map((h) => hardeningView(app, h)),
  };
}

/** Runs `work` with the backup service identity's SYSTEM context, and ends its session afterwards. */
async function asBackupService<T>(app: AppContext, requestId: string, text: string, work: (ctx: ActorContext) => Promise<T>): Promise<T> {
  const who = backupIdentityOf(app);
  if (!who) throw new Error('no backup service identity is configured');
  const actor = await backupServiceActor(app, who, requestId, { code: DRILL_REASON, text });
  try {
    return await work({ ...actor, correlationId: randomUUID() });
  } finally {
    await identity.endSession(app.pools.app, actor.sessionId).catch(() => undefined);
  }
}

function reportDir(app: AppContext, kind: string): string {
  const base = app.config.backup?.dir ? join(app.config.backup.dir, 'drills', kind) : mkdtempSync(join(tmpdir(), `ebmr-${kind}-`));
  mkdirSync(base, { recursive: true });
  return base;
}

/** The restore drill job (header). */
export function startRestoreDrill(app: AppContext, jobs: DrillJobs, requestId: string): DrillJobView {
  const b = app.config.backup;
  const adminUrl = app.config.adminUrl;
  return jobs.start('RESTORE', async (step) => {
    if (!b?.sourceUrl || !adminUrl) throw new Error(restoreDrillProblem(app) ?? 'the restore drill is not configured');
    step('taking a drill backup and restoring it into an isolated database');
    const outcome = await continuity.runRestoreDrill({
      sourceUrl: b.sourceUrl,
      adminUrl,
      reportDir: reportDir(app, 'restore'),
      ...(b.keyFile ? { encryptionKey: { file: b.keyFile } } : {}),
    });
    step('recording the drill');
    await asBackupService(app, requestId, `restore drill requested from the operations screen (request ${requestId})`, (ctx) =>
      continuity.recordRestoreDrill({ pool: app.pools.app, ctx }, outcome),
    );
    if (outcome.report.result !== 'PASS') step(`recorded: FAIL (${outcome.report.failures.join('; ')})`);
  });
}

/** The URL without its password, which goes to the child process in PGPASSWORD (never in its argument list). */
function splitPassword(url: string): { url: string; env: Record<string, string> } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/** Runs a tool of this installation as a child process; resolves with its exit code and its last output lines. */
function runTool(cli: string, args: string[], env: Record<string, string>): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => resolve({ code: 127, tail: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, tail: out }));
  });
}

interface UpgradeReport {
  drillId: string;
  result: 'PASS' | 'FAIL';
  failures: string[];
  fromRelease: string;
  tables: { status: string }[];
  chains: { after: { chains: number } };
  migrations: { applied: unknown[] };
}

/** The upgrade drill job (header): the tool's report is recorded by the backup service identity. */
export function startUpgradeDrill(app: AppContext, jobs: DrillJobs, requestId: string, sourceDatabase: string, fromRelease: string): DrillJobView {
  const adminUrl = app.config.adminUrl;
  return jobs.start('UPGRADE', async (step) => {
    if (!adminUrl) throw new Error(upgradeDrillProblem(app) ?? 'the upgrade drill is not configured');
    const dir = reportDir(app, 'upgrade');
    const before = new Set(readdirSync(dir));
    step(`copying ${sourceDatabase} and upgrading the copy with this release's migrations`);
    const admin = splitPassword(adminUrl);
    const run = await runTool(DRILLS_CLI, ['upgrade', '--admin-url', admin.url, '--database', sourceDatabase, '--report-dir', dir, '--from-release', fromRelease], admin.env);
    const file = readdirSync(dir).find((f) => f.endsWith('.json') && !before.has(f));
    if (!file) throw new Error(`the upgrade drill wrote no report (exit ${String(run.code)}): ${run.tail.trim().split('\n').slice(-3).join(' | ')}`);
    const text = readFileSync(join(dir, file), 'utf8');
    const report = JSON.parse(text) as UpgradeReport;
    step('recording the drill');
    await asBackupService(app, requestId, `upgrade drill requested from the operations screen (request ${requestId})`, (ctx) =>
      withActorCommand(app.pools.app, ctx, (c) =>
        c.query('select continuity.record_upgrade_drill($1::jsonb)', [
          JSON.stringify({
            drill_id: report.drillId,
            request_id: requestId,
            source_database: sourceDatabase,
            from_release: report.fromRelease,
            result: report.result,
            failures: report.failures,
            tables_compared: report.tables.length,
            tables_changed: report.tables.filter((t) => t.status === 'CHANGED').length,
            chains_verified: report.chains.after.chains,
            migrations_applied: report.migrations.applied.length,
            report_sha256: createHash('sha256').update(text).digest('hex'),
            report_uri: `file://${join(dir, file)}`,
          }),
        ]),
      ),
    );
  });
}

/** The settings of this server the hardening check judges, as EBMR_* lines of an environment file. */
function serverEnvText(app: AppContext): string {
  const c = app.config;
  const env: Record<string, string> = {
    EBMR_ENV: c.env,
    EBMR_PUBLIC_ORIGIN: c.publicOrigin,
    EBMR_HOST: c.host,
    // Judged for their TLS settings; the passwords stay out of the file and of the record.
    EBMR_DB_APP_URL: splitPassword(c.appUrl).url,
    EBMR_DB_AUTHN_URL: splitPassword(c.authnUrl).url,
    ...(c.demoRequested ? { EBMR_DEMO: '1' } : {}),
    ...(c.demoKeysFile ? { EBMR_DEMO_KEYS_FILE: c.demoKeysFile } : {}),
  };
  return `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

interface HardeningReport {
  result: 'PASS' | 'FAIL';
  checks: HardeningRunView['checks'];
}

/** The hardening check (header), run now: the person's record of every check, returned as recorded. */
export async function runHardeningCheck(app: AppContext, actor: ActorContext, tokenHash: string, reason: string, allowedPorts: string[]): Promise<HardeningRunView> {
  const problem = hardeningProblem(app);
  if (problem) throw hardeningNotConfigured(problem);
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-hardening-'));
  try {
    // The server's own configuration, judged as the CLI judges an environment file (0600, removed afterwards).
    const envFile = join(dir, 'server.env');
    writeFileSync(envFile, serverEnvText(app), { mode: 0o600 });
    // The database checks read this database (the login's own database name is replaced by the server's).
    const login = splitPassword(withDatabase(app.config.hardeningDbUrl ?? '', app.config.database));
    const args = ['hardening', '--env-file', envFile, '--out', join(dir, 'out'), '--database-url', login.url, ...(allowedPorts.length > 0 ? ['--allow-ports', allowedPorts.join(',')] : [])];
    const run = await runTool(SECURITY_CLI, args, login.env);
    const json = join(dir, 'out', 'hardening.json');
    if (!existsSync(json)) throw drillRefused(`The hardening check wrote no report (exit ${String(run.code)}): ${run.tail.trim().split('\n').slice(-3).join(' | ')}`);
    const text = readFileSync(json, 'utf8');
    const report = JSON.parse(text) as HardeningReport;
    const id = await withActorCommand(app.pools.app, actor, async (c) => {
      const { rows } = await c.query<{ id: string }>('select continuity.record_hardening_check($1::jsonb, $2)::text as id', [
        JSON.stringify({ result: report.result, checks: report.checks, report_sha256: createHash('sha256').update(text).digest('hex') }),
        reason,
      ]);
      return rows[0]?.id ?? '';
    });
    const h = (await overview(app, tokenHash)).hardeningChecks.find((x) => x.checkRunId === id);
    if (!h) throw new Error(`hardening check ${id} not found after recording`);
    return hardeningView(app, h);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
