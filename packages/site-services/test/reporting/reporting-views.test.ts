/**
 * The reporting views (Phase 6 slice 6g; recipe-core 1070; D-P6g-0-1 to 7): each view's rows from fixture records, read
 * by the reporting role ebmr_report, each row with its read time and data age; PR-05 overdue reviews and the DI-49
 * alarm log as the dashboards read them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { unique } from '../genealogy/world.ts';
import { ReportWorld } from './world.ts';

let db: TestDatabase;
let w: ReportWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ReportWorld.create(db);
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

/** A query as the reporting role ebmr_report (the superuser's session takes that role, and with it only its rights). */
const report = {
  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role ebmr_report');
      const r = await c.query(sql, params);
      await c.query('rollback');
      return { rows: r.rows as T[] };
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  },
};

async function rows<T>(view: string, where = 'true', params: unknown[] = []): Promise<T[]> {
  return (await report.query<T>(`select * from report.${view} where ${where}`, params)).rows;
}

describe('report views (recipe-core 1070)', () => {
  it('batch_outcome_v1: right first time only for a batch QA reviewed in its first cycle with no exception and no deviation', async () => {
    const v = await w.version('APPROVED');
    const clean = await w.batch('clean', v.id);
    await w.status(clean, 'EXECUTION_COMPLETE', '1790000000000000');
    await w.reviewAct(clean, 'QA_REVIEWED');
    const withException = await w.batch('exception', v.id);
    await w.status(withException, 'EXECUTION_COMPLETE');
    await w.reviewAct(withException, 'QA_REVIEWED');
    const { rows: cats } = await db.admin.query<{ category: string }>('select category from recipe.exception_review_category order by 1 limit 1');
    await w.exception(withException, cats[0]!.category);
    const reopened = await w.batch('reopened', v.id);
    await w.status(reopened, 'EXECUTION_COMPLETE');
    await w.reviewAct(reopened, 'REOPENED', 1);
    await w.reviewAct(reopened, 'QA_REVIEWED', 2);
    const running = await w.batch('running', v.id);
    await w.status(running, 'IN_PROGRESS');
    const out = await rows<{ batch_number: string; status: string; right_first_time: boolean; exception_count: number; review_cycles: number; completed_at: Date | null; record_kind: string }>(
      'batch_outcome_v1', 'batch_id = any($1)', [[clean.id, withException.id, reopened.id, running.id]],
    );
    const by = new Map(out.map((r) => [r.batch_number, r]));
    expect(by.get(clean.number)).toMatchObject({ status: 'QA_REVIEWED', right_first_time: true, exception_count: 0, review_cycles: 1, record_kind: 'PROCESSING' });
    expect(by.get(clean.number)?.completed_at?.toISOString()).toBe(new Date(1790000000000).toISOString());
    expect(by.get(withException.number)).toMatchObject({ right_first_time: false, exception_count: 1 });
    expect(by.get(reopened.number)).toMatchObject({ status: 'QA_REVIEWED', right_first_time: false, review_cycles: 2 });
    expect(by.get(running.number)).toMatchObject({ status: 'IN_PROGRESS', right_first_time: false, completed_at: null });
    const ex = await rows<{ batch_number: string; category: string }>('exception_v1', 'batch_id = $1', [withException.id]);
    expect(ex).toEqual([expect.objectContaining({ batch_number: withException.number, category: cats[0]!.category })]);
  });

  it('[PR-05] an overdue review is in the report view the dashboard reads, with its days overdue; one not yet due is not', async () => {
    const overdue = await w.version('APPROVED', '2026-01-31');
    const notDue = await w.version('APPROVED', '2099-12-31');
    const retired = await w.version('RETIRED', '2026-01-31');
    const out = await rows<{ version_id: string; document_id: string; review_due: Date; days_overdue: number }>('overdue_review_v1', 'version_id = any($1)', [[overdue.id, notDue.id, retired.id]]);
    expect(out.map((r) => r.document_id)).toEqual([overdue.label]);
    expect(out[0]!.days_overdue).toBeGreaterThan(200);
  });

  it('deviation_ageing_v1 and hold_time_risk_v1: ages and hours held from the records', async () => {
    const open = randomUUID();
    const closed = randomUUID();
    const who = randomUUID();
    const ref = (n: number) => `DEV-SITE-1-2026-${String(n).padStart(5, '0')}${unique('').replace(/\D/g, '').slice(0, 4)}`;
    for (const [id, r, raised] of [[open, ref(1), "now() - interval '45 days 1 hour'"], [closed, ref(2), "now() - interval '20 days'"]] as const) {
      await w.g.fixture(
        `insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, raised_at, correlation_id)
         values ($1, $2, 'SITE-1', 2026, (random() * 1000000)::int + 1, 'DEVIATION', 'Report deviation', 'MINOR', 'low risk to product quality', $3, $3, ${raised}, $3)`,
        [id, r, who],
      );
    }
    await w.g.fixture("insert into site.deviation_event (deviation_id, event, signature_id, person_id, account_id, recorded_at) values ($1, 'CLOSED', gen_random_uuid(), $2, $2, now() - interval '10 days')", [closed, who]);
    const dev = await rows<{ deviation_id: string; state: string; age_days: number; closed_at: Date | null }>('deviation_ageing_v1', 'deviation_id = any($1)', [[open, closed]]);
    const d = new Map(dev.map((r) => [r.deviation_id, r]));
    expect(d.get(open)).toMatchObject({ state: 'OPEN', age_days: 45, closed_at: null });
    expect(d.get(closed)).toMatchObject({ state: 'CLOSED', age_days: 10 });

    const b = await w.batch('bulk');
    const product = unique('HP');
    const c = await w.g.container('held', { ...b, productCode: product });
    await w.g.fixture("update plant.output_container set product_code = $2 where id = $1", [c, product]);
    await w.g.fixture("insert into plant.container_close (container_id, net_quantity, basis, weighing, person_id, account_id, closed_at) values ($1, 10, 'WEIGHED', '{}', $2, $2, now() - interval '30 hours')", [c, who]);
    await w.g.fixture("insert into recipe.bright_stock_max_hold (product_code, strength, max_hold_hours, reason, person_id, account_id) values ($1, '500 mg', 36, 'validated hold study HS-01', $2, $2)", [product, who]);
    const held = await rows<{ disposition: string; max_hold_hours: number; held_hours: string }>('hold_time_risk_v1', 'container_id = $1', [c]);
    expect(held).toEqual([expect.objectContaining({ disposition: 'LEFT', max_hold_hours: 36 })]);
    expect(held[0]!.held_hours).toMatch(/^30\.0\d$/);
  });

  it('[DI-49] the alarm view holds every alarm once, whatever number of batches it is bound to, with its acknowledgment', async () => {
    const eq = await w.equipment();
    const b1 = await w.batch('a1');
    const b2 = await w.batch('a2');
    const ids: string[] = [];
    for (const [i, code] of ['FORCE_HIGH', 'FORCE_HIGH', 'REJECT_BURST'].entries()) {
      const id = randomUUID();
      ids.push(id);
      await w.g.fixture(
        `insert into plant.alarm (id, source, occurrence_id, subject_kind, equipment_id, alarm_code, gmp_critical, deviation_required, severity, message, raised_source_us,
                                  raised_by_person, raised_by_account, correlation_id)
         values ($1, 'OPCUA', $2, 'EQUIPMENT', $3, $4, $5, false, 500, 'fixture alarm', $6, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [id, unique('OCC'), eq.id, code, i === 0, String(1790000000000000n + BigInt(i) * 1000000n)],
      );
    }
    await w.g.fixture('insert into plant.alarm_batch (alarm_id, batch_id) values ($1, $2), ($1, $3), ($4, $2)', [ids[0], b1.id, b2.id, ids[1]]);
    await w.g.fixture("insert into plant.alarm_ack (alarm_id, action_taken, comment, person_id, account_id, session_id, correlation_id) values ($1, 'press stopped', 'checked', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [ids[0]]);
    const out = await rows<{ alarm_id: string; subject_code: string; batch_count: number; batch_numbers: string[]; acked_at: Date | null; gmp_critical: boolean }>(
      'alarm_v1', 'alarm_id = any($1) order by raised_at', [ids],
    );
    expect(out.map((r) => [r.subject_code, r.batch_count, r.acked_at !== null, r.gmp_critical])).toEqual([
      [eq.code, 2, true, true],
      [eq.code, 1, false, false],
      [eq.code, 0, false, false],
    ]);
    expect(out[0]!.batch_numbers).toEqual([b1.number, b2.number].sort());
  });

  it('press_counter_v1: RUNNING seconds and counter deltas within the batch window of the state events', async () => {
    const eq = await w.equipment();
    const b = await w.batch('press');
    const t0 = 1790000000000000n;
    for (const [i, state, at] of [[0, 'RUNNING', t0], [1, 'HELD', t0 + 600_000_000n], [2, 'RUNNING', t0 + 900_000_000n], [3, 'STOPPED', t0 + 1_800_000_000n]] as const) {
      await w.g.fixture(
        `insert into plant.equipment_state_event (source, event_id, equipment_id, kind, state, message, occurred_source_us, batch_id, recorded_by_account, correlation_id)
         values ('OPCUA', $1, $2, 'STATE_CHANGED', $3, 'state', $4, $5, gen_random_uuid(), gen_random_uuid())`,
        [`${unique('EV')}-${i}`, eq.id, state, String(at), b.id],
      );
    }
    const samples = (vals: [bigint, string][]) => JSON.stringify(vals.map(([t, v]) => ({ sourceTime: String(t), raw: v, value: v, status: '0x00000000' })));
    for (const [tag, vals] of [['tablet.count', [[t0 - 1n, '50'], [t0, '100'], [t0 + 1_800_000_000n, '90100'], [t0 + 1_900_000_000n, '99999']]],
                               ['reject.count', [[t0, '3'], [t0 + 1_800_000_000n, '153']]]] as const) {
      await w.g.fixture(
        `insert into plant.series (source, subject_kind, equipment_id, tag, unit, chunk_no, from_us, to_us, sample_count, samples, chunk_hash, inbound_message_id)
         values ('OPCUA', 'EQUIPMENT', $1, $2, 'count', 1, 0, 9000000000000000, $3, $4::jsonb, $5, gen_random_uuid())`,
        [eq.id, tag, vals.length, samples(vals as unknown as [bigint, string][]), '0'.repeat(64)],
      );
    }
    const out = await rows<{ running_seconds: string; observed_seconds: string; tablets: string; rejects: string }>('press_counter_v1', 'batch_id = $1', [b.id]);
    expect(out).toEqual([expect.objectContaining({ running_seconds: '1500.000', observed_seconds: '1800.000', tablets: '90000', rejects: '150' })]);
  });

  it('every view row carries read_at and data_as_of; the reporting role reads every view and writes none', async () => {
    const { rows: views } = await report.query<{ view_name: string }>('select view_name from report.catalog_v1');
    for (const { view_name } of views) {
      const { rows: r } = await report.query<{ ok: boolean }>(`select bool_and(read_at >= data_as_of and read_at - data_as_of < interval '1 second') as ok from report.${view_name}`);
      expect(r[0]!.ok ?? true, view_name).toBe(true);
      await expect(report.query(`delete from report.${view_name}`), view_name).rejects.toThrow(/permission denied|cannot delete/);
    }
    // The eight 6g views, slice 6A-1's three analytics inputs (recipe-core 1115) and slice 6A-2's two (recipe-core 1130).
    expect(views.length).toBe(13);
  });
});
