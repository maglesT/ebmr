/**
 * The restore drill with its record (slice 7d; DI-02 clause 1, IN-09 clause 3, DI-45; ha-and-restore.md section 6).
 *
 * Around the kernel's restore drill (continuity.runRestoreDrill: backup under an exported snapshot with fixity, restore
 * into an isolated database, every chain and anchor verified on both sides, every table and sequence compared, sample
 * records opened with their audit trail), this adds what the release's restore drill must show:
 *  1. the records rendered completely from the restored copy (render.ts), each the same true copy as the source's;
 *  2. the signed restore event in the restored copy (restore-event.ts), when the drill has the people to sign it;
 *  3. a batch exported and restored into an isolated environment (export-roundtrip.ts);
 *  4. the measured restore time and recovery point beside the proposals of ha-and-restore.md section 3.
 * It writes a JSON report and a Markdown record that follows restore-drill-report-template.md (sections 1 to 9, the
 * reviewer's assessment and sign-off left to fill in).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { continuity, type esig } from '@ebmr/kernel';
import type { SiteSeed } from '@ebmr/test-kit';
import { connect, databaseSize, dropDatabase, elapsedMs, quoteIdent, withDatabase } from './db.ts';
import { exportAndRestore, type ExportRoundTrip } from './export-roundtrip.ts';
import { recordsToRender, renderRecord, type RenderedRecord } from './render.ts';
import { recordSignedRestoreEvent, type RestoreEventRecord } from './restore-event.ts';

export interface RecordedRestoreDrillOptions {
  /** The source database; a connection that can read every table and call the records functions (its owner or superuser). */
  sourceUrl: string;
  /** Superuser connection of the cluster the copy is restored into. */
  adminUrl: string;
  reportDir: string;
  purpose: string;
  renderLimit?: number;
  encryptionKeyFile?: string;
  pgBin?: string;
  /** The people and key that sign the restore event in the restored copy (DEMO-ONLY seed); null: not recorded here. */
  restoreEvent: { seed: SiteSeed; sealKey: esig.SealKeyProvider; ledgerFile?: string | null; changeReference: string } | null;
  /** The record exported and restored into isolation (default: the first record rendered). */
  exportChain?: string;
  /**
   * Export an external anchor of the source to the installation's ledger first (continuity.exportAnchor, as the
   * installation's anchor job does; needs restoreEvent.ledgerFile), so the restored copy is verified against it.
   */
  exportAnchorFirst?: boolean;
  /** Called with the restored copy's name after its records are rendered and its restore event recorded (the application may connect then). */
  inspectRestored?: (database: string) => Promise<void>;
  /** The proposals of ha-and-restore.md section 3 for this database. */
  proposals?: { rpoNode: string; rpoSite: string; rtoFailover: string; rtoFullRestore: string };
}

export interface RecordedRestoreReport {
  kind: 'ebmr.recorded-restore-drill';
  version: 1;
  result: 'PASS' | 'FAIL';
  failures: string[];
  openItems: string[];
  purpose: string;
  kernel: continuity.DrillReport;
  kernelReportSha256: string;
  sourceSizeBytes: number;
  renders: { chainKey: string; source: RenderedRecord; restored: RenderedRecord | null; same: boolean }[];
  restoreEvent: RestoreEventRecord | null;
  exportRoundTrip: ExportRoundTrip | null;
  measured: { restoreTimeMs: number; drillTimeMs: number; recoveryPoint: string; bytesPerSecond: number | null };
  proposals: NonNullable<RecordedRestoreDrillOptions['proposals']>;
  /** The anchor the drill exported first, or null. */
  anchorExported: string | null;
}

export interface RecordedRestoreOutcome {
  report: RecordedRestoreReport;
  jsonPath: string;
  markdownPath: string;
}

/** ha-and-restore.md section 3, the Tablets execution database. */
export const TABLETS_PROPOSALS = { rpoNode: '0', rpoSite: '5 min', rtoFailover: '15 min', rtoFullRestore: '8 h' } as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function grantApplication(adminUrl: string, database: string, grant: boolean): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    for (const role of ['ebmr_app', 'ebmr_authn']) await c.query(`${grant ? 'grant' : 'revoke'} connect on database ${quoteIdent(database)} ${grant ? 'to' : 'from'} ${role}`);
  } finally {
    await c.end();
  }
}

export async function runRecordedRestoreDrill(o: RecordedRestoreDrillOptions): Promise<RecordedRestoreOutcome> {
  const started = process.hrtime.bigint();
  const work = mkdtempSync(join(tmpdir(), 'ebmr-restore-drill-'));
  const failures: string[] = [];
  const openItems: string[] = [];
  try {
    let anchorExported: string | null = null;
    if (o.exportAnchorFirst) {
      if (!o.restoreEvent?.ledgerFile) throw new Error('exporting an anchor needs the installation\'s ledger file');
      const pool = new pg.Pool({ connectionString: o.sourceUrl, max: 1 });
      try {
        anchorExported = String((await continuity.exportAnchor(pool, new continuity.FileLedger(o.restoreEvent.ledgerFile, { database: o.restoreEvent.seed.database }))).anchor_id);
      } finally {
        await pool.end();
      }
    }
    // The records the drill renders, read from the source first.
    const src = await connect(o.sourceUrl);
    const sourceSizeBytes = await databaseSize(src);
    const keys = await recordsToRender(src, o.renderLimit ?? 16);
    const sourceRenders = new Map<string, RenderedRecord>();
    for (const k of keys) sourceRenders.set(k, await renderRecord(src, k));
    await src.end();
    if (keys.length === 0) failures.push('the source holds no record to render');

    const r0 = process.hrtime.bigint();
    const outcome = await continuity.runRestoreDrill({
      sourceUrl: o.sourceUrl,
      adminUrl: o.adminUrl,
      reportDir: o.reportDir,
      keepRestoredDatabase: true,
      ...(o.encryptionKeyFile ? { encryptionKey: { file: o.encryptionKeyFile } } : {}),
      ...(o.pgBin ? { pgBin: o.pgBin } : {}),
    });
    const restoreTimeMs = elapsedMs(r0);
    const k = outcome.report;
    if (k.result !== 'PASS') failures.push(...k.failures.map((f) => `kernel drill: ${f}`));
    const restored = k.restore?.database ?? null;
    const renders: RecordedRestoreReport['renders'] = [];
    let restoreEvent: RestoreEventRecord | null = null;
    let exportRoundTrip: ExportRoundTrip | null = null;
    if (restored) {
      const restoredUrl = withDatabase(o.adminUrl, restored);
      try {
        const rc = await connect(restoredUrl);
        try {
          for (const key of keys) {
            const s = sourceRenders.get(key);
            if (!s) continue;
            let r: RenderedRecord | null = null;
            try {
              r = await renderRecord(rc, key);
            } catch (error) {
              failures.push(`${key} could not be rendered from the restored copy: ${(error as Error).message}`);
            }
            // A chain the source extended after its rendering (the source keeps working) is compared up to the copy.
            const same = r !== null && (r.contentSha256 === s.contentSha256 || r.events > s.events);
            renders.push({ chainKey: key, source: s, restored: r, same });
            if (r && !same) failures.push(`${key}: the restored true copy differs from the source's`);
            for (const p of r?.problems ?? []) failures.push(`${key} (restored): ${p}`);
          }
        } finally {
          await rc.end();
        }
        if (o.restoreEvent) {
          // The application reaches the copy only for the restore event, as the restore procedure lets it back in.
          await grantApplication(o.adminUrl, restored, true);
          try {
            restoreEvent = await recordSignedRestoreEvent(
              {
                database: restored,
                seed: o.restoreEvent.seed,
                sealKey: o.restoreEvent.sealKey,
                ledgerFile: o.restoreEvent.ledgerFile ?? null,
                workDir: work,
                backup: { backupId: k.backup?.backupId ?? 'unknown', takenAt: k.backup?.snapshotTakenAt ?? null },
                changeReference: o.restoreEvent.changeReference,
              },
              o.adminUrl,
            );
            if (restoreEvent.status !== 'APPROVED') failures.push(`the restore event is ${restoreEvent.status}, not APPROVED`);
          } catch (error) {
            failures.push(`the signed restore event could not be recorded: ${(error as Error).message}`);
          } finally {
            await grantApplication(o.adminUrl, restored, false);
          }
        } else {
          openItems.push('The signed restore event was not recorded by this drill (no seed of signers given): record it by ha-and-restore.md section 5.2.');
        }
        if (o.inspectRestored) {
          await grantApplication(o.adminUrl, restored, true);
          try {
            await o.inspectRestored(restored);
          } finally {
            await grantApplication(o.adminUrl, restored, false).catch(() => undefined);
          }
        }
      } finally {
        await dropDatabase(o.adminUrl, restored);
        k.restore = k.restore ? { ...k.restore, dropped: true } : k.restore;
      }
    }
    const exportChain = o.exportChain ?? keys[0];
    if (exportChain) {
      const src2 = await connect(o.sourceUrl);
      try {
        exportRoundTrip = await exportAndRestore(src2, exportChain, work, exportChain);
        if (!exportRoundTrip.same) failures.push(`the export of ${exportChain} restored in isolation does not give the source's record: ${exportRoundTrip.isolated.problems.join('; ') || 'another content hash'}`);
        if (exportRoundTrip.isolated.environment.length > 0) failures.push(`the isolated environment saw variables: ${exportRoundTrip.isolated.environment.join(', ')}`);
        const kept = join(o.reportDir, `${k.drillId}-export.json`);
        mkdirSync(o.reportDir, { recursive: true });
        writeFileSync(kept, readFileSync(exportRoundTrip.file));
        exportRoundTrip.file = kept;
      } finally {
        await src2.end();
      }
    }
    const report: RecordedRestoreReport = {
      kind: 'ebmr.recorded-restore-drill',
      version: 1,
      result: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
      openItems,
      purpose: o.purpose,
      kernel: k,
      kernelReportSha256: outcome.reportSha256,
      sourceSizeBytes,
      renders,
      restoreEvent,
      exportRoundTrip,
      measured: {
        restoreTimeMs,
        drillTimeMs: elapsedMs(started),
        recoveryPoint: k.backup?.snapshotTakenAt ?? 'unknown',
        bytesPerSecond: restoreTimeMs > 0 ? Math.round((sourceSizeBytes * 1000) / restoreTimeMs) : null,
      },
      proposals: o.proposals ?? TABLETS_PROPOSALS,
      anchorExported,
    };
    mkdirSync(o.reportDir, { recursive: true });
    const jsonPath = join(o.reportDir, `${k.drillId}-recorded.json`);
    const markdownPath = join(o.reportDir, `${k.drillId}-recorded.md`);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    // The kernel's report again, now that the copy is dropped (the kernel drill kept it for the steps above).
    writeFileSync(markdownPath, renderRestoreRecord(report, continuity.renderDrillMarkdown(k)));
    return { report, jsonPath, markdownPath };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const cell = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v as string | number | boolean | bigint | null | undefined ?? '')).replace(/\|/g, '\\|');
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(2)} min`;

/** The record in the template's form (restore-drill-report-template.md). `kernelMarkdown`: the kernel drill's report. */
export function renderRestoreRecord(r: RecordedRestoreReport, kernelMarkdown: string): string {
  const k = r.kernel;
  const L: string[] = [];
  L.push(`# Restore drill record ${k.drillId}: ${r.result}`, '');
  L.push('Filled from `docs/operations/restore-drill-report-template.md` by `tools/drills` (sections 1 to 7 and the measurements); the reviewer completes sections 8 and 9.', '');
  L.push('## 1. Drill', '', '| Item | Value |', '|---|---|');
  L.push(`| Drill id | \`${k.drillId}\` |`, `| Purpose | ${cell(r.purpose)} |`, `| Started and finished | ${cell(k.startedAt)} to ${cell(k.finishedAt)} (database clock, UTC) |`);
  L.push(`| Duration | ${String(k.durationMs)} ms (kernel drill); ${String(r.measured.drillTimeMs)} ms with rendering, restore event and export |`);
  L.push(`| Source database and server version | ${cell(k.source.database)}, PostgreSQL ${cell(k.source.serverVersion)}, ${String(r.sourceSizeBytes)} bytes |`);
  L.push('| Change or validation record | (reviewer) |');
  L.push(`| External anchor exported before the backup | ${r.anchorExported ? `anchor ${r.anchorExported} (to the installation's ledger, as its anchor job does)` : 'none (the anchors already in the ledger are used)'} |`, '');
  // Sections 2 to 6 as the kernel drill wrote them.
  const from = kernelMarkdown.indexOf('## 2.');
  const to = kernelMarkdown.indexOf('## 7.');
  if (from >= 0 && to > from) L.push(kernelMarkdown.slice(from, to).trimEnd(), '');
  L.push('### 6a. Records rendered completely from the restored copy (IN-09 clause 3)', '', '| Record | Events | Signatures | Rows | Content SHA-256 (source) | Restored | Same | Complete |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.renders) {
    L.push(`| ${cell(x.chainKey)} | ${String(x.source.events)} | ${String(x.source.signatures)} | ${String(x.source.rows)} | \`${x.source.contentSha256.slice(0, 16)}\` | \`${(x.restored?.contentSha256 ?? '-').slice(0, 16)}\` | ${x.same ? 'yes' : 'NO'} | ${x.restored && x.restored.problems.length === 0 ? 'yes' : 'NO'} |`);
  }
  L.push('', '### 6b. Signed restore event in the restored copy', '');
  if (r.restoreEvent) {
    const e = r.restoreEvent;
    L.push('| Item | Value |', '|---|---|', `| Restore event | \`${e.restoreEventId}\` |`, `| Recorded by | ${cell(e.operator.legalName)} (${e.operator.roleCode}) |`, `| Approved by | ${cell(e.approver.legalName)} (${e.approver.roleCode}), signature \`${e.signatureId}\` (RESTORE_APPROVED) |`, `| Status | ${e.status} |`, `| Anchors compared | ${cell(Object.entries(e.anchorStatuses).map(([s, n]) => `${s} ${String(n)}`).join(', ') || 'none in the ledger')} |`);
  } else L.push('Not recorded by this drill (no signers given): record it by ha-and-restore.md section 5.2.');
  L.push('', '### 6c. Batch exported and restored into an isolated environment (DI-02 clause 1)', '');
  if (r.exportRoundTrip) {
    const x = r.exportRoundTrip;
    L.push('| Item | Value |', '|---|---|', `| Record | ${cell(x.chainKey)} |`, `| Export | \`${cell(x.file.split('/').pop())}\`, ${String(x.bytes)} bytes, export SHA-256 \`${x.exportSha256}\` |`);
    L.push(`| Isolated environment | a separate process with no environment variables (${String(x.isolated.environment.length)} seen) and no database connection |`);
    L.push(`| Restored there | ${String(x.isolated.events)} events, ${String(x.isolated.rows)} rows; offline verification ${x.isolated.ok ? 'passed' : `FAILED: ${cell(x.isolated.problems.join('; '))}`} |`);
    L.push(`| Content SHA-256 source / restored / its PDF | \`${x.sourceContentSha256.slice(0, 16)}\` / \`${(x.isolated.contentSha256 ?? '-').slice(0, 16)}\` / \`${(x.isolated.pdfContentSha256 ?? '-').slice(0, 16)}\` |`, `| Same record | ${x.same ? 'yes' : 'NO'} |`);
  } else L.push('No record to export.');
  L.push('', '## 7. Result and findings', '', `**${r.result}**`, '');
  if (r.failures.length === 0) L.push('No findings.');
  else for (const f of r.failures) L.push(`- ${f}`);
  for (const i of r.openItems) L.push(`- Open: ${i}`);
  L.push('', '## 8. Reviewer assessment', '', '| Question | Answer |', '|---|---|');
  L.push(`| Measured restore time (dump, restore, verification and comparison) | ${String(r.measured.restoreTimeMs)} ms (${minutes(r.measured.restoreTimeMs)}) for ${String(r.sourceSizeBytes)} bytes; RTO proposal for a full restore ${r.proposals.rtoFullRestore}, failover ${r.proposals.rtoFailover} |`);
  L.push(`| Measured recovery point | the copy holds every transaction committed before the backup snapshot (${cell(r.measured.recoveryPoint)}); RPO proposal ${r.proposals.rpoNode} on node loss, ${r.proposals.rpoSite} on site loss (archive_timeout: an installation item) |`);
  L.push('| Does the achieved restore time meet the RTO for this database (ha-and-restore.md section 3)? | (reviewer) |');
  L.push(`| Were the report hashes checked against \`continuity.restore_drill\`? | kernel report SHA-256 \`${r.kernelReportSha256}\` (reviewer) |`);
  L.push('| Deviations or incidents opened | (reviewer) |', '| Actions (owner, due date) | (reviewer) |', '');
  L.push('## 9. Sign-off', '', '| Role | Name | Signature | Date (with time zone) |', '|---|---|---|---|', '| Performed by (system administrator) | | | |', '| Reviewed by (CSV lead or IT quality) | | | |', '| Approved by (QA) | | | |', '');
  return `${L.join('\n')}\n`;
}

/** The SHA-256 of a report file (for the validation record). */
export const fileSha256 = (path: string): string => sha256(readFileSync(path, 'utf8'));

