/**
 * Upgrade drill and migration dry run (slice 7d; DI-46 clause 2, DI-48 clause 1, D-P7-8).
 *
 * On a copy of a database at an earlier release (the source is never touched), before and after the release
 * candidate's migrations:
 *  - every table's rows, over the columns it had before the upgrade, as a multiset of row hashes (MD5 of the row's text
 *    form in the comparison settings): MATCH (the same rows), ADDED_ONLY (every earlier row still there, unchanged, and
 *    rows added: the release's own configuration, the DDL log of its migrations, the migration ledger), ADVANCED (only
 *    for the audit chain heads: a head moved on along its own chain, the event it named still there with its hash) or
 *    CHANGED (an earlier row changed or went); a table's SHA-256 is over its sorted row hashes;
 *  - every audit chain and external anchor verified;
 *  - the records rendered (records.renderTrueCopyPdf of each chain, render.ts): the content hash of each true copy
 *    before and after must be equal, and each must be complete;
 *  - spot checks (DI-48): sampled signatures (meaning, its text, signer, the recorded instant in UTC, the signed
 *    content hash), sampled audit events (chain, sequence, hash, instant, action) and sampled rows of the tables that
 *    hold a unit (every column, the unit with its value) read again by key after the upgrade.
 * PASS only when no earlier row of any table changed (no CHANGED table), no signature was added (esig.signature; the
 * release may add meanings and content providers to the catalogue), no chain or anchor
 * problem is found after, every rendering matches and is complete, and every spot check reads the same.
 *
 * The comparison keeps its row hashes in schema drill_snapshot of the copy, made before the "before" reading (its DDL
 * is in the DDL log the reading sees) and dropped with the copy.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config, migrate, type MigrationSource } from '@ebmr/kernel';
import { columnsOf, connect, copyDatabase, databaseSize, dropDatabase, elapsedMs, listTables, quoteIdent, verifyChains, withDatabase, type ChainCheck, type TableRef } from './db.ts';
import { recordsToRender, renderRecord, type RenderedRecord } from './render.ts';

export interface UpgradeDrillOptions {
  /** Superuser connection (any database of the cluster). */
  adminUrl: string;
  /** The database at the earlier release; it is copied, never changed. */
  sourceDatabase: string;
  /** The release candidate's migrations, in order. */
  sources: MigrationSource[];
  /** What the earlier release is (shown in the record). */
  fromRelease: string;
  reportDir: string;
  /** Records rendered before and after (default 10). */
  renderLimit?: number;
  /** Rows sampled per spot check (default 20). */
  spotChecks?: number;
  keepCopy?: boolean;
  /**
   * Phase B slice 6: a source with no record to render, and so no signature or unit row to sample, passes (the platform
   * move of a site that has none yet). Every sampled row is still compared.
   */
  allowNoRecords?: boolean;
  /** Name of the copy (default <source>_upg_<hex>). */
  workDatabase?: string;
  /**
   * Tables the release retires on purpose (DI-48): a table present before and absent after fails the dry run unless it
   * is listed here with the reason, which the report shows. Names as the report gives them ("schema"."table").
   */
  retiredTables?: readonly { table: string; reason: string }[];
}

export const SPOT_CHECK_KINDS = ['SIGNATURE', 'AUDIT_EVENT', 'UNIT_VALUE'] as const;

export type TableStatus = 'MATCH' | 'ADDED_ONLY' | 'ADVANCED' | 'CHANGED' | 'NEW' | 'DROPPED';

/** The tables whose rows are signatures (the rest of esig is its catalogue: meanings, content providers, keys). */
export const SIGNATURE_RECORDS: readonly string[] = ['"esig"."signature"'];

/**
 * The tables a release's migrations may add rows to (DI-48), each with the reason. Every other table outside the SYSTEM
 * category (public.schema_migration, the migration ledger) holds records or execution data, so an upgrade that adds
 * rows to it fails the dry run: a migration must not write records. A new table of a release that holds its own
 * catalogue is added here, with its reason, when a later release's drill first sees it ADDED_ONLY.
 */
export const ADDED_ONLY_ALLOWED: Readonly<Record<string, string>> = {
  '"esig"."content_provider"': 'catalogue of the content providers a signature can cover: a release registers its new ones',
  '"esig"."meaning_type"': 'catalogue of signature meanings: a release adds the meanings of its new acts (the signatures themselves, esig.signature, may not grow)',
  '"iam"."permission"': 'catalogue of permissions: a release adds the permissions of its new commands',
  '"iam"."role_permission"': "the release's grants of its new permissions to the standard roles (configuration, not a person's record)",
  '"kernel"."audit_event"': 'the audit events of the configuration rows the migrations add; the chains are verified after the upgrade and every earlier event must be unchanged',
  '"kernel"."audited_table"': 'registry of the tables the audit trail covers: a release registers its new tables',
  '"kernel"."ddl_log"': 'the DDL log of the release\'s own migrations',
  '"platform"."config_area"': 'catalogue of configuration areas',
  '"platform"."config_version"': 'configuration versions with basis RELEASE, recorded for the catalogue rows the migrations add',
  '"platform"."db_time_column"': 'registry of the columns that take database time: a release registers its new columns',
  '"platform"."inbound_schema"': 'the inbound message schemas the eBMR accepts (insert-only; a release adds its own)',
  '"platform"."setting_definition"': 'catalogue of setting definitions: a release defines its new settings (earlier definitions must be unchanged)',
  '"recipe"."block_data_schema"': 'catalogue of block data schemas',
  '"recipe"."block_signature_meaning"': 'catalogue of the signature meanings each block type uses',
  // API plan A1a (editions/substance/sql 5000): an edition's packaging completion block and its G-REL hook.
  '"recipe"."grel_edition_hook"': 'registry of the G-REL item function of each edition (owner only, insert-only): a release registers a new edition\'s hook',
  '"recipe"."packaging_completion_block"': 'catalogue of the block types that complete a packaging record, per edition (insert-only): a release adds a new edition\'s',
  '"recipe"."engine_name"': "the names the engine's registers give (rule codes, block types, controls, schema tags): a release registers its new ones",
  '"report"."view_registry"': 'registry of the report views (insert-only; a release adds its new views)',
};

export interface TableResult {
  table: string;
  category: string;
  status: TableStatus;
  rowsBefore: number;
  rowsAfter: number;
  /** Earlier rows not found unchanged after the upgrade. */
  missing: number;
  sha256Before: string | null;
  sha256After: string | null;
  columnsAdded: string[];
  /** Why the status is accepted: a retired table's reason (retiredTables). */
  reason?: string;
}

export interface SpotCheck {
  kind: (typeof SPOT_CHECK_KINDS)[number];
  table: string;
  key: string;
  shown: string;
  same: boolean;
  /** The reason of the retired table the sample lies in (it is not read again). */
  retired?: string;
}

export interface UpgradeReport {
  kind: 'ebmr.upgrade-drill';
  version: 1;
  drillId: string;
  result: 'PASS' | 'FAIL';
  failures: string[];
  /** What a person reviews although it does not fail the run: each NEW table that holds rows (a renamed table's rows land in one). */
  toReview: string[];
  fromRelease: string;
  source: { database: string; sizeBytes: number; serverVersion: string; schemaReleaseBefore: string | null; schemaReleaseAfter: string | null; migrationsBefore: number };
  copy: { database: string; dropped: boolean };
  migrations: { applied: { namespace: string; name: string }[]; durationMs: number };
  durationMs: number;
  chains: { before: ChainCheck; after: ChainCheck };
  tables: TableResult[];
  renders: { chainKey: string; before: RenderedRecord; after: RenderedRecord | null; same: boolean }[];
  spotChecks: SpotCheck[];
  summary: Record<string, { tables: number; match: number; addedOnly: number; changed: number; rowsBefore: number; rowsAfter: number }>;
}

export interface UpgradeOutcome {
  report: UpgradeReport;
  jsonPath: string;
  markdownPath: string;
  reportSha256: string;
}

const SNAPSHOT = 'drill_snapshot';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const rowHash = (cols: string[], alias = 't') => `md5(row(${cols.map((c) => `${alias}.${quoteIdent(c)}`).join(', ')})::text)`;

async function sortedHash(c: pg.Client, sql: string, params: unknown[]): Promise<{ sha: string; n: number }> {
  const h = createHash('sha256');
  let n = 0;
  await c.query('begin');
  try {
    await c.query(`declare drill_cur no scroll cursor for ${sql}`, params);
    for (;;) {
      const batch = await c.query<{ h: string }>('fetch forward 10000 from drill_cur');
      if (batch.rows.length === 0) break;
      for (const r of batch.rows) h.update(`${r.h}\n`);
      n += batch.rows.length;
    }
    await c.query('close drill_cur');
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  }
  return { sha: h.digest('hex'), n };
}

/**
 * How many earlier chain-head rows moved forward: the event an earlier head named (chain, sequence, hash) is still in
 * kernel.audit_event and the chain's head now has a higher sequence.
 */
async function movedHeadsExplained(c: pg.Client, cols: string[]): Promise<number> {
  if (!['chain_key', 'last_seq', 'last_hash'].every((x) => cols.includes(x))) return 0;
  const { rows } = await c.query<{ n: string }>(
    `select count(*)::text as n from ${SNAPSHOT}.chain_head_before b
       join kernel.audit_chain_head h on h.chain_key = b.chain_key and h.last_seq > b.last_seq
       join kernel.audit_event e on e.chain_key = b.chain_key and e.seq = b.last_seq and e.hash = b.last_hash`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function schemaRelease(c: pg.Client): Promise<string | null> {
  const ok = await c.query<{ ok: boolean }>("select to_regprocedure('platform.schema_release()') is not null as ok");
  if (!ok.rows[0]?.ok) {
    // Before platform.schema_release() (kernel 1300) the release is the same hash computed here (interfaces section 4).
    const { rows } = await c.query<{ namespace: string; name: string; checksum: string }>('select namespace, name, checksum from public.schema_migration');
    return config.releaseOfLedger(rows);
  }
  return (await c.query<{ r: string }>('select platform.schema_release() as r')).rows[0]?.r ?? null;
}

interface Sample {
  kind: SpotCheck['kind'];
  table: string;
  /** The table as the report's table list names it ("schema"."table"). */
  ref: string;
  key: string;
  sql: string;
  params: unknown[];
  value: string;
  shown: string;
}

/** Deterministic samples: ordered by the MD5 of the key and the drill's seed. */
async function takeSamples(c: pg.Client, n: number, seed: string): Promise<Sample[]> {
  const out: Sample[] = [];
  const sig = await c.query<{ id: string; v: string; shown: string }>(
    `select s.id::text as id,
            jsonb_build_object('meaning', s.meaning_code, 'meaningText', s.meaning_text, 'signer', s.signer_legal_name, 'role', s.signer_role_code,
                               'recordedAtUtc', to_char(s.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'zone', s.site_zone,
                               'contentHash', s.content_hash, 'aggregate', s.aggregate_type || ':' || s.aggregate_id)::text as v,
            s.meaning_code || ' by ' || s.signer_legal_name || ' at ' || to_char(s.recorded_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"Z"') as shown
       from esig.signature s order by md5(s.id::text || $2) limit $1`,
    [n, seed],
  );
  for (const r of sig.rows) {
    out.push({ kind: 'SIGNATURE', table: 'esig.signature', ref: '"esig"."signature"', key: r.id, value: r.v, shown: r.shown, params: [r.id], sql: `select jsonb_build_object('meaning', s.meaning_code, 'meaningText', s.meaning_text, 'signer', s.signer_legal_name, 'role', s.signer_role_code,
                               'recordedAtUtc', to_char(s.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'zone', s.site_zone,
                               'contentHash', s.content_hash, 'aggregate', s.aggregate_type || ':' || s.aggregate_id)::text as v from esig.signature s where s.id = $1::uuid` });
  }
  const ev = await c.query<{ id: string; v: string; shown: string }>(
    `select e.id::text as id, jsonb_build_object('chain', e.chain_key, 'seq', e.seq, 'hash', encode(e.hash, 'hex'), 'prev', encode(e.prev_hash, 'hex'),
                               'recordedAtUtc', to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'action', e.action,
                               'payload', md5(e.payload::text))::text as v,
            e.chain_key || ' #' || e.seq || ' ' || e.action || ' ' || coalesce(e.table_name, '') as shown
       from kernel.audit_event e order by md5(e.id::text || $2) limit $1`,
    [n, seed],
  );
  for (const r of ev.rows) {
    out.push({ kind: 'AUDIT_EVENT', table: 'kernel.audit_event', ref: '"kernel"."audit_event"', key: r.id, value: r.v, shown: r.shown, params: [r.id], sql: `select jsonb_build_object('chain', e.chain_key, 'seq', e.seq, 'hash', encode(e.hash, 'hex'), 'prev', encode(e.prev_hash, 'hex'),
                               'recordedAtUtc', to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'action', e.action,
                               'payload', md5(e.payload::text))::text as v from kernel.audit_event e where e.id = $1::bigint` });
  }
  // Tables holding a unit, with a single-column primary key: sampled rows, every column as text.
  const unitTables = await c.query<{ qualified: string; pk: string; schema: string; rel: string; units: string[] }>(
    `select format('%I.%I', n.nspname, c.relname) as qualified, pa.attname as pk, n.nspname as schema, c.relname as rel,
            array_agg(a.attname::text order by a.attnum) as units
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_index i on i.indrelid = c.oid and i.indisprimary and i.indnkeyatts = 1
       join pg_attribute pa on pa.attrelid = c.oid and pa.attnum = i.indkey[0]
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and (a.attname = 'unit' or a.attname like '%\\_unit')
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', '${SNAPSHOT}')
      group by 1, 2, 3, 4 order by 1`,
  );
  for (const t of unitTables.rows) {
    const cols = (await c.query<{ name: string }>(`select a.attname as name from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [t.qualified])).rows.map((r) => r.name);
    const rowText = `jsonb_build_object(${cols.map((col) => `'${col.replace(/'/g, "''")}', x.${quoteIdent(col)}::text`).join(', ')})::text`;
    const shownText = t.units.map((u) => `x.${quoteIdent(u)}::text`).join(` || ' ' || `);
    const rows = await c.query<{ k: string; v: string; shown: string | null }>(
      `select x.${quoteIdent(t.pk)}::text as k, ${rowText} as v, ${shownText} as shown from ${t.qualified} x order by md5(x.${quoteIdent(t.pk)}::text || $2) limit $1`,
      [n === 0 ? 0 : Math.max(1, Math.ceil(n / 4)), seed],
    );
    for (const r of rows.rows) {
      out.push({ kind: 'UNIT_VALUE', table: t.qualified, ref: `${quoteIdent(t.schema)}.${quoteIdent(t.rel)}`, key: r.k, value: r.v, shown: r.shown ?? '', params: [r.k], sql: `select ${rowText} as v from ${t.qualified} x where x.${quoteIdent(t.pk)}::text = $1` });
    }
  }
  return out;
}

function summarise(tables: TableResult[]): UpgradeReport['summary'] {
  const s: UpgradeReport['summary'] = {};
  for (const t of tables) {
    const x = (s[t.category] ??= { tables: 0, match: 0, addedOnly: 0, changed: 0, rowsBefore: 0, rowsAfter: 0 });
    x.tables += 1;
    if (t.status === 'MATCH') x.match += 1;
    if (t.status === 'ADDED_ONLY' || t.status === 'ADVANCED') x.addedOnly += 1;
    if (t.status === 'CHANGED' || t.status === 'DROPPED') x.changed += 1;
    x.rowsBefore += t.rowsBefore;
    x.rowsAfter += t.rowsAfter;
  }
  return s;
}

export async function runUpgradeDrill(o: UpgradeDrillOptions): Promise<UpgradeOutcome> {
  const started = process.hrtime.bigint();
  const work = o.workDatabase ?? `${o.sourceDatabase.slice(0, 40)}_upg_${randomBytes(4).toString('hex')}`;
  const seed = randomBytes(4).toString('hex');
  const spot = o.spotChecks ?? 20;
  const failures: string[] = [];
  await copyDatabase(o.adminUrl, o.sourceDatabase, work);
  const url = withDatabase(o.adminUrl, work);
  let dropped = false;
  try {
    // Before.
    let c = await connect(url);
    const stamp = (await c.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') as t`)).rows[0]?.t ?? '';
    const drillId = `upgrade-${stamp}-${randomBytes(3).toString('hex')}`;
    const serverVersion = (await c.query<{ v: string }>("select current_setting('server_version') as v")).rows[0]?.v ?? '';
    const sizeBytes = await databaseSize(c);
    const releaseBefore = await schemaRelease(c);
    const migrationsBefore = Number((await c.query<{ n: string }>('select count(*)::text as n from public.schema_migration')).rows[0]?.n ?? 0);
    await c.query(`create schema ${SNAPSHOT}`);
    await c.query(`create table ${SNAPSHOT}.row_hash (tbl text not null, h text not null)`);
    await c.query(`create table ${SNAPSHOT}.table_columns (tbl text primary key, cols text[] not null, n bigint not null, sha text not null)`);
    await c.query(`create table ${SNAPSHOT}.chain_head_before as select chain_key, last_seq, last_hash from kernel.audit_chain_head`);
    const tables = await listTables(c, [SNAPSHOT]);
    const before = new Map<string, { t: TableRef; cols: string[]; n: number; sha: string }>();
    for (const t of tables) {
      const cols = await columnsOf(c, t);
      await c.query(`insert into ${SNAPSHOT}.row_hash (tbl, h) select $1, ${rowHash(cols)} from ${t.qualified} t`, [t.qualified]);
      const { sha, n } = await sortedHash(c, `select h from ${SNAPSHOT}.row_hash where tbl = $1 order by h collate "C"`, [t.qualified]);
      before.set(t.qualified, { t, cols, n, sha });
    }
    const chainsBefore = await verifyChains(c);
    const samples = await takeSamples(c, spot, seed);
    // Each kind of spot check is evidence DI-48 asks for: a dry run without one has no evidence for it and fails.
    for (const kind of SPOT_CHECK_KINDS) {
      // allowNoRecords: a site with no record yet has no signature or unit row to sample (its audit events it has).
      if (o.allowNoRecords === true && kind !== 'AUDIT_EVENT') continue;
      if (!samples.some((x) => x.kind === kind)) failures.push(`no ${kind} spot check: the dry run sampled no ${kind === 'SIGNATURE' ? 'signature' : kind === 'AUDIT_EVENT' ? 'audit event' : 'row of a table holding a unit'} (spotChecks ${String(spot)}), so it has no evidence that they read the same after the upgrade`);
    }
    const keys = await recordsToRender(c, o.renderLimit ?? 16);
    const rendersBefore = new Map<string, RenderedRecord>();
    for (const k of keys) rendersBefore.set(k, await renderRecord(c, k));
    await c.end();

    // The upgrade: the release candidate's migrations, as the migration runner applies them at an installation.
    const m0 = process.hrtime.bigint();
    const mc = new pg.Client({ connectionString: url });
    await mc.connect();
    let applied: { namespace: string; name: string }[] = [];
    try {
      applied = (await migrate(mc, o.sources)).map((a) => ({ namespace: a.namespace, name: a.name }));
    } catch (error) {
      failures.push(`the upgrade failed: ${(error as Error).message}`);
    } finally {
      await mc.end();
    }
    const migrationMs = elapsedMs(m0);

    // After.
    c = await connect(url);
    const releaseAfter = await schemaRelease(c);
    const after = await listTables(c, [SNAPSHOT]);
    const results: TableResult[] = [];
    for (const [q, b] of before) {
      if (!after.some((t) => t.qualified === q)) {
        // A table that went (dropped, or renamed: its rows then sit in a NEW table) takes its earlier rows with it: the
        // dry run fails unless the release retires it on purpose, with the reason in the report.
        const retired = o.retiredTables?.find((x) => x.table === q);
        results.push({ table: q, category: b.t.category, status: 'DROPPED', rowsBefore: b.n, rowsAfter: 0, missing: b.n, sha256Before: b.sha, sha256After: null, columnsAdded: [], ...(retired ? { reason: retired.reason } : {}) });
        if (!retired) failures.push(`${q}: the table was dropped or renamed by the upgrade, with its ${String(b.n)} earlier row(s); a table the release retires on purpose is listed in retiredTables with the reason`);
        continue;
      }
      const colsAfter = await columnsOf(c, b.t);
      const lost = b.cols.filter((x) => !colsAfter.includes(x));
      if (lost.length > 0) {
        results.push({ table: q, category: b.t.category, status: 'CHANGED', rowsBefore: b.n, rowsAfter: -1, missing: b.n, sha256Before: b.sha, sha256After: null, columnsAdded: [] });
        failures.push(`${q}: columns ${lost.join(', ')} were dropped`);
        continue;
      }
      const missing = Number((await c.query<{ n: string }>(
        `select count(*)::text as n from (select h from ${SNAPSHOT}.row_hash where tbl = $1 except all select ${rowHash(b.cols)} from ${q} t) m`, [q])).rows[0]?.n ?? 0);
      const { sha, n } = await sortedHash(c, `select x.h from (select ${rowHash(b.cols)} as h from ${q} t) x order by x.h collate "C"`, []);
      // The chain heads move when a migration appends to a chain: a head is explained when the event it named is still
      // there with the same hash (the chains are verified after the upgrade as well).
      const explained = q === '"kernel"."audit_chain_head"' && missing > 0 ? await movedHeadsExplained(c, b.cols) : 0;
      const status: TableStatus = missing > explained ? 'CHANGED' : missing > 0 ? 'ADVANCED' : n === b.n ? 'MATCH' : 'ADDED_ONLY';
      results.push({ table: q, category: b.t.category, status, rowsBefore: b.n, rowsAfter: n, missing, sha256Before: b.sha, sha256After: sha, columnsAdded: colsAfter.filter((x) => !b.cols.includes(x)) });
      if (status === 'MATCH' && sha !== b.sha) failures.push(`${q}: same rows but another hash`);
      if (status === 'CHANGED') failures.push(`${q}: ${String(missing)} earlier row(s) changed or removed by the upgrade`);
      if (status === 'ADDED_ONLY' && SIGNATURE_RECORDS.includes(q)) failures.push(`${q}: the upgrade added ${String(n - b.n)} signature(s)`);
      else if (status === 'ADDED_ONLY' && b.t.category !== 'SYSTEM' && ADDED_ONLY_ALLOWED[q] === undefined) {
        failures.push(`${q}: the upgrade added ${String(n - b.n)} row(s) to a table of ${b.t.category === 'RECORDS' ? 'records' : b.t.category.toLowerCase().replace('_', ' ')}; only the tables of ADDED_ONLY_ALLOWED (the release's catalogues, registries and ledgers) may grow`);
      }
    }
    for (const t of after) {
      if (before.has(t.qualified)) continue;
      const n = Number((await c.query<{ n: string }>(`select count(*)::text as n from ${t.qualified}`)).rows[0]?.n ?? 0);
      results.push({ table: t.qualified, category: t.category, status: 'NEW', rowsBefore: 0, rowsAfter: n, missing: 0, sha256Before: null, sha256After: null, columnsAdded: [] });
    }
    const chainsAfter = await verifyChains(c);
    for (const p of chainsAfter.problems) failures.push(`after the upgrade: ${p}`);
    const spotChecks: SpotCheck[] = [];
    for (const s of samples) {
      // A sample of a table the release retires (retiredTables) is shown with the reason; it is not read again.
      const retired = o.retiredTables?.find((x) => x.table === s.ref);
      if (retired) {
        spotChecks.push({ kind: s.kind, table: s.table, key: s.key, shown: s.shown, same: false, retired: retired.reason });
        continue;
      }
      let v: string | undefined;
      let unreadable: string | undefined;
      try {
        v = (await c.query<{ v: string }>(s.sql, s.params)).rows[0]?.v;
      } catch (error) {
        unreadable = (error as Error).message;
      }
      const same = unreadable === undefined && v === s.value;
      spotChecks.push({ kind: s.kind, table: s.table, key: s.key, shown: s.shown, same });
      const what = `spot check ${s.kind} ${s.table} ${s.key}`;
      if (unreadable !== undefined) failures.push(`${what} could not be read after the upgrade: ${unreadable}`);
      else if (v === undefined) failures.push(`${what} is gone after the upgrade`);
      else if (!same) failures.push(`${what} reads differently after the upgrade`);
    }
    // Each kind of spot check is evidence DI-48 asks for: a dry run without one read again has no evidence for it.
    for (const kind of SPOT_CHECK_KINDS) {
      if (samples.some((x) => x.kind === kind) && !spotChecks.some((x) => x.kind === kind && x.retired === undefined)) {
        failures.push(`no ${kind} spot check: every sample of it lies in a retired table, so the dry run has no evidence that they read the same after the upgrade`);
      }
    }
    const renders: UpgradeReport['renders'] = [];
    for (const [k, b] of rendersBefore) {
      let a: RenderedRecord | null = null;
      try {
        a = await renderRecord(c, k);
      } catch (error) {
        failures.push(`${k} could not be rendered after the upgrade: ${(error as Error).message}`);
      }
      const same = a !== null && a.contentSha256 === b.contentSha256;
      renders.push({ chainKey: k, before: b, after: a, same });
      if (a && !same) failures.push(`${k}: the true copy's content differs after the upgrade`);
      for (const p of [...b.problems, ...(a?.problems ?? [])]) failures.push(`${k}: ${p}`);
    }
    if (keys.length === 0 && o.allowNoRecords !== true) failures.push('the source holds no record to render');
    await c.end();

    const report: UpgradeReport = {
      kind: 'ebmr.upgrade-drill',
      version: 1,
      drillId,
      result: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
      toReview: results.filter((t) => t.status === 'NEW' && t.rowsAfter > 0).map((t) => `${t.table}: a new table holding ${String(t.rowsAfter)} row(s) after the upgrade (not compared: check that they are the release's own and not an earlier table's rows moved)`),
      fromRelease: o.fromRelease,
      source: { database: o.sourceDatabase, sizeBytes, serverVersion, schemaReleaseBefore: releaseBefore, schemaReleaseAfter: releaseAfter, migrationsBefore },
      copy: { database: work, dropped: !o.keepCopy },
      migrations: { applied, durationMs: migrationMs },
      durationMs: elapsedMs(started),
      chains: { before: chainsBefore, after: chainsAfter },
      tables: results,
      renders,
      spotChecks,
      summary: summarise(results),
    };
    if (!o.keepCopy) {
      await dropDatabase(o.adminUrl, work);
      dropped = true;
    }
    return writeUpgradeReport(o.reportDir, report);
  } finally {
    if (!o.keepCopy && !dropped) await dropDatabase(o.adminUrl, work).catch(() => undefined);
  }
}

export function writeUpgradeReport(dir: string, report: UpgradeReport): UpgradeOutcome {
  mkdirSync(dir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const jsonPath = join(dir, `${report.drillId}.json`);
  const markdownPath = join(dir, `${report.drillId}.md`);
  writeFileSync(jsonPath, json);
  writeFileSync(markdownPath, renderUpgradeMarkdown(report));
  return { report, jsonPath, markdownPath, reportSha256: sha256(json) };
}

const cell = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v as string | number | boolean | bigint | null | undefined ?? '')).replace(/\|/g, '\\|');

export function renderUpgradeMarkdown(r: UpgradeReport): string {
  const L: string[] = [];
  L.push(`# Upgrade drill and migration dry run ${r.drillId}: ${r.result}`, '');
  L.push(`From ${r.fromRelease} (${r.source.database}, ${String(r.source.sizeBytes)} bytes, PostgreSQL ${r.source.serverVersion}) to the release candidate, on the copy ${r.copy.database} (${r.copy.dropped ? 'dropped after the drill' : 'kept'}).`, '');
  L.push('| Item | Value |', '|---|---|');
  L.push(`| Schema release before | \`${cell(r.source.schemaReleaseBefore)}\` (${String(r.source.migrationsBefore)} migrations) |`);
  L.push(`| Schema release after | \`${cell(r.source.schemaReleaseAfter)}\` |`);
  L.push(`| Migrations applied | ${String(r.migrations.applied.length)} in ${String(r.migrations.durationMs)} ms |`);
  L.push(`| Whole drill | ${String(r.durationMs)} ms |`);
  L.push(`| Chains and anchors before | ${String(r.chains.before.chains)} chains, ${String(r.chains.before.anchors)} anchors, ${String(r.chains.before.problems.length)} problems |`);
  L.push(`| Chains and anchors after | ${String(r.chains.after.chains)} chains, ${String(r.chains.after.anchors)} anchors, ${String(r.chains.after.problems.length)} problems |`, '');
  if (r.failures.length > 0) L.push('Failures:', '', ...r.failures.map((f) => `- ${f}`), '');
  if (r.toReview.length > 0) L.push('To review (not compared by the dry run):', '', ...r.toReview.map((f) => `- ${f}`), '');
  L.push('## Counts and hashes per category (DI-48)', '', '| Category | Tables | MATCH | ADDED_ONLY | CHANGED | Rows before | Rows after |', '|---|---|---|---|---|---|---|');
  for (const [k, s] of Object.entries(r.summary)) L.push(`| ${k} | ${String(s.tables)} | ${String(s.match)} | ${String(s.addedOnly)} | ${String(s.changed)} | ${String(s.rowsBefore)} | ${String(s.rowsAfter)} |`);
  L.push('', '## Tables the upgrade changed (every other table: MATCH, the same rows and hash)', '', '| Table | Category | Status | Rows before | Rows after | Earlier rows missing | Columns added |', '|---|---|---|---|---|---|---|');
  for (const t of r.tables.filter((x) => x.status !== 'MATCH')) L.push(`| ${cell(t.table)} | ${t.category} | ${t.status}${t.reason ? ` (${cell(t.reason)})` : ''} | ${String(t.rowsBefore)} | ${String(t.rowsAfter)} | ${String(t.missing)} | ${cell(t.columnsAdded.join(', '))} |`);
  L.push('', '## Records retrieved and rendered (DI-46)', '', '| Record | Events | Signatures | Rows | Content SHA-256 before | After | Same | Complete |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.renders) {
    L.push(`| ${cell(x.chainKey)} | ${String(x.before.events)} | ${String(x.before.signatures)} | ${String(x.before.rows)} | \`${x.before.contentSha256.slice(0, 16)}\` | \`${(x.after?.contentSha256 ?? '-').slice(0, 16)}\` | ${x.same ? 'yes' : 'NO'} | ${x.before.problems.length + (x.after?.problems.length ?? 1) === 0 ? 'yes' : 'NO'} |`);
  }
  L.push('', '## Spot checks (DI-48: audit trails, e-signature meaning and date-time, units)', '', `Sampled: ${SPOT_CHECK_KINDS.map((k) => `${k} ${String(r.spotChecks.filter((s) => s.kind === k).length)}`).join(', ')}.`, '', '| Kind | Table | Key | Shown | Same after |', '|---|---|---|---|---|');
  for (const s of r.spotChecks) L.push(`| ${s.kind} | ${cell(s.table)} | ${cell(s.key)} | ${cell(s.shown)} | ${s.retired ? `table retired (${cell(s.retired)})` : s.same ? 'yes' : 'NO'} |`);
  L.push('', '## Migrations applied', '', r.migrations.applied.map((a) => `\`${a.namespace}/${a.name}\``).join(', ') || '(none)', '');
  return `${L.join('\n')}\n`;
}
