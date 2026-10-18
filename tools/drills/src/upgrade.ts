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
import { migrate, type MigrationSource } from '@ebmr/kernel';
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
  /** Name of the copy (default <source>_upg_<hex>). */
  workDatabase?: string;
}

export type TableStatus = 'MATCH' | 'ADDED_ONLY' | 'ADVANCED' | 'CHANGED' | 'NEW' | 'DROPPED';

/** The tables whose rows are signatures (the rest of esig is its catalogue: meanings, content providers, keys). */
export const SIGNATURE_RECORDS: readonly string[] = ['"esig"."signature"'];

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
}

export interface SpotCheck {
  kind: 'SIGNATURE' | 'AUDIT_EVENT' | 'UNIT_VALUE';
  table: string;
  key: string;
  shown: string;
  same: boolean;
}

export interface UpgradeReport {
  kind: 'ebmr.upgrade-drill';
  version: 1;
  drillId: string;
  result: 'PASS' | 'FAIL';
  failures: string[];
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
    const { rows } = await c.query<{ l: string }>("select namespace || '/' || name || '/' || checksum as l from public.schema_migration order by namespace collate \"C\", name collate \"C\"");
    return sha256(rows.map((r) => r.l).join('\n'));
  }
  return (await c.query<{ r: string }>('select platform.schema_release() as r')).rows[0]?.r ?? null;
}

interface Sample {
  kind: SpotCheck['kind'];
  table: string;
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
    out.push({ kind: 'SIGNATURE', table: 'esig.signature', key: r.id, value: r.v, shown: r.shown, params: [r.id], sql: `select jsonb_build_object('meaning', s.meaning_code, 'meaningText', s.meaning_text, 'signer', s.signer_legal_name, 'role', s.signer_role_code,
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
    out.push({ kind: 'AUDIT_EVENT', table: 'kernel.audit_event', key: r.id, value: r.v, shown: r.shown, params: [r.id], sql: `select jsonb_build_object('chain', e.chain_key, 'seq', e.seq, 'hash', encode(e.hash, 'hex'), 'prev', encode(e.prev_hash, 'hex'),
                               'recordedAtUtc', to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'action', e.action,
                               'payload', md5(e.payload::text))::text as v from kernel.audit_event e where e.id = $1::bigint` });
  }
  // Tables holding a unit, with a single-column primary key: sampled rows, every column as text.
  const unitTables = await c.query<{ qualified: string; pk: string; units: string[] }>(
    `select format('%I.%I', n.nspname, c.relname) as qualified, pa.attname as pk,
            array_agg(a.attname::text order by a.attnum) as units
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_index i on i.indrelid = c.oid and i.indisprimary and i.indnkeyatts = 1
       join pg_attribute pa on pa.attrelid = c.oid and pa.attnum = i.indkey[0]
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and (a.attname = 'unit' or a.attname like '%\\_unit')
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', '${SNAPSHOT}')
      group by 1, 2 order by 1`,
  );
  for (const t of unitTables.rows) {
    const cols = (await c.query<{ name: string }>(`select a.attname as name from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [t.qualified])).rows.map((r) => r.name);
    const rowText = `jsonb_build_object(${cols.map((col) => `'${col.replace(/'/g, "''")}', x.${quoteIdent(col)}::text`).join(', ')})::text`;
    const shownText = t.units.map((u) => `x.${quoteIdent(u)}::text`).join(` || ' ' || `);
    const rows = await c.query<{ k: string; v: string; shown: string | null }>(
      `select x.${quoteIdent(t.pk)}::text as k, ${rowText} as v, ${shownText} as shown from ${t.qualified} x order by md5(x.${quoteIdent(t.pk)}::text || $2) limit $1`,
      [Math.max(1, Math.ceil(n / 4)), seed],
    );
    for (const r of rows.rows) {
      out.push({ kind: 'UNIT_VALUE', table: t.qualified, key: r.k, value: r.v, shown: r.shown ?? '', params: [r.k], sql: `select ${rowText} as v from ${t.qualified} x where x.${quoteIdent(t.pk)}::text = $1` });
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
    const serverVersion = (await c.query<{ v: string }>('show server_version')).rows[0]?.v ?? '';
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
    const keys = await recordsToRender(c, o.renderLimit ?? 10);
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
        results.push({ table: q, category: b.t.category, status: 'DROPPED', rowsBefore: b.n, rowsAfter: 0, missing: b.n, sha256Before: b.sha, sha256After: null, columnsAdded: [] });
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
      const r = await c.query<{ v: string }>(s.sql, s.params);
      const same = r.rows[0]?.v === s.value;
      spotChecks.push({ kind: s.kind, table: s.table, key: s.key, shown: s.shown, same });
      if (!same) failures.push(`spot check ${s.kind} ${s.table} ${s.key} reads differently after the upgrade`);
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
    if (keys.length === 0) failures.push('the source holds no record to render');
    await c.end();

    const report: UpgradeReport = {
      kind: 'ebmr.upgrade-drill',
      version: 1,
      drillId,
      result: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
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

const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|');

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
  L.push('## Counts and hashes per category (DI-48)', '', '| Category | Tables | MATCH | ADDED_ONLY | CHANGED | Rows before | Rows after |', '|---|---|---|---|---|---|---|');
  for (const [k, s] of Object.entries(r.summary)) L.push(`| ${k} | ${String(s.tables)} | ${String(s.match)} | ${String(s.addedOnly)} | ${String(s.changed)} | ${String(s.rowsBefore)} | ${String(s.rowsAfter)} |`);
  L.push('', '## Tables the upgrade changed (every other table: MATCH, the same rows and hash)', '', '| Table | Category | Status | Rows before | Rows after | Earlier rows missing | Columns added |', '|---|---|---|---|---|---|---|');
  for (const t of r.tables.filter((x) => x.status !== 'MATCH')) L.push(`| ${cell(t.table)} | ${t.category} | ${t.status} | ${String(t.rowsBefore)} | ${String(t.rowsAfter)} | ${String(t.missing)} | ${cell(t.columnsAdded.join(', '))} |`);
  L.push('', '## Records retrieved and rendered (DI-46)', '', '| Record | Events | Signatures | Rows | Content SHA-256 before | After | Same | Complete |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.renders) {
    L.push(`| ${cell(x.chainKey)} | ${String(x.before.events)} | ${String(x.before.signatures)} | ${String(x.before.rows)} | \`${x.before.contentSha256.slice(0, 16)}\` | \`${(x.after?.contentSha256 ?? '-').slice(0, 16)}\` | ${x.same ? 'yes' : 'NO'} | ${x.before.problems.length + (x.after?.problems.length ?? 1) === 0 ? 'yes' : 'NO'} |`);
  }
  L.push('', '## Spot checks (DI-48: audit trails, e-signature meaning and date-time, units)', '', '| Kind | Table | Key | Shown | Same after |', '|---|---|---|---|---|');
  for (const s of r.spotChecks) L.push(`| ${s.kind} | ${cell(s.table)} | ${cell(s.key)} | ${cell(s.shown)} | ${s.same ? 'yes' : 'NO'} |`);
  L.push('', '## Migrations applied', '', r.migrations.applied.map((a) => `\`${a.namespace}/${a.name}\``).join(', ') || '(none)', '');
  return `${L.join('\n')}\n`;
}
