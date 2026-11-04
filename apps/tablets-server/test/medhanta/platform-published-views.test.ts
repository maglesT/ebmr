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
import { asAdmin, copyDatabase, dropDatabase, onServer } from '@ebmr/test-kit';

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
/** The linked products' logins (databsee: Deviations and Operations). */
const READERS = ['deviations_app', 'ops_app'];

const database = `ebmr_views_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

beforeAll(async () => {
  await copyDatabase(inject('serverTemplates').gmp.template, database);
  await onServer(async (s) => {
    for (const r of READERS) await s.query(`do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$`);
  });
  // As the platform's apply grants a link: USAGE on the schema and SELECT on each published view, nothing more.
  await asAdmin(database, async (c) => {
    for (const r of READERS) {
      await c.query(`grant usage on schema report to ${r}`);
      await c.query(`grant select on ${VIEWS.map((v) => `report.${v}`).join(', ')} to ${r}`);
    }
  });
}, 300_000);
afterAll(async () => {
  await dropDatabase(database).catch(() => undefined);
});

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

  it('[PL-08] read as the linked logins deviations_app and ops_app, with only the link\'s grants', async () => {
    await asAdmin(database, async (c) => {
      for (const r of READERS) {
        for (const v of VIEWS) {
          await c.query('begin');
          try {
            await c.query(`set local role ${r}`);
            const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from report.${v}`);
            expect(Number(rows[0]?.n), `${r} ${v}`).toBeGreaterThanOrEqual(0);
            // The link gives the views, not the tables behind them.
            await expect(c.query('select 1 from recipe.batch_execution limit 1'), `${r} ${v}`).rejects.toMatchObject({ code: '42501' });
          } finally {
            await c.query('rollback');
          }
        }
      }
    });
  });
});
