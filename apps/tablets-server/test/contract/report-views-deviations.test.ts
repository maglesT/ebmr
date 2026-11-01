/**
 * The report views a separate Deviations and CAPA system reads through the reporting role (slice S16; decisions D-S16-1
 * and D-S16-2; tablets 1800 and 1801, recipe-core 1070 and 1115). The external reader is outside this repository, so the
 * contract it relies on is pinned here: each view's columns, by name, order and type, exactly as the database gives them.
 * A change of columns fails this test: the change is a new _v2 view and the _v1 view stays until the reader moves.
 *
 * Also: the reporting role reads the two S16 views and their rows (the reference documents, and a GMP batch's cited
 * documents with the registered titles), and the segregation check of the GMP database stays clean with them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { startServer } from '../support/harness.ts';
import { valueOf } from '../esig/support.ts';

/** The columns of each view (name and type as pg_catalog.format_type gives them), in their order. */
const CONTRACT: Record<string, string[]> = {
  batch_fact_v1: [
    'batch_id uuid', 'batch_number text', 'product_code text', 'strength text', 'mbr_version_id uuid', 'family_code text', 'record_kind text', 'status text',
    'issued_at timestamp with time zone', 'completed_at timestamp with time zone', 'released boolean', 'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  step_use_v1: [
    'batch_id uuid', 'batch_number text', 'step text', 'step_id text', 'equipment_code text', 'equipment_type text', 'room_code text', 'started_at timestamp with time zone',
    'ended_at timestamp with time zone', 'person_ids uuid[]', 'material_lots jsonb', 'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  cpp_value_v1: [
    'batch_id uuid', 'batch_number text', 'kind text', 'item text', 'step text', 'attempt integer', 'reading integer', 'role text', 'value_text text', 'unit text',
    'lower_text text', 'upper_text text', 'target_text text', 'limit_tier text', 'failed boolean', 'recorded_at timestamp with time zone', 'ref text',
    'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  exception_v1: [
    'batch_id uuid', 'batch_number text', 'exception_id text', 'exception_type text', 'category text', 'severity text', 'raised_at timestamp with time zone',
    'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  alarm_v1: [
    'alarm_id uuid', 'source text', 'alarm_code text', 'gmp_critical boolean', 'subject_kind text', 'subject_code text', 'raised_at timestamp with time zone',
    'received_at timestamp with time zone', 'acked_at timestamp with time zone', 'batch_count integer', 'batch_numbers text[]', 'read_at timestamp with time zone',
    'data_as_of timestamp with time zone',
  ],
  reference_document_v1: ['kind text', 'code text', 'version text', 'title text', 'effective_from date', 'read_at timestamp with time zone', 'data_as_of timestamp with time zone'],
  batch_reference_v1: ['batch_number text', 'kind text', 'code text', 'version text', 'title text', 'read_at timestamp with time zone', 'data_as_of timestamp with time zone'],
  equipment_use_v1: [
    'batch_number text', 'equipment_code text', 'equipment_type text', 'room_code text', 'step text', 'started_at timestamp with time zone', 'ended_at timestamp with time zone',
    'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  ipc_result_v1: [
    'batch_number text', 'step text', 'step_title text', 'check_kind text', 'item text', 'instrument_code text', 'reading integer', 'value_text text', 'unit text',
    'lower_text text', 'upper_text text', 'aggregate text', 'alert_lower_text text', 'alert_upper_text text', 'result text', 'recorded_at timestamp with time zone',
    'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  process_actual_v1: [
    'batch_number text', 'step text', 'tag text', 'value_text text', 'unit text', 'lower_text text', 'upper_text text', 'within_limits boolean',
    'recorded_at timestamp with time zone', 'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
  exception_detail_v1: [
    'batch_number text', 'exception_id text', 'exception_type text', 'category text', 'severity text', 'step text', 'step_title text', 'description text',
    'status text', 'disposition text', 'disposed_by text', 'disposed_at timestamp with time zone', 'raised_at timestamp with time zone',
    'read_at timestamp with time zone', 'data_as_of timestamp with time zone',
  ],
};

let w: GmpBatchWorld;

beforeAll(async () => {
  w = await startGmpBatchWorld();
}, 300_000);
afterAll(async () => {
  await w?.close();
});

/** A query as the reporting role (the superuser's session takes that role, and with it only its rights). */
async function asReport<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await w.gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_report');
    const r = await c.query(sql, params);
    return r.rows as T[];
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('the report views the Deviations system reads (slice S16, D-S16-2)', () => {
  it('each view has exactly the pinned columns, names, order and types', async () => {
    const { rows } = await w.gmp.db.admin.query<{ view: string; columns: string[] }>(
      `select c.relname as view, array_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) order by a.attnum) as columns
         from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relnamespace = 'report'::regnamespace and c.relkind = 'v' and c.relname = any($1)
        group by c.relname`,
      [Object.keys(CONTRACT)],
    );
    expect(Object.fromEntries(rows.map((r) => [r.view, r.columns]))).toEqual(CONTRACT);
  });

  it('the reporting role may read each view, and each is in the report catalogue with its columns', async () => {
    for (const view of Object.keys(CONTRACT)) {
      const { rows } = await w.gmp.db.admin.query<{ ok: boolean }>("select has_table_privilege('ebmr_report', $1, 'SELECT') as ok", [`report.${view}`]);
      expect(rows[0]?.ok, view).toBe(true);
    }
    const catalogue = await asReport<{ view_name: string; columns: { name: string; type: string }[] }>('select view_name, columns from report.catalog_v1 where view_name = any($1)', [Object.keys(CONTRACT)]);
    expect(Object.fromEntries(catalogue.map((r) => [r.view_name, r.columns.map((x) => `${x.name} ${x.type}`)]))).toEqual(CONTRACT);
  });

  it('[DI-17] the segregation check of the GMP database stays clean with the S16 views (tablets 1800, 1801): the reporting role reads report views only', async () => {
    const { rows } = await w.gmp.db.admin.query<{ p: string }>('select p from sandbox.segregation_problems() p');
    expect(rows.map((r) => r.p)).toEqual([]);
    // The reporting role reaches no table behind the views.
    await expect(asReport('select 1 from tab.reference_document limit 1')).rejects.toThrow(/permission denied/);
  });

  it('[DI-05] in a sandbox database the reporting role cannot connect and the segregation check stays clean with the S16 views', async () => {
    const sbx = await startServer('SANDBOX');
    try {
      const { rows } = await sbx.db.admin.query<{ ok: boolean }>("select has_database_privilege('ebmr_report', current_database(), 'CONNECT') as ok");
      expect(rows[0]?.ok).toBe(false);
      expect((await sbx.db.admin.query<{ p: string }>('select p from sandbox.segregation_problems() p')).rows.map((r) => r.p)).toEqual([]);
    } finally {
      await sbx.close();
    }
  }, 300_000);

  it('reference_document_v1 lists the recorded reference document versions with their effective dates', async () => {
    const steward = await w.gmp.asPersona('steward');
    valueOf(await steward.call(routes.marketConfig.recordReferenceDocument, {
      body: { kind: 'SOP', code: 'SOP-DISP-001', version: '1', title: 'Dispensing of raw materials (as registered)', effectiveFrom: '2024-01-01', summary: 'Booth, balance check, dispensing.' },
    }));
    const rows = await asReport<{ kind: string; code: string; version: string; title: string; effective_from: string; read_at: Date; data_as_of: Date }>(
      "select kind, code, version, title, effective_from::text, read_at, data_as_of from report.reference_document_v1 where code = 'SOP-DISP-001'",
    );
    expect(rows).toEqual([expect.objectContaining({ kind: 'SOP', code: 'SOP-DISP-001', version: '1', title: 'Dispensing of raw materials (as registered)', effective_from: '2024-01-01' })]);
    expect(rows[0]?.read_at).toBeInstanceOf(Date);
    expect(rows[0]?.data_as_of).toBeInstanceOf(Date);
    const { rows: n } = await w.gmp.db.admin.query<{ n: string }>('select count(*)::text as n from tab.reference_document');
    expect((await asReport<{ n: string }>('select count(*)::text as n from report.reference_document_v1'))[0]?.n).toBe(n[0]?.n);
  });

  it('batch_reference_v1 lists the documents an issued GMP batch\'s master record cites: the registered title, else the record\'s own', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const batchId = await w.issued(issuer);
    const { rows: b } = await w.gmp.db.admin.query<{ batch_number: string }>('select batch_number from recipe.batch_execution where id = $1', [batchId]);
    const rows = await asReport<{ kind: string; code: string; version: string; title: string }>(
      'select kind, code, version, title from report.batch_reference_v1 where batch_number = $1', [b[0]?.batch_number ?? ''],
    );
    const registered = 'Dispensing of raw materials (as registered)';
    const expected = w.content.references.map((r) => ({ kind: r.kind, code: r.code, version: r.version, title: r.code === 'SOP-DISP-001' ? registered : (r.title ?? null) }));
    const key = (x: { kind: string; code: string }) => `${x.kind} ${x.code}`;
    expect([...rows].sort((x, y) => key(x).localeCompare(key(y)))).toEqual([...expected].sort((x, y) => key(x).localeCompare(key(y))));
    expect(await asReport('select 1 from report.batch_reference_v1 where batch_number = $1', ['NO-SUCH-BATCH'])).toEqual([]);
  });
});
