/**
 * Command line for backup jobs and restore drills (control DI-45). Run through ops/backup/backup.sh and
 * ops/backup/drill.sh, or directly: `tsx packages/kernel/src/continuity/drill-cli.ts <drill|backup> ...`.
 *
 * Exit codes: 0 PASS / SUCCEEDED; 1 FAIL / FAILED (report written, alarm recorded when --record-url is
 * given); 2 usage error; 3 the result could not be recorded in the database.
 *
 * Credentials: prefer URLs without passwords plus PGPASSWORD or a password file, so secrets do not
 * appear in process lists; the tool never passes a password on a child process command line.
 */
import pg from 'pg';
import type { ActorContext } from '../db/command.ts';
import { loadKeyFile, recordRestoreDrill, runBackupJob, runRestoreDrill, type BackupJobOptions, type Recorder, type RestoreDrillOptions } from './backup-drill.ts';
import { readFileSync } from 'node:fs';

const USAGE = `usage:
  drill  --source-url URL --admin-url URL --report-dir DIR [--backup-dir DIR] [--encryption-key-file FILE]
         [--pg-bin DIR] [--sample-size N] [--keep-restored] [--no-isolate] [--record-url URL --actor-json JSON|@FILE]
  backup --source-url URL --backup-dir DIR --report-dir DIR --encryption-key-file FILE --encryption-key-ref REF
         [--job-name NAME] [--tier RETENTION_GRADE|OPERATIONAL] [--immutable-days N] [--storage-uri-prefix URI]
         [--pg-bin DIR] [--clock-url URL] [--record-url URL --actor-json JSON|@FILE]`;

const FLAGS = new Set(['--keep-restored', '--no-isolate']);

function parseArgs(argv: string[]): { command: string; opts: Map<string, string> } {
  const [command = '', ...rest] = argv;
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (FLAGS.has(a)) {
      opts.set(a, 'true');
      continue;
    }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    opts.set(a, v);
    i++;
  }
  return { command, opts };
}

function required(opts: Map<string, string>, key: string): string {
  const v = opts.get(key);
  if (v === undefined) throw new Error(`${key} is required`);
  return v;
}

function positiveInt(v: string, key: string): number {
  if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`${key} must be a positive whole number`);
  return Number(v);
}

function actorFrom(text: string): ActorContext {
  const json = text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text;
  const a = JSON.parse(json) as Partial<ActorContext>;
  for (const k of ['personId', 'accountId', 'roleCode', 'sessionId', 'source', 'siteZone'] as const) {
    if (typeof a[k] !== 'string' || a[k] === '') throw new Error(`--actor-json needs ${k}`);
  }
  return a as ActorContext;
}

async function withRecorder<T>(opts: Map<string, string>, work: (r: Recorder | undefined) => Promise<T>): Promise<T> {
  const url = opts.get('--record-url');
  if (url === undefined) return work(undefined);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    return await work({ pool, ctx: actorFrom(required(opts, '--actor-json')) });
  } finally {
    await pool.end();
  }
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { command, opts } = parsed;
  try {
    if (command === 'drill') {
      const o: RestoreDrillOptions = { sourceUrl: required(opts, '--source-url'), adminUrl: required(opts, '--admin-url'), reportDir: required(opts, '--report-dir') };
      const backupDir = opts.get('--backup-dir');
      if (backupDir) o.backupDir = backupDir;
      const keyFile = opts.get('--encryption-key-file');
      if (keyFile) o.encryptionKey = loadKeyFile(keyFile);
      const pgBin = opts.get('--pg-bin');
      if (pgBin) o.pgBin = pgBin;
      const sample = opts.get('--sample-size');
      if (sample) o.sampleSize = positiveInt(sample, '--sample-size');
      if (opts.has('--keep-restored')) o.keepRestoredDatabase = true;
      if (opts.has('--no-isolate')) o.isolate = false;
      return await withRecorder(opts, async (recorder) => {
        const outcome = await runRestoreDrill(o);
        console.log(`restore drill ${outcome.report.drillId}: ${outcome.report.result}`);
        for (const f of outcome.report.failures) console.log(`  - ${f}`);
        console.log(`report: ${outcome.jsonPath}\n        ${outcome.markdownPath}`);
        if (recorder) {
          try {
            console.log(`recorded as restore drill ${await recordRestoreDrill(recorder, outcome)}`);
          } catch (error) {
            console.error(`could not record the drill: ${(error as Error).message}`);
            return 3;
          }
        }
        return outcome.report.result === 'PASS' ? 0 : 1;
      });
    }
    if (command === 'backup') {
      const tier = opts.get('--tier') ?? 'OPERATIONAL';
      if (tier !== 'OPERATIONAL' && tier !== 'RETENTION_GRADE') throw new Error('--tier must be RETENTION_GRADE or OPERATIONAL');
      return await withRecorder(opts, async (recorder) => {
        const o: BackupJobOptions = {
          sourceUrl: required(opts, '--source-url'),
          backupDir: required(opts, '--backup-dir'),
          reportDir: required(opts, '--report-dir'),
          jobName: opts.get('--job-name') ?? 'scheduled',
          tier,
          encryptionKey: loadKeyFile(required(opts, '--encryption-key-file')),
          encryptionKeyRef: required(opts, '--encryption-key-ref'),
        };
        const days = opts.get('--immutable-days');
        if (days) o.immutableDays = positiveInt(days, '--immutable-days');
        const prefix = opts.get('--storage-uri-prefix');
        if (prefix) o.storageUriPrefix = prefix;
        const pgBin = opts.get('--pg-bin');
        if (pgBin) o.pgBin = pgBin;
        const clock = opts.get('--clock-url');
        if (clock) o.clockUrl = clock;
        if (recorder) o.recorder = recorder;
        const outcome = await runBackupJob(o);
        console.log(`backup job ${o.jobName}: ${outcome.report.status}${outcome.report.error ? ` (${outcome.report.error})` : ''}`);
        console.log(`report: ${outcome.jsonPath}\n        ${outcome.markdownPath}`);
        if (recorder && outcome.report.recordError) {
          console.error(`could not record the job: ${outcome.report.recordError}`);
          return outcome.report.status === 'SUCCEEDED' ? 3 : 1;
        }
        return outcome.report.status === 'SUCCEEDED' ? 0 : 1;
      });
    }
    console.error(`unknown command ${command || '(none)'}\n${USAGE}`);
    return 2;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
