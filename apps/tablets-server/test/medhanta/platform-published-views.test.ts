/**
 * MEDHANTA platform, Phase B slice 4 (docs/build-plan/phase-b/platform-move-plan.md, "Published views"): the report
 * views Batchwright publishes to linked products. Deviations and Operations read them through their platform link, as
 * their own login, which the platform's apply grants SELECT on the views and USAGE on the schema report (nothing else).
 *
 * Platform rules PL-08 (linked reads through versioned views, with read_at and data_as_of) and PL-13 (the views keep the
 * standalone columns: added, never removed or renamed).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { asAdmin, copyDatabase, dropDatabase, onServer, urlFor } from '@ebmr/test-kit';

/** The columns of each published view on branch `standalone` (0bb289c), in order. */
const STANDALONE: Record<string, string[]> = {
  alarm_v1: ['alarm_id', 'source', 'alarm_code', 'gmp_critical', 'subject_kind', 'subject_code', 'raised_at', 'received_at', 'acked_at', 'batch_count', 'batch_numbers', 'read_at', 'data_as_of'],
  batch_fact_v1: ['batch_id', 'batch_number', 'product_code', 'strength', 'mbr_version_id', 'family_code', 'record_kind', 'status', 'issued_at', 'completed_at', 'released', 'read_at', 'data_as_of'],
  batch_reference_v1: ['batch_number', 'kind', 'code', 'version', 'title', 'read_at', 'data_as_of'],
  cpp_value_v1: ['batch_id', 'batch_number', 'kind', 'item', 'step', 'attempt', 'reading', 'role', 'value_text', 'unit', 'lower_text', 'upper_text', 'target_text', 'limit_tier', 'failed', 'recorded_at', 'ref', 'read_at', 'data_as_of'],
  equipment_use_v1: ['batch_number', 'equipment_code', 'equipment_type', 'room_code', 'step', 'started_at', 'ended_at', 'read_at', 'data_as_of'],
  exception_detail_v1: ['batch_number', 'exception_id', 'exception_type', 'category', 'severity', 'step', 'step_title', 'description', 'status', 'disposition', 'disposed_by', 'disposed_at', 'raised_at', 'read_at', 'data_as_of'],
  exception_v1: ['batch_id', 'batch_number', 'exception_id', 'exception_type', 'category', 'severity', 'raised_at', 'read_at', 'data_as_of'],
  ipc_result_v1: ['batch_number', 'step', 'step_title', 'check_kind', 'item', 'instrument_code', 'reading', 'value_text', 'unit', 'lower_text', 'upper_text', 'aggregate', 'alert_lower_text', 'alert_upper_text', 'result', 'recorded_at', 'read_at', 'data_as_of'],
  process_actual_v1: ['batch_number', 'step', 'tag', 'value_text', 'unit', 'lower_text', 'upper_text', 'within_limits', 'recorded_at', 'read_at', 'data_as_of'],
  step_use_v1: ['batch_id', 'batch_number', 'step', 'step_id', 'equipment_code', 'equipment_type', 'room_code', 'started_at', 'ended_at', 'person_ids', 'material_lots', 'read_at', 'data_as_of'],
};
const VIEWS = Object.keys(STANDALONE);
/** The linked products' logins (the platform's Deviations and Operations), and a login granted only one view. */
const READERS = ['deviations_app', 'ops_app'];
const PROBE = `ebmr_probe_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const PASSWORD = 'linked-login-test-password';

const database = `ebmr_views_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

beforeAll(async () => {
  await copyDatabase(inject('serverTemplates').gmp.template, database);
  await onServer(async (s) => {
    for (const r of [...READERS, PROBE]) {
      await s.query(`do $$ begin create role ${r}; exception when duplicate_object then null; end $$`);
      await s.query(`alter role ${r} login password '${PASSWORD}'`);
    }
  });
  // As the platform's apply grants a link: CONNECT, USAGE on the schema and SELECT on each published view, nothing more.
  await asAdmin(database, async (c) => {
    for (const r of [...READERS, PROBE]) {
      await c.query(`grant connect on database ${database} to ${r}`);
      await c.query(`grant usage on schema report to ${r}`);
    }
    for (const r of READERS) await c.query(`grant select on ${VIEWS.map((v) => `report.${v}`).join(', ')} to ${r}`);
    await c.query(`grant select on report.batch_fact_v1 to ${PROBE}`);
  });
}, 300_000);
afterAll(async () => {
  await dropDatabase(database).catch(() => undefined);
  await onServer((s) => s.query(`drop role if exists ${PROBE}`)).catch(() => undefined);
});

/** Runs `work` on a connection of the login `role` itself (session_user is that login). */
async function asLogin<T>(role: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(database, { name: role, password: PASSWORD }) });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

describe('the published report views (PL-08, PL-13)', () => {
  it('[PL-13] keep the standalone columns in order, each with read_at and data_as_of', async () => {
    const cols = await asAdmin(database, async (c) => (await c.query<{ v: string; cols: string[] }>(
      `select c.relname as v, array_agg(a.attname::text order by a.attnum) as cols
         from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'report' and c.relname = any ($1) group by 1`, [VIEWS])).rows);
    expect(cols).toHaveLength(VIEWS.length);
    for (const { v, cols: have } of cols) {
      expect(have.slice(0, STANDALONE[v]?.length), v).toEqual(STANDALONE[v]);
      expect(have, v).toEqual(expect.arrayContaining(['read_at', 'data_as_of']));
    }
  });

  it('[PL-08] are security_barrier, owner-rights views (not security_invoker), and call no function revoked from PUBLIC', async () => {
    const opts = await asAdmin(database, async (c) => (await c.query<{ v: string; o: string[] | null }>(
      "select c.relname as v, c.reloptions as o from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'report' and c.relname = any ($1)", [VIEWS])).rows);
    for (const { v, o } of opts) {
      expect(o ?? [], v).toContain('security_barrier=true');
      expect((o ?? []).some((x) => x.startsWith('security_invoker=true')), v).toBe(false);
    }
    const revoked = await asAdmin(database, async (c) => (await c.query<{ f: string }>(
      `select distinct d.refobjid::regprocedure::text as f
         from pg_rewrite w join pg_class c on c.oid = w.ev_class join pg_namespace n on n.oid = c.relnamespace
         join pg_depend d on d.objid = w.oid and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass
        where n.nspname = 'report' and c.relname = any ($1) and not has_function_privilege('public', d.refobjid, 'execute')`, [VIEWS])).rows);
    expect(revoked).toEqual([]);
  });

  it('[PL-08] read as the linked logins deviations_app and ops_app, on their own connection, with only the link\'s grants', async () => {
    for (const r of READERS) {
      await asLogin(r, async (c) => {
        for (const v of VIEWS) {
          const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from report.${v}`);
          expect(rows[0]?.n, `${r} ${v}`).toMatch(/^[0-9]+$/);
        }
        // The link gives the views, not the tables or the row functions behind them.
        await expect(c.query('select 1 from recipe.batch_execution limit 1')).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('select * from report.exception_rows_v1()')).rejects.toMatchObject({ code: '42501' });
      });
    }
  });

  it('[PL-08][DI-51][PR-60] a login reads only the views it was granted: the view\'s function refuses any other', async () => {
    await asLogin(PROBE, async (c) => {
      await c.query('select count(*) from report.batch_fact_v1');
      await c.query('select count(*) from report.batch_fact_published_v1()');
      for (const sql of ['select * from report.exception_v1', 'select * from report.exception_published_v1()', 'select * from report.exception_rows_v1()']) {
        await expect(c.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    });
    // The row functions stay revoked from PUBLIC (ebmr_app and ebmr_report keep theirs).
    const open = await asAdmin(database, async (c) => (await c.query<{ f: string }>(
      "select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'report' and p.proname like '%\\_rows\\_v1' and has_function_privilege('public', p.oid, 'execute')")).rows);
    expect(open).toEqual([]);
  });
});
