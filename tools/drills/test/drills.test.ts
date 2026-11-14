/**
 * The release's drills on a database with records (slice 7d): the upgrade drill and migration dry run from the Phase
 * 6A exit's migrations to this tree's (DI-46 clause 2, DI-48 clause 1), then the restore drill with its record on the
 * upgraded database (DI-02 clause 1, IN-09 clause 3). The records are made by the database's own commands in the seed
 * personas' sessions (fixture.ts); the rendering after the upgrade and after the restore also goes through the archive
 * route as a QA person in a server built on the upgraded and on the restored database.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { ADMIN_URL, dropDatabase, urlFor, uniqueSuffix } from '@ebmr/test-kit';
import { tabletsMigrationSources } from '../src/sources.ts';
import { startServer } from '../../../apps/tablets-server/test/support/harness.ts';
import { readManifest, releaseSources } from '../src/release-manifest.ts';
import { runRecordedRestoreDrill } from '../src/restore.ts';
import { connect, withDatabase } from '../src/db.ts';
import { runUpgradeDrill, takeSamples, type UpgradeOutcome } from '../src/upgrade.ts';
import { buildDrillDatabase, type DrillDatabase } from './fixture.ts';

const manifest = readManifest();
const reports = mkdtempSync(join(tmpdir(), 'ebmr-drill-reports-'));
let old: DrillDatabase;
let upgraded: string;
let upgrade: UpgradeOutcome;
/**
 * The spot-check seed of the unit-change test. With a random seed the unit spot check (6 rows of each unit table at 24
 * spot checks) could draw only rows of platform.setting_definition without a unit, which the test's change leaves as
 * they are, and miss it. This seed draws 4 of its 6 sampled rows with a unit (15 of the table's 28 rows have one in the
 * Phase 6A database); the seed test below proves it on the drill's database.
 */
const UNIT_SEED = 'di48-unit-8';

/** A server on `database` (prepared: the harness drops it when it closes) and the PDF true copy of a batch as QA. */
async function renderThroughRoute(database: string, d: DrillDatabase, batchId: string) {
  const server = await startServer('GMP', { prepared: { database, seed: d.seed }, env: { EBMR_SEAL_KEY_FILE: d.sealKeyFile, EBMR_NUMBER_LEDGER_FILE: d.ledgerFile } });
  try {
    const qa = await server.asPersona('qaInvestigator');
    const r = await qa.call(routes.archive.pdf, { params: { batchId } });
    if (!r.ok) throw new Error(`archive.pdf: ${JSON.stringify(r.error)}`);
    return r.value;
  } finally {
    await server.close();
  }
}

beforeAll(async () => {
  old = await buildDrillDatabase(releaseSources(manifest, tabletsMigrationSources()), 'ebmr_drill6a');
  upgraded = `ebmr_drillrc_${uniqueSuffix()}`;
  upgrade = await runUpgradeDrill({ adminUrl: ADMIN_URL, sourceDatabase: old.database, sources: tabletsMigrationSources(), fromRelease: manifest.release, reportDir: reports, keepCopy: true, workDatabase: upgraded, spotChecks: 10 });
}, 900_000);

afterAll(async () => {
  await dropDatabase(upgraded).catch(() => undefined);
  await old?.drop();
  rmSync(reports, { recursive: true, force: true });
});

describe('upgrade drill and migration dry run from the Phase 6A exit (slice 7d)', () => {
  it('[DI-46] upgrade the test environment, then retrieve and render the record: content, audit trail and signatures intact and the hashes match', async () => {
    const r = upgrade.report;
    expect(r.failures).toEqual([]);
    expect(r.result).toBe('PASS');
    expect(r.source.migrationsBefore).toBe(manifest.files.length);
    // Every migration of this tree that the Phase 6A exit did not have, and nothing else.
    const had = new Set(manifest.files.map((f) => `${f.namespace}/${f.name}`));
    const expected = tabletsMigrationSources().flatMap((s) => readdirSync(s.directory).filter((f) => f.endsWith('.sql')).sort().map((f) => `${s.namespace}/${f}`)).filter((k) => !had.has(k));
    expect(r.migrations.applied.map((a) => `${a.namespace}/${a.name}`)).toEqual(expected);
    expect(r.source.schemaReleaseAfter).not.toBe(r.source.schemaReleaseBefore);
    // The batch and the master are rendered before and after, complete and with the same content.
    expect(old.batchId).not.toBeNull();
    const batch = r.renders.find((x) => x.chainKey === `batch:${old.batchId ?? ''}`);
    const master = r.renders.find((x) => x.chainKey === `mbr_version:${old.versionId}`);
    for (const x of [batch, master]) {
      expect(x?.same).toBe(true);
      expect(x?.before.problems).toEqual([]);
      expect(x?.after?.problems).toEqual([]);
      expect(x?.before.events).toBeGreaterThan(0);
    }
    expect(master?.before.signatures).toBeGreaterThanOrEqual(4);
    expect(r.chains.after.problems).toEqual([]);
    expect(r.chains.after.chains).toBeGreaterThanOrEqual(r.chains.before.chains);
    // The release candidate's server retrieves and renders the same record through its archive route.
    const pdf = await renderThroughRoute(upgraded, old, old.batchId ?? '');
    expect(pdf.contentSha256).toBe(batch?.before.contentSha256);
    upgraded = '';
  });

  it('[DI-48] in the migration dry run, counts and hashes match, and spot-checked audit trails, e-signature meaning and date-time, and units are unchanged', () => {
    const r = upgrade.report;
    for (const cat of ['RECORDS', 'AUDIT_TRAIL', 'SIGNATURES', 'SYSTEM']) expect(r.summary[cat]?.changed, cat).toBe(0);
    // No earlier row of any table changed; the signature tables kept exactly their rows.
    expect(r.tables.filter((t) => t.status === 'CHANGED' || t.status === 'DROPPED')).toEqual([]);
    // The signatures themselves are exactly the same rows; the release may add meanings to the signature catalogue.
    const sigRows = r.tables.find((t) => t.table === '"esig"."signature"');
    expect([sigRows?.status, sigRows?.sha256After]).toEqual(['MATCH', sigRows?.sha256Before]);
    for (const t of r.tables.filter((x) => x.category === 'SIGNATURES')) expect(['MATCH', 'ADDED_ONLY'], t.table).toContain(t.status);
    expect(sigRows?.rowsBefore).toBeGreaterThanOrEqual(8);
    for (const kind of ['SIGNATURE', 'AUDIT_EVENT', 'UNIT_VALUE'] as const) {
      const checks = r.spotChecks.filter((s) => s.kind === kind);
      expect(checks.length, kind).toBeGreaterThan(0);
      expect(checks.every((s) => s.same), kind).toBe(true);
    }
  });

  it('[DI-48] a migration that changes an earlier database row fails the dry run, names the table and shows the changed unit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-drill-bad-'));
    mkdirSync(join(dir, 'sql'));
    writeFileSync(join(dir, 'sql', '9999_bad_rewrite.sql'), "-- Handbook: test only\nupdate platform.setting_definition set unit = unit || 'x' where unit is not null;\n");
    const bad = await runUpgradeDrill({
      adminUrl: ADMIN_URL, sourceDatabase: old.database, sources: [...tabletsMigrationSources(), { namespace: 'drill-test', directory: join(dir, 'sql') }],
      fromRelease: manifest.release, reportDir: reports, spotChecks: 24, renderLimit: 2, sampleSeed: UNIT_SEED,
    });
    rmSync(dir, { recursive: true, force: true });
    const changed = bad.report.tables.find((t) => t.table === '"platform"."setting_definition"');
    expect(changed?.status).toBe('CHANGED');
    expect(changed?.missing).toBeGreaterThan(0);
    expect(bad.report.result).toBe('FAIL');
    expect(bad.report.failures.join('\n')).toContain('"platform"."setting_definition"');
    // The spot check of the unit reads the change too.
    expect(bad.report.spotChecks.some((x) => x.kind === 'UNIT_VALUE' && x.table === 'platform.setting_definition' && !x.same)).toBe(true);
    expect(bad.report.copy.dropped).toBe(true);
  });

  it('[DI-48] the same seed gives the same spot-check sample, and the unit-change test\'s seed samples rows of platform.setting_definition that hold a unit', async () => {
    const c = await connect(withDatabase(ADMIN_URL, old.database));
    try {
      const key = (x: { kind: string; table: string; key: string }): string => `${x.kind} ${x.table} ${x.key}`;
      const a = await takeSamples(c, 24, UNIT_SEED);
      const b = await takeSamples(c, 24, UNIT_SEED);
      expect(b.map(key)).toEqual(a.map(key));
      expect(b.map((x) => x.value)).toEqual(a.map((x) => x.value));
      for (const kind of ['SIGNATURE', 'AUDIT_EVENT', 'UNIT_VALUE']) expect(a.some((x) => x.kind === kind), kind).toBe(true);
      // Another seed orders the rows otherwise (the drill's default is a random seed per run).
      const other = await takeSamples(c, 24, `${UNIT_SEED}-other`);
      expect(other.map(key)).not.toEqual(a.map(key));
      // The unit-change test's rewrite changes every row with a unit; this seed samples at least one.
      const units = a.filter((x) => x.kind === 'UNIT_VALUE' && x.table === 'platform.setting_definition');
      expect(units.length).toBeGreaterThan(0);
      expect(units.some((x) => (JSON.parse(x.value) as { unit: string | null }).unit !== null)).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('[DI-48] a migration that drops or renames a database table holding records fails the dry run and names the table (R3-VAL-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-drill-drop-'));
    mkdirSync(join(dir, 'sql'));
    writeFileSync(join(dir, 'sql', '9999_bad_rename.sql'), '-- Handbook: test only\nalter table platform.setting_definition rename to setting_definition_v2;\n');
    const bad = await runUpgradeDrill({
      adminUrl: ADMIN_URL, sourceDatabase: old.database, sources: [...tabletsMigrationSources(), { namespace: 'drill-test', directory: join(dir, 'sql') }],
      fromRelease: manifest.release, reportDir: reports, spotChecks: 4, renderLimit: 1,
    });
    rmSync(dir, { recursive: true, force: true });
    expect(bad.report.tables.find((t) => t.table === '"platform"."setting_definition"')?.status).toBe('DROPPED');
    expect(bad.report.result).toBe('FAIL');
    expect(bad.report.failures.join('\n')).toMatch(/"platform"\."setting_definition".*dropped/);
    // The renamed table's rows sit in a new table, which the report lists for review.
    expect(bad.report.toReview.join('\n')).toContain('"platform"."setting_definition_v2"');
  });

  it('[DI-48] a table the release retires on purpose is listed with its reason, which the report shows; the dry run then passes (R3-VAL-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-drill-retire-'));
    mkdirSync(join(dir, 'sql'));
    writeFileSync(join(dir, 'sql', '9999_retire.sql'), '-- Handbook: test only\nalter table platform.setting_definition rename to setting_definition_v2;\n');
    const reason = 'test only: renamed to setting_definition_v2, its rows kept there';
    const ok = await runUpgradeDrill({
      adminUrl: ADMIN_URL, sourceDatabase: old.database, sources: [...tabletsMigrationSources(), { namespace: 'drill-test', directory: join(dir, 'sql') }],
      fromRelease: manifest.release, reportDir: reports, spotChecks: 4, renderLimit: 1,
      retiredTables: [{ table: '"platform"."setting_definition"', reason }],
    });
    rmSync(dir, { recursive: true, force: true });
    expect(ok.report.failures).toEqual([]);
    expect(ok.report.result).toBe('PASS');
    expect(ok.report.tables.find((t) => t.table === '"platform"."setting_definition"')).toMatchObject({ status: 'DROPPED', reason });
    expect(readFileSync(ok.markdownPath, 'utf8')).toContain(reason);
    expect(ok.report.toReview.join('\n')).toContain('"platform"."setting_definition_v2"');
  });

  it('[DI-48] a migration that adds rows to a table of records (not the release\'s configuration) fails the dry run and names the table (R3-VAL-6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-drill-add-'));
    mkdirSync(join(dir, 'sql'));
    writeFileSync(join(dir, 'sql', '9999_bad_insert.sql'), '-- Handbook: test only\ninsert into iam.authn_attempt (method, purpose, outcome, reason) select method, purpose, outcome, reason from iam.authn_attempt order by id limit 1;\n');
    const bad = await runUpgradeDrill({
      adminUrl: ADMIN_URL, sourceDatabase: old.database, sources: [...tabletsMigrationSources(), { namespace: 'drill-test', directory: join(dir, 'sql') }],
      fromRelease: manifest.release, reportDir: reports, spotChecks: 4, renderLimit: 1,
    });
    rmSync(dir, { recursive: true, force: true });
    expect(bad.report.tables.find((t) => t.table === '"iam"."authn_attempt"')?.status).toBe('ADDED_ONLY');
    expect(bad.report.result).toBe('FAIL');
    expect(bad.report.failures.join('\n')).toMatch(/"iam"\."authn_attempt".*added/);
  });

  it('[DI-48] a dry run without a spot check of signatures, audit events and units has no evidence for them and fails (R3-VAL-5)', async () => {
    const none = await runUpgradeDrill({
      adminUrl: ADMIN_URL, sourceDatabase: old.database, sources: tabletsMigrationSources(), fromRelease: manifest.release, reportDir: reports, spotChecks: 0, renderLimit: 1,
    });
    expect(none.report.result).toBe('FAIL');
    for (const kind of ['SIGNATURE', 'AUDIT_EVENT', 'UNIT_VALUE']) expect(none.report.failures.join('\n')).toContain(`no ${kind} spot check`);
  });
});

describe('restore drill with its record (slice 7d)', () => {
  it('[DI-02][IN-09][DI-45] restore a backup to an isolated test instance: chains and anchors verified, the signed restore event recorded, a batch renders completely; the exported batch restores in an isolated environment', async () => {
    const source = `ebmr_drillrs_${uniqueSuffix()}`;
    const { copyDatabase } = await import('../src/db.ts');
    await copyDatabase(ADMIN_URL, old.database, source);
    try {
      // The upgraded copy was handed to the archive server above and dropped with it; restore the release candidate's state.
      const { migrate } = await import('@ebmr/kernel');
      const pg = (await import('pg')).default;
      const c = new pg.Client({ connectionString: urlFor(source) });
      await c.connect();
      await migrate(c, tabletsMigrationSources());
      await c.end();
      let routed: string | null = null;
      const out = await runRecordedRestoreDrill({
        sourceUrl: urlFor(source),
        adminUrl: ADMIN_URL,
        reportDir: reports,
        purpose: 'validation (slice 7d test)',
        restoreEvent: { seed: old.seed, sealKey: old.sealKey, ledgerFile: old.ledgerFile, changeReference: 'DRILL-TEST-7D' },
        exportChain: `batch:${old.batchId ?? ''}`,
        inspectRestored: async (database) => {
          routed = (await renderThroughRoute(database, old, old.batchId ?? '')).contentSha256;
        },
      });
      const r = out.report;
      expect(r.failures).toEqual([]);
      expect(r.result).toBe('PASS');
      expect(r.kernel.result).toBe('PASS');
      expect(r.kernel.restore?.isolated).toBe(true);
      expect(r.kernel.verification.restored?.chainProblems).toEqual([]);
      expect(r.kernel.verification.restored?.anchorProblems).toEqual([]);
      // The signed restore event: recorded by the administrator, approved by QA's own signature.
      expect(r.restoreEvent?.status).toBe('APPROVED');
      expect(r.restoreEvent?.signatureId).toMatch(/^[0-9a-f-]{36}$/);
      // The batch renders completely from the restored copy, the same true copy as the source's, also through the route.
      const batch = r.renders.find((x) => x.chainKey === `batch:${old.batchId ?? ''}`);
      expect(batch?.same).toBe(true);
      expect(batch?.restored?.problems).toEqual([]);
      expect(routed).toBe(batch?.source.contentSha256);
      // The export, restored in a process that has nothing of the installation, gives the same record.
      expect(r.exportRoundTrip?.same).toBe(true);
      expect(r.exportRoundTrip?.isolated.environment).toEqual([]);
      expect(r.exportRoundTrip?.isolated.events).toBe(batch?.source.events);
      expect(r.measured.restoreTimeMs).toBeGreaterThan(0);
    } finally {
      await dropDatabase(source);
    }
  });
});
