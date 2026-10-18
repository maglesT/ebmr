/**
 * tools/validation against a real database migrated to the release (Phase 7 slice 7c): the evidence bundle from it and
 * a run's report, every document of the pack generated from that bundle (twice, the same bytes), the IQ script on the
 * correct installation (every check passes) and on one with a dropped trigger, a revoked privilege and a DEMO-ONLY key
 * (each fails, by name), and the OQ record of a run's reports.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAdmin, createGmpDatabase, dropDatabase, editionMigrationSources, uniqueSuffix, urlFor } from '@ebmr/test-kit';
import { canonicalJson, generatePack, PACK_ARTEFACTS, type Bundle } from '@ebmr/validation-kit';
import { buildBundle } from '../src/bundle.ts';
import { runIq } from '../src/iq.ts';
import { oqRecord } from '../src/oq.ts';
import { cycloneDx } from '../src/sbom.ts';
import { ROOT, schemaReleaseOfFiles } from '../src/sources.ts';

const LONG = 600_000;
const TABLETS_SQL = new URL('../../../apps/tablets-server/sql', import.meta.url).pathname;
const name = `ebmr_val_${uniqueSuffix()}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-validation-'));
const host = { cpu: 'test cpu', memory: '1 GiB', os: 'test os', node: 'v22', postgres: '16' };
const commit = { commit: 'c'.repeat(40), commitTime: '2026-10-18T00:00:00Z' };
let client: pg.Client;
let bundle: Bundle;
let locked: Record<string, string>;

/** A run's Vitest report (the shape `pnpm test:json` writes). */
function writeReport(file: string, statuses: Record<string, string>): void {
  writeFileSync(file, JSON.stringify({
    startTime: Date.UTC(2026, 9, 18, 1, 0, 0),
    testResults: [{
      name: join(ROOT, 'packages/kernel/test/config/release-identity.test.ts'),
      startTime: Date.UTC(2026, 9, 18, 1, 0, 0),
      endTime: Date.UTC(2026, 9, 18, 1, 0, 9),
      assertionResults: Object.entries(statuses).map(([title, status]) => ({ ancestorTitles: ['the release identity (kernel 1300)'], title, fullName: title, status, duration: 12.5 })),
    }],
  }));
}

const fakeMeta = (b: Bundle) => () =>
  Promise.resolve({ status: 200, json: () => Promise.resolve<unknown>({ installation: 'GMP', edition: 'tablets', version: b.release.version, demo: false, publicOrigin: 'https://ebmr.plant.example' }) });

beforeAll(async () => {
  await createGmpDatabase(name, editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]));
  client = new pg.Client({ connectionString: urlFor(name), options: '-c default_transaction_read_only=on' });
  await client.connect();
  const s = await client.query<{ name: string; setting: string }>("select name, setting from pg_settings where name in ('password_encryption', 'ssl')");
  // The test cluster's own TLS and password settings stand in for the release's (a production cluster has TLS on).
  locked = Object.fromEntries(s.rows.map((r) => [r.name, r.setting]));
  writeReport(join(dir, 'vitest.json'), {
    '[DI-03] the schema release is the SHA-256 of the migration ledger in namespace and name order, the same as computed from the files': 'passed',
    '[DI-03] the ledger is not writable by the application role, so the release cannot be faked from a session': 'passed',
  });
  writeFileSync(join(dir, 'sbom.cdx.json'), `${canonicalJson(cycloneDx('1.0.0-rc.1'))}\n`);
  bundle = await buildBundle({ resultsDir: dir, db: client, sbomFile: relative(ROOT, join(dir, 'sbom.cdx.json')), commit, host, lockedSettings: locked, version: '1.0.0-rc.1' });
}, LONG);

afterAll(async () => {
  await client?.end();
  await dropDatabase(name);
  rmSync(dir, { recursive: true, force: true });
});

describe('the evidence bundle of a migrated database (tools/validation)', () => {
  it('[IN-12] a real bundle of a migrated database gives every document of the validation package, the same bytes each time', () => {
    expect(bundle.release).toEqual({ product: 'Batchwright Tablets', maker: 'Medhanta', version: '1.0.0-rc.1', ...commit, schemaRelease: schemaReleaseOfFiles() });
    expect(bundle.register.controls.length).toBe(246);
    expect(bundle.inventory.migrations.length).toBeGreaterThan(300);
    // The inventory sees the interlocks of this slice in the database.
    expect(bundle.inventory.triggers).toContainEqual({ table: 'recipe.batch_execution', name: 'a0_validation_summary_gate', enabled: true, function: 'recipe.batch_execution_validation_gate' });
    expect(bundle.inventory.functions.find((f) => f.schema === 'platform' && f.name === 'check_adapter_start')).toMatchObject({ securityDefiner: true, executeRoles: expect.arrayContaining(['ebmr_app']) as unknown });
    expect(bundle.inventory.messages.find((m) => m.code === 'EBMR-VAL-001')?.sourceFile).toMatch(/^packages\/kernel\//);
    expect(bundle.inventory.routes.some((r) => r.namespace === 'integrations' && r.route === '/api/integrations/alarms')).toBe(true);
    expect(bundle.inventory.stateCharts.length).toBeGreaterThan(0);
    expect(bundle.analytics.methods.length).toBeGreaterThan(0);
    expect(bundle.analytics.methods.every((m) => !m.changesGmpData)).toBe(true);
    // The run's results, named as the register lists them, with their controls.
    expect(bundle.runs).toHaveLength(1);
    expect(bundle.results.map((r) => [r.status, r.controls])).toEqual([['passed', ['DI-03']], ['passed', ['DI-03']]]);
    expect(bundle.results[0]?.test).toMatch(/^packages\/kernel\/test\/config\/release-identity\.test\.ts > the release identity \(kernel 1300\) > \[DI-03\]/);
    const a = generatePack(bundle);
    const b = generatePack(JSON.parse(canonicalJson(bundle)));
    expect(b.files).toEqual(a.files);
    expect(a.manifest.documents.map((d) => d.id)).toEqual([...PACK_ARTEFACTS]);
    const ds = a.files.find((f) => f.path === 'design-spec.md')?.content ?? '';
    expect(ds).toContain('| recipe.batch_execution | a0_validation_summary_gate | yes | recipe.batch_execution_validation_gate |');
  }, LONG);

  it('[DI-03] the IQ script passes every check on a correct installation and fails a dropped trigger, a revoked privilege and a DEMO-ONLY key by name', async () => {
    const good = await runIq({ db: client, bundle, server: 'https://ebmr.plant.example', host, fetchFn: fakeMeta(bundle) });
    expect(good.checks.filter((c) => !c.passed).map((c) => [c.id, c.problems])).toEqual([]);
    expect(good).toMatchObject({ kind: 'iq', passed: true, summary: 'all 11 IQ checks passed' });
    expect(good.checks.find((c) => c.id === 'IQ-01')?.actual).toBe(bundle.release.schemaRelease);
    // Without a server, the server's checks are not made, and say so.
    const noServer = await runIq({ db: client, bundle, server: null, host });
    expect(noServer.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['IQ-03']);

    await asAdmin(name, async (c) => {
      await c.query('drop trigger a0_validation_summary_gate on recipe.batch_execution');
      await c.query('revoke select on platform.validation_summary from ebmr_app');
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object(
        'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
        'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'IQ test', 'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'IQ test: a demo key'))`);
      await c.query("insert into esig.seal_key (key_id, algorithm, description, registered_by_person, registered_by_account) values ('iq-test-key', 'HMAC-SHA256', 'DEMO-ONLY seal key', gen_random_uuid(), gen_random_uuid())");
      await c.query('commit');
    });
    const bad = await runIq({ db: client, bundle, server: 'https://ebmr.plant.example', host, fetchFn: fakeMeta(bundle) });
    const failed = Object.fromEntries(bad.checks.filter((c) => !c.passed).map((c) => [c.id, c.problems]));
    expect(Object.keys(failed)).toEqual(['IQ-04', 'IQ-06', 'IQ-09']);
    expect(failed['IQ-04']).toEqual(['trigger recipe.batch_execution.a0_validation_summary_gate is missing']);
    expect(failed['IQ-06']).toEqual(['privilege ebmr_app SELECT on platform.validation_summary is missing']);
    expect(failed['IQ-09']).toEqual(['DEMO-ONLY seal key iq-test-key is registered and not retired']);
    expect(bad.passed).toBe(false);
    expect(bad.summary).toBe('3 of 11 IQ checks failed: IQ-04 triggers, IQ-06 privileges, IQ-09 locked settings');
    // A server reached over plain HTTP off loopback fails the locked settings too.
    const http = await runIq({ db: client, bundle, server: 'http://ebmr.plant.example', host, fetchFn: fakeMeta(bundle) });
    expect(http.checks.find((c) => c.id === 'IQ-09')?.problems).toContain('the server is reached over plain HTTP off loopback (http://ebmr.plant.example)');
  }, LONG);

  it('[meta] the OQ record lists every test of the run with its controls and result', () => {
    const r = oqRecord(dir, commit.commit, host, 'https://ebmr.plant.example');
    expect(r).toMatchObject({ kind: 'oq', passed: true, summary: '2 tests in 1 runs: 2 passed, 0 failed, 0 skipped' });
    expect(r.tests.map((t) => [t.controls, t.status])).toEqual([[['DI-03'], 'passed'], [['DI-03'], 'passed']]);
    expect(oqRecord(join(dir, 'none'), commit.commit, host, null)).toMatchObject({ passed: false, summary: 'no suite report was found: nothing was run' });
  });
});
