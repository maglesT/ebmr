/**
 * Backups from the operations screen (Phase 7 slice 7g-4; decision 0025 point 2; control DI-45; kernel 1376, tablets
 * 1485). The person asks (continuity.request_backup: CONTINUITY.BACKUP_RUN, the system administrator, with the reason);
 * the job then runs as the kernel's backup job always does (continuity runBackupJob: pg_dump in custom format, AES-256-GCM
 * at rest, SHA-256 fixity, a manifest, read-only files, a JSON and Markdown report) and is recorded by the backup service
 * identity (continuity.record_backup_job: a SYSTEM source in SERVICE_ACCOUNT, CONTINUITY.BACKUP_RECORD; a failure raises
 * the BACKUP_JOB_FAILED alarm), under the job name request-<request id>. The catalogue is read by session
 * (tab.backup_overview: CONTINUITY.BACKUP_READ) and a copy of a stored artefact, as stored (encrypted), is handed to the
 * screen once the copy is recorded (continuity.record_backup_download: CONTINUITY.BACKUP_RUN).
 *
 * Configuration: EBMR_BACKUP_DIR (the server's backup directory; the screen copies only artefacts stored there),
 * EBMR_BACKUP_KEY_FILE and EBMR_BACKUP_KEY_REF, EBMR_BACKUP_SOURCE_URL (pg_dump's login; default EBMR_PG_ADMIN_URL), and
 * the backup service identity's entry in the service-keys file (its SERVER terminal BACKUP_TERMINALS). Retention-grade
 * copies need write-once storage, which this server's directory is not: they stay the backup host's scheduled job
 * (ops/backup/backup.sh), and the screen asks for OPERATIONAL backups only.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { continuity, identity, type ActorContext } from '@ebmr/kernel';
import type { BackupFileView, BackupRunView, BackupsView, BackupView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';

/** The backup service identity's SERVER terminal in the service-keys file, by installation kind. */
export const BACKUP_TERMINALS = { GMP: 'SRV-BACKUP-01', SANDBOX: 'TEST-SRV-BACKUP-01' } as const;

/** The largest artefact the screen hands over (larger ones are fetched from the backup store). */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

interface BackupIdentity {
  loginName: string;
  serviceKey: string;
  fingerprint: string;
}

function backupIdentityOf(app: AppContext): BackupIdentity | null {
  const file = app.config.serviceKeysFile;
  if (!file || !existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { services?: { terminal: string; loginName: string; serviceKey: string; fingerprint?: string | null; terminalKey?: { fingerprint?: string } | null }[] };
  const e = (parsed.services ?? []).find((s) => s.terminal === BACKUP_TERMINALS[app.installation]);
  const fingerprint = e?.terminalKey?.fingerprint ?? e?.fingerprint ?? null;
  return e && fingerprint ? { loginName: e.loginName, serviceKey: e.serviceKey, fingerprint } : null;
}

/** What the server lacks to run a backup, or null. */
export function backupProblem(app: AppContext): string | null {
  const b = app.config.backup;
  if (!b) return 'No backup directory is configured on this server (EBMR_BACKUP_DIR).';
  if (!b.keyFile || !existsSync(b.keyFile)) return 'No backup encryption key is configured on this server (EBMR_BACKUP_KEY_FILE): backups are always encrypted.';
  if (!b.sourceUrl) return 'No connection for pg_dump is configured (EBMR_BACKUP_SOURCE_URL, or EBMR_PG_ADMIN_URL).';
  if (!backupIdentityOf(app)) return `No backup service identity is configured (its terminal ${BACKUP_TERMINALS[app.installation]} in the service-keys file, EBMR_SERVICE_KEYS_FILE): the job is recorded by it.`;
  return null;
}

const notConfigured = (why: string) =>
  refusal(503, {
    code: 'BACKUP_NOT_CONFIGURED',
    kind: 'NOT_ENABLED',
    whatHappened: 'No backup was taken: this server is not set up to run backups from the screen.',
    why,
    controls: ['DI-45'],
    whatYouCanDo: ['Ask the system administrator to configure the backup directory, key and service identity.'],
    whoCanHelp: ['The system administrator'],
  });

/** The stored artefact's path when it lies in this server's backup directory, else null. */
function localArtefact(app: AppContext, storageUri: string): string | null {
  const dir = app.config.backup?.dir;
  if (!dir || !storageUri.startsWith('file://')) return null;
  const path = resolve(storageUri.slice('file://'.length));
  const root = resolve(dir);
  return path.startsWith(root + sep) && existsSync(path) ? path : null;
}

interface OverviewRow {
  backups: { backupId: string; tier: BackupView['tier']; method: string; databaseName: string; sha256: string; sizeBytes: string; storageUri: string; immutableUntil: string | null; encryptionKeyRef: string; toolVersion: string; snapshotTakenAtUs: string; recordedAtUs: string }[];
  runs: { jobRunId: string; jobName: string; tier: BackupRunView['tier']; status: BackupRunView['status']; backupId: string | null; error: string | null; startedAtUs: string; finishedAtUs: string }[];
  requests: { requestId: string; tier: BackupView['tier']; reason: string; by: string; recordedAtUs: string }[];
}

export async function backupsView(app: AppContext, tokenHash: string): Promise<BackupsView> {
  const { rows } = await app.pools.app.query<{ r: OverviewRow }>('select tab.backup_overview($1) as r', [tokenHash]);
  const r = rows[0]?.r ?? { backups: [], runs: [], requests: [] };
  const problem = backupProblem(app);
  return {
    configured: problem === null,
    problem,
    backups: r.backups.map((b) => ({
      backupId: b.backupId, tier: b.tier, method: b.method, databaseName: b.databaseName, sha256: b.sha256, sizeBytes: b.sizeBytes, storageUri: b.storageUri,
      immutableUntil: b.immutableUntil, encryptionKeyRef: b.encryptionKeyRef, toolVersion: b.toolVersion,
      snapshotTakenAt: app.formatInstant(b.snapshotTakenAtUs), recordedAt: app.formatInstant(b.recordedAtUs),
      downloadable: localArtefact(app, b.storageUri) !== null,
    })),
    runs: r.runs.map((j) => runView(app, j)),
    requests: r.requests.map((q) => ({ requestId: q.requestId, tier: q.tier, reason: q.reason, by: q.by, recordedAt: app.formatInstant(q.recordedAtUs) })),
  };
}

function runView(app: AppContext, j: OverviewRow['runs'][number]): BackupRunView {
  return {
    jobRunId: j.jobRunId, jobName: j.jobName, tier: j.tier, status: j.status, backupId: j.backupId, error: j.error,
    startedAt: app.formatInstant(j.startedAtUs), finishedAt: app.formatInstant(j.finishedAtUs),
  };
}

/** Before the request is recorded: the screen asks for operational backups on a configured server only. */
export function assertBackupRunnable(app: AppContext, tier: 'RETENTION_GRADE' | 'OPERATIONAL'): void {
  if (tier === 'RETENTION_GRADE') {
    throw refusal(422, {
      code: 'BACKUP_TIER_NOT_HERE',
      kind: 'NOT_ALLOWED',
      whatHappened: 'No backup was taken: a retention-grade backup is not taken from the screen.',
      why: 'A retention-grade copy is kept on write-once storage for the retention period; this server\'s backup directory is not write-once. The backup host takes them on its schedule.',
      controls: ['DI-45'],
      whatYouCanDo: ['Take an operational backup here.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  const problem = backupProblem(app);
  if (problem) throw notConfigured(problem);
}

/** The backup service identity's SYSTEM context (SERVICE_ACCOUNT holds CONTINUITY.BACKUP_RECORD, kernel 0700). */
async function backupServiceActor(app: AppContext, who: BackupIdentity, requestId: string): Promise<ActorContext & { deviceId: string }> {
  const siteZone = app.siteZone.current();
  const ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: who.loginName, secret: who.serviceKey, deviceFingerprint: who.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(app.pools.app, ev.authEventId, who.fingerprint);
  const { rows } = await app.pools.app.query<{ person_id: string; account_id: string; legal_name: string }>(
    'select a.person_id, a.id as account_id, p.legal_name from iam.account a join iam.person p on p.id = a.person_id where a.login_name = $1',
    [who.loginName],
  );
  const p = rows[0];
  if (!p) throw new Error(`the backup service account ${who.loginName} does not exist`);
  return {
    personId: p.person_id, accountId: p.account_id, roleCode: 'SERVICE_ACCOUNT', sessionId: s.sessionId, deviceId: s.deviceId, source: 'SYSTEM', siteZone,
    legalName: p.legal_name, reasonCode: 'BACKUP_REQUEST', reasonText: `backup requested from the operations screen (request ${requestId})`,
  };
}

/** Runs the requested backup (header) and returns its recorded run, or why it failed. */
export async function runRequestedBackup(app: AppContext, requestId: string, tier: 'RETENTION_GRADE' | 'OPERATIONAL'): Promise<{ run: BackupRunView | null; error: string | null }> {
  const b = app.config.backup;
  const who = backupIdentityOf(app);
  if (!b || !b.keyFile || !b.sourceUrl || !who) return { run: null, error: backupProblem(app) };
  const actor = await backupServiceActor(app, who, requestId);
  try {
    const outcome = await continuity.runBackupJob({
      sourceUrl: b.sourceUrl,
      backupDir: b.dir,
      reportDir: join(b.dir, 'reports'),
      jobName: `request-${requestId}`,
      tier,
      encryptionKey: { file: b.keyFile },
      encryptionKeyRef: b.keyRef,
      recorder: { pool: app.pools.app, ctx: { ...actor, correlationId: globalThis.crypto.randomUUID() } },
    });
    const id = outcome.report.jobRunId;
    if (!id) return { run: null, error: outcome.report.recordError ?? outcome.report.error ?? 'the backup job was not recorded' };
    const { rows } = await app.pools.app.query<OverviewRow['runs'][number]>(
      `select id::text as "jobRunId", job_name as "jobName", tier, status, backup_id as "backupId", error_text as error,
              (extract(epoch from started_at) * 1000000)::bigint::text as "startedAtUs", (extract(epoch from finished_at) * 1000000)::bigint::text as "finishedAtUs"
         from continuity.backup_job_run where id = $1`,
      [id],
    );
    const row = rows[0];
    return { run: row ? runView(app, row) : null, error: outcome.report.error };
  } finally {
    await identity.endSession(app.pools.app, actor.sessionId).catch(() => undefined);
  }
}

/** The recorded run of a backup request (a resend of the request is answered with it). */
export async function requestedRun(app: AppContext, requestId: string): Promise<{ run: BackupRunView | null; error: string | null }> {
  const { rows } = await app.pools.app.query<OverviewRow['runs'][number]>(
    `select id::text as "jobRunId", job_name as "jobName", tier, status, backup_id as "backupId", error_text as error,
            (extract(epoch from started_at) * 1000000)::bigint::text as "startedAtUs", (extract(epoch from finished_at) * 1000000)::bigint::text as "finishedAtUs"
       from continuity.backup_job_run where job_name = $1 order by recorded_at desc limit 1`,
    [`request-${requestId}`],
  );
  const row = rows[0];
  return row ? { run: runView(app, row), error: row.error } : { run: null, error: 'the backup of this request is not recorded (yet)' };
}

/** The stored artefact of `backupId` and its manifest, as stored (the download was recorded by the caller). */
export async function backupFile(app: AppContext, backupId: string): Promise<BackupFileView> {
  const { rows } = await app.pools.app.query<{ uri: string; sha: string; size: string }>(
    'select storage_uri as uri, artefact_sha256 as sha, size_bytes::text as size from continuity.backup_catalogue where backup_id = $1',
    [backupId],
  );
  const row = rows[0];
  const path = row ? localArtefact(app, row.uri) : null;
  if (!row || !path) {
    throw refusal(404, {
      code: 'BACKUP_NOT_HERE',
      kind: 'NOT_ENABLED',
      whatHappened: 'This backup cannot be copied from the screen: this server does not hold its artefact.',
      why: row ? `It is stored at ${row.uri}.` : `No backup ${backupId} is in the catalogue.`,
      controls: ['DI-45'],
      whoCanHelp: ['The system administrator'],
    });
  }
  if (statSync(path).size > MAX_DOWNLOAD_BYTES) {
    throw refusal(413, {
      code: 'BACKUP_TOO_LARGE',
      kind: 'NOT_ALLOWED',
      whatHappened: 'This backup is too large to copy through the screen.',
      why: `It holds ${row.size} bytes; the screen hands over up to ${String(MAX_DOWNLOAD_BYTES)}. It is stored at ${row.uri}.`,
      controls: ['DI-45'],
      whoCanHelp: ['The system administrator'],
    });
  }
  const content = readFileSync(path);
  const manifestFile = join(app.config.backup?.dir ?? '', `${backupId}.manifest.json`);
  return {
    backupId,
    fileName: basename(path),
    sizeBytes: String(content.length),
    sha256: row.sha,
    contentBase64: content.toString('base64'),
    manifest: existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : '{}',
  };
}
