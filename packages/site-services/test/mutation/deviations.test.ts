/**
 * Deviation-lite and evidence documents, rule by rule (SQL mutation group "deviations": site services 0730, 0731,
 * 0753). These tests close the gaps the Phase 3 exit SQL mutation run found in test/quality: each refusal with its own
 * code and nothing else standing in for it (the details, kind, classification, rationale and title of a record; an
 * unknown record or subject kind; a step out of its state; a short cause), the reference serial per site and year, the
 * signer of a QA act being the person who records it, the signed content of a record, and the subject resolver.
 *
 * Controls: PR-49, PR-50, IN-20, DI-24, DI-35.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concludeDeviation, linkDeviation, raiseDeviation, recordDeviationFinding, startDeviationInvestigation, type NewDeviation } from '../../src/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const DEV: NewDeviation = { kind: 'DEVIATION', title: 'Granule moisture above the limit', classification: 'MAJOR', riskRationale: 'Moisture may affect hardness' };
const raiseSql = (p: unknown) => refusal(w.run(w.cast.operator, (c) => c.query('select site.raise_deviation($1::jsonb)', [p === null ? null : JSON.stringify(p)])));
const raise = () => w.run(w.cast.operator, (c) => raiseDeviation(c, DEV));

describe('a record is raised rule by rule (site services 0730)', () => {
  it('[PR-49] the details, the kind, the classification with a rationale of at least 10 characters, and a title', async () => {
    expect(await raiseSql(null)).toMatch(/^EBMR-SITE-301 the deviation details are required$/);
    expect(await raiseSql('a deviation')).toMatch(/^EBMR-SITE-301 the deviation details are required$/);
    expect(await raiseSql({ ...DEV, kind: 'COMPLAINT' })).toMatch(/EBMR-SITE-301 the kind is DEVIATION, OOS or INVESTIGATION/);
    expect(await raiseSql({ ...DEV, classification: 'SEVERE' })).toMatch(/EBMR-SITE-301 a deviation is classified/);
    expect(await raiseSql({ ...DEV, riskRationale: '123456789' })).toMatch(/EBMR-SITE-301 a deviation is classified/);
    expect(await raiseSql({ ...DEV, title: '  ' })).toMatch(/EBMR-SITE-301 a deviation has a title/);
    expect(await raiseSql({ ...DEV, riskRationale: '1234567890' })).toBe('');
  });

  it('[PR-49] the reference serial counts the site\'s own records of the year', async () => {
    const year = (await db.admin.query<{ y: number }>("select extract(year from clock_timestamp() at time zone 'Asia/Kolkata')::int as y")).rows[0]?.y;
    const first = await raise();
    await w.fixture(
      `insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id)
       values (gen_random_uuid(), $1, 'SITE-9', $2, 9000, 'DEVIATION', 'elsewhere', 'MINOR', 'another site entirely', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [`DEV-SITE-9-${year}-09000`, year],
    );
    const second = await raise();
    const serial = (ref: string) => Number(ref.split('-').at(-1));
    expect(serial(second.ref)).toBe(serial(first.ref) + 1);
  });
});

describe('each step refused on its own (site services 0730, 0753)', () => {
  it('[IN-20][PR-49] an unknown record, an unknown subject kind, an investigation started twice, a finding while OPEN or with a short cause, a close before the conclusion', async () => {
    expect(await refusal(w.run(w.cast.qa, (c) => startDeviationInvestigation(c, randomUUID())))).toMatch(/EBMR-SITE-302 unknown deviation-lite record/);
    const d = await raise();
    expect(await refusal(w.run(w.cast.operator, (c) => c.query("select site.link_deviation($1, 'TANK', gen_random_uuid())", [d.deviationId])))).toMatch(/EBMR-SITE-304 TANK is not a subject kind/);
    expect(await refusal(w.run(w.cast.operator, (c) => c.query('select site.link_deviation($1, null, gen_random_uuid())', [d.deviationId])))).toMatch(/EBMR-SITE-304 NULL is not a subject kind/);
    const finding = { assignableCause: true, cause: '0123456789', rootCauseCategory: 'HUMAN_ERROR' } as const;
    expect(await refusal(w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, finding)))).toMatch(/EBMR-SITE-306 .* is OPEN; a finding is recorded while/);
    expect(await refusal(w.run(w.cast.qa2, (c) => c.query('select site.close_deviation($1, gen_random_uuid())', [d.deviationId])))).toMatch(/EBMR-SITE-310 .* is OPEN; QA closes a CONCLUDED record/);
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId));
    expect(await refusal(w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId)))).toMatch(/EBMR-SITE-305 .* is UNDER_INVESTIGATION; only an OPEN record/);
    expect(await refusal(w.run(w.cast.qa, (c) => c.query('select site.record_deviation_finding($1, null)', [d.deviationId])))).toMatch(/EBMR-SITE-306 a finding states/);
    expect(await refusal(w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { ...finding, cause: '012345678' })))).toMatch(/EBMR-SITE-306 a finding states/);
    expect(await refusal(w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, finding)))).toBe('');
  });

  it('[PR-50][DI-35] a QA act is recorded by the person who signed it: a QA person outside the record cannot present another\'s signature', async () => {
    const d = await raise();
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId));
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: false, cause: 'No cause found after the review', rootCauseCategory: 'NOT_DETERMINED' }));
    const sig = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'UNDER_INVESTIGATION');
    // qa3 neither raised the record nor recorded its finding: only the signer rule refuses.
    expect(await refusal(w.run(w.cast.qa3, (c) => concludeDeviation(c, d.deviationId, sig)))).toMatch(/^EBMR-SITE-308 DEVIATION_CONCLUDED is recorded by the QA person who signed it$/);
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, sig)))).toBe('');
  });
});

describe('the signed content and the subject resolver (site services 0730)', () => {
  it('[DI-24] a record\'s content version counts its own links, events, findings and conclusion', async () => {
    const busy = await raise();
    const lot = await w.lot();
    await w.run(w.cast.operator, (c) => linkDeviation(c, busy.deviationId, 'LOT', lot.lotId));
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, busy.deviationId));
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, busy.deviationId, { assignableCause: false, cause: 'No cause found after the review', rootCauseCategory: 'NOT_DETERMINED' }));
    const quiet = await raise();
    const content = async (id: string) =>
      (await db.admin.query<{ c: { content_version: number; content: { links: unknown[]; events: unknown[] } } }>('select site.deviation_content($1) as c', [id])).rows[0]?.c;
    expect(await content(quiet.deviationId)).toMatchObject({ content_version: 1, content: { links: [], events: [] } });
    expect(await content(busy.deviationId)).toMatchObject({ content_version: 4 });
    expect((await content(busy.deviationId))?.content.links).toHaveLength(1);
  });

  it('[PR-49] a subject resolver takes (text, uuid) and returns jsonb; what it answers counts only as an object with a batch and a site', async () => {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("create function public.bad_resolver(text) returns jsonb language sql as $$ select '{}'::jsonb $$");
      await c.query("create function public.bad_return(text, uuid) returns text language sql as $$ select 'x' $$");
      await c.query("create function public.test_resolver(k text, id uuid) returns jsonb language sql as $$ select case k when 'BATCH' then '{\"batchId\": \"b\"}'::jsonb else '{\"batchId\": \"b\", \"siteCode\": \"SITE-1\"}'::jsonb end $$");
      await c.query('savepoint s1');
      await expect(c.query("select site.register_subject_resolver('public.bad_resolver(text)')")).rejects.toThrow(/EBMR-SITE-300/);
      await c.query('rollback to savepoint s1');
      await expect(c.query("select site.register_subject_resolver('public.bad_return(text, uuid)')")).rejects.toThrow(/EBMR-SITE-300/);
      await c.query('rollback to savepoint s1');
      await c.query("select site.register_subject_resolver('public.test_resolver(text, uuid)')");
      const id = async (kind: string | null, sid: string | null) => (await c.query<{ v: unknown }>('select site.subject_identity($1, $2) as v', [kind, sid])).rows[0]?.v;
      const u = randomUUID();
      expect(await id('BATCH', u)).toBeNull();
      expect(await id('CONTAINER', u)).toEqual({ batchId: 'b', siteCode: 'SITE-1' });
      expect(await id('LOT', u)).toBeNull();
      expect(await id(null, u)).toBeNull();
      expect(await id('CONTAINER', null)).toBeNull();
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
