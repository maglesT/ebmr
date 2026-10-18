/**
 * The dashboards, the change impact and training mode over HTTP (Phase 6 slice 6g; contract ns/dashboards.ts; kernel
 * 1210, 1211; recipe-core 1070, 1071). Fixture rows (superuser, triggers off) stand for records whose own acts are
 * proven where they are built; the dashboards only read them through the report views.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPath, routes, type AnyRoute } from '@ebmr/api-contract';
import { personaIn, refusalOf, valueOf } from '../esig/support.ts';
import { trainingAttemptOf } from '../../src/features/training/index.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;
let qa: TestBrowser;
let trainee: TestBrowser;
let other: TestBrowser;
const tag = randomUUID().slice(0, 6).toUpperCase();

async function fixture(server: TestServer, sql: string, params: unknown[] = []): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
  [qa, trainee, other] = await Promise.all([gmp.asPersona('qaInvestigator'), sbx.asPersona('head1'), sbx.asPersona('qareviewer1')]);
}, 600_000);
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const inject = (server: TestServer, route: AnyRoute) =>
  server.app.inject({
    method: route.method,
    url: buildPath(route.path, { attemptId: randomUUID() }),
    headers: { origin: server.config.publicOrigin, 'sec-fetch-site': 'same-origin' },
  });

describe('dashboards over HTTP (GMP)', () => {
  it('[PR-05] an overdue review appears on the dashboard', async () => {
    const id = randomUUID();
    const family = `FAM-${tag}`;
    await fixture(gmp,
      `with f as (insert into recipe.mbr_family (code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
                  values ($2, 'Overdue family', 'tablets', 'PROCESSING', 'OVD-500', 'Overdue tablets', '500 mg', $2, '[{"id": "BS-1", "quantity": {"value": "1", "unit": "kg"}}]', $1, $1) returning id)
       insert into recipe.mbr_version (id, family_id, version_number, author_person, author_account, effective_from, review_due)
       select $1, f.id, 1, $1, $1, '2026-01-01T00:00:00Z', '2026-02-28' from f`, [id, family]);
    await fixture(gmp, "insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('mbr_version', $1, 'MBR_VERSION', 1, 'APPROVED', 1)", [id]);
    const view = valueOf(await qa.call(routes.dashboards.overdueReviews));
    const row = view.versions.find((v) => v.versionId === id);
    expect(row).toMatchObject({ documentId: `MBR-${family}-v1`, reviewDue: '2026-02-28', inUse: false, lastReviewAt: null, drill: `/mbr/versions/${id}` });
    expect(row!.daysOverdue).toBeGreaterThan(200);
    expect(view.notForGmpDecisions).toBe(true);
  });

  it('[DI-49] the alarm trend counts every alarm of the period', async () => {
    const eq = randomUUID();
    await fixture(gmp, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, 'Trend press', 'CL-PRESS', 'PROCESS', gen_random_uuid())", [eq, `PR-${tag}`]);
    // Three alarms on two site days of a past period (Asia/Kolkata), and one the day after it; codes unique to this test.
    const at = (iso: string) => String(BigInt(Date.parse(iso)) * 1000n);
    const alarms: [string, string, boolean][] = [
      [`FH${tag}`, at('2026-03-10T04:00:00Z'), true],
      [`FH${tag}`, at('2026-03-10T05:00:00Z'), false],
      [`RB${tag}`, at('2026-03-11T04:00:00Z'), false],
      [`RB${tag}`, at('2026-03-12T04:00:00Z'), false],
    ];
    for (const [code, us, critical] of alarms) {
      await fixture(gmp,
        `insert into plant.alarm (source, occurrence_id, subject_kind, equipment_id, alarm_code, gmp_critical, deviation_required, severity, message, raised_source_us,
                                  raised_by_person, raised_by_account, correlation_id)
         values ('OPCUA', $1, 'EQUIPMENT', $2, $3, $4, false, 500, 'trend fixture', $5, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [`OCC-${randomUUID()}`, eq, code, critical, us]);
    }
    const view = valueOf(await qa.call(routes.dashboards.alarmTrend, { query: { from: '2026-03-10', to: '2026-03-11' } }));
    // Independently: every alarm raised in the period, from the alarm table itself.
    const { rows } = await gmp.db.admin.query<{ n: number }>(
      `select count(*)::int as n from plant.alarm a
        where to_timestamp(a.raised_source_us::numeric / 1000000) >= ('2026-03-10'::timestamp at time zone 'Asia/Kolkata')
          and to_timestamp(a.raised_source_us::numeric / 1000000) < ('2026-03-12'::timestamp at time zone 'Asia/Kolkata')`,
    );
    expect(view.total).toBe(rows[0]!.n);
    expect(view.byCode.filter((c) => c.alarmCode.endsWith(tag))).toEqual([
      { alarmCode: `FH${tag}`, count: 2, gmpCritical: 1, batches: 0 },
      { alarmCode: `RB${tag}`, count: 1, gmpCritical: 0, batches: 0 },
    ]);
    expect(view.byDay.reduce((t, d) => t + d.count, 0)).toBe(view.total);
    expect(view.alarms.filter((a) => a.alarmCode.endsWith(tag))).toHaveLength(3);
    expect(view.period).toEqual({ from: '2026-03-10', to: '2026-03-11' });
    expect(refusalOf(await qa.call(routes.dashboards.alarmTrend, { query: { from: '2026-03-12', to: '2026-03-11' } }))).toMatchObject({ status: 400, code: 'EBMR-RPT-001' });
  });

  it('dashboards show their data age and refresh it', async () => {
    const first = valueOf(await qa.call(routes.dashboards.catalog));
    expect(first.dataAgeSeconds).toBe(0);
    expect(BigInt(first.readAt.us) - BigInt(first.dataAsOf.us)).toBeLessThan(1_000_000n);
    expect(first.views.map((v) => v.viewName)).toEqual(expect.arrayContaining(['alarm_v1', 'batch_outcome_v1', 'overdue_review_v1']));
    const again = valueOf(await qa.call(routes.dashboards.catalog));
    expect(BigInt(again.readAt.us)).toBeGreaterThan(BigInt(first.readAt.us));
    for (const route of [routes.dashboards.rightFirstTime, routes.dashboards.exceptionPareto, routes.dashboards.reviewCycleTime, routes.dashboards.deviationAgeing,
      routes.dashboards.holdTimeRisk, routes.dashboards.pressOee]) {
      const v = valueOf(await qa.call(route as typeof routes.dashboards.rightFirstTime));
      expect(v.notForGmpDecisions, route.id).toBe(true);
      expect(v.dataAgeSeconds, route.id).toBe(0);
    }
  });

  it('the export gives a view\'s rows as text with their hash; only catalogued views are exported', async () => {
    const out = valueOf(await qa.call(routes.dashboards.export, { query: { view: 'overdue_review_v1' } }));
    expect(out.columns).toEqual(['version_id', 'family_code', 'version_number', 'document_id', 'review_due', 'days_overdue', 'last_review_at', 'in_use']);
    expect(out.rows.some((r) => r[1] === `FAM-${tag}`)).toBe(true);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(refusalOf(await qa.call(routes.dashboards.export, { query: { view: 'nothing_v1' } }))).toMatchObject({ status: 404, code: 'EBMR-RPT-002' });
  });

  it('change impact over HTTP: the same answer gives the same hash; an unknown subject is a 404', async () => {
    const material = `MAT-${tag}`;
    await fixture(gmp,
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       values (gen_random_uuid(), 'SITE-1', $1, $2, 'Impact material', 'EXCIPIENT', 10, 'kg', '2030-01-01T00:00:00Z', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [`L-${tag}`, material]);
    const a = valueOf(await qa.call(routes.changeImpact.query, { query: { kind: 'MATERIAL', ref: material } }));
    const b = valueOf(await qa.call(routes.changeImpact.query, { query: { kind: 'MATERIAL', ref: material } }));
    expect(a.counts).toEqual({ versions: 0, openBatches: 0, releasedLots: 0, markets: 0, configHistory: 0 });
    expect(a.contentHash).toBe(b.contentHash);
    expect(refusalOf(await qa.call(routes.changeImpact.query, { query: { kind: 'MATERIAL', ref: `NONE-${tag}` } }))).toMatchObject({ status: 404 });
  });

  it('[DI-05] training routes answer 404 on the GMP installation and the dashboards 404 on the sandbox', async () => {
    for (const route of Object.values(routes.training)) expect((await inject(gmp, route)).statusCode, route.id).toBe(404);
    for (const route of [...Object.values(routes.dashboards), ...Object.values(routes.changeImpact)]) expect((await inject(sbx, route)).statusCode, route.id).toBe(404);
  });
});

describe('training mode over HTTP (SANDBOX; DI-05)', () => {
  it('[DI-05] the training screen data carries the TEST, NOT GMP watermark, the TEST- personas and the exercises', async () => {
    const view = valueOf(await trainee.call(routes.training.overview));
    expect(view.watermark).toMatchObject({ text: 'TEST, NOT GMP', source: 'TRAINING', control: 'DI-05' });
    expect(view.personas.length).toBeGreaterThan(0);
    for (const p of view.personas) expect(p.legalName.startsWith('TEST-'), p.legalName).toBe(true);
    expect(view.exercises.map((e) => e.code)).toEqual(['EX-FLOOR-RUN', 'EX-SCALE-WEIGH', 'EX-AUDIT-READ']);
  });

  it('[DI-05] a training session\'s attempts are the person\'s own and stay in the sandbox', async () => {
    const started = valueOf(await trainee.call(routes.training.start, { body: { exerciseCode: 'EX-SCALE-WEIGH' } }));
    expect(started).toMatchObject({ exerciseCode: 'EX-SCALE-WEIGH', exerciseVersion: 1, done: [], complete: false });
    const one = valueOf(await trainee.call(routes.training.completeStep, { params: { attemptId: started.attemptId }, body: { step: 1 } }));
    expect(one.done).toEqual([1]);
    const again = valueOf(await trainee.call(routes.training.completeStep, { params: { attemptId: started.attemptId }, body: { step: 1 } }));
    expect(again.done).toEqual([1]);
    expect(refusalOf(await trainee.call(routes.training.completeStep, { params: { attemptId: started.attemptId }, body: { step: 3 } }))).toMatchObject({ status: 404, code: 'EBMR-SBX-040' });
    expect(refusalOf(await other.call(routes.training.completeStep, { params: { attemptId: started.attemptId }, body: { step: 2 } }))).toMatchObject({ status: 404, code: 'EBMR-SBX-040' });
    const done = valueOf(await trainee.call(routes.training.completeStep, { params: { attemptId: started.attemptId }, body: { step: 2 } }));
    expect(done).toMatchObject({ done: [1, 2], complete: true });
    expect(refusalOf(await trainee.call(routes.training.start, { body: { exerciseCode: 'EX-NONE' } }))).toMatchObject({ status: 404, code: 'EBMR-TRN-001' });
    const overview = valueOf(await trainee.call(routes.training.overview));
    expect(overview.exercises.find((e) => e.code === 'EX-SCALE-WEIGH')?.attempts.map((a) => a.attemptId)).toEqual([started.attemptId]);
    expect(valueOf(await other.call(routes.training.overview)).exercises.flatMap((e) => e.attempts)).toEqual([]);
    // The training server works through the sandbox login role in the sandbox database; nothing reaches the GMP database.
    const { rows } = await sbx.db.app.query<{ who: string; kind: string }>('select current_user::text as who, kernel.installation_kind() as kind');
    expect(rows[0]).toEqual({ who: 'ebmr_sandbox', kind: 'SANDBOX' });
    expect((await gmp.db.admin.query('select count(*)::int as n from sandbox.training_attempt')).rows[0]).toEqual({ n: 0 });
    expect((await sbx.db.admin.query('select count(*)::int as n from sandbox.training_attempt where id = $1', [started.attemptId])).rows[0]).toEqual({ n: 1 });
  });

  it('[DI-05] the training attempt read answers the person\'s own attempt only; another person\'s is refused as no attempt of theirs (6jc-R15)', async () => {
    const started = valueOf(await trainee.call(routes.training.start, { body: { exerciseCode: 'EX-AUDIT-READ' } }));
    const own = await trainingAttemptOf(sbx.built.ctx, sbx.db.app, started.attemptId, personaIn(sbx, 'head1').personId);
    expect(own).toMatchObject({ attemptId: started.attemptId, exerciseCode: 'EX-AUDIT-READ' });
    const refusedFor = async (personId: string, id: string) => {
      try {
        await trainingAttemptOf(sbx.built.ctx, sbx.db.app, id, personId);
        return null;
      } catch (error) {
        return error as { statusCode?: number; refusal?: { code?: string } };
      }
    };
    expect(await refusedFor(personaIn(sbx, 'qareviewer1').personId, started.attemptId)).toMatchObject({ refusal: { code: 'EBMR-SBX-040' } });
    expect(await refusedFor(personaIn(sbx, 'head1').personId, randomUUID())).toMatchObject({ refusal: { code: 'EBMR-SBX-040' } });
  });
});
