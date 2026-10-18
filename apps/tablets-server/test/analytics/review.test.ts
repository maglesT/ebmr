/**
 * The review priority end to end (Phase 6A slice 6A-5; decision 0016 item 9; D-6A-13, D-6A-14, D-6A-5-*; draft controls
 * PR-61, PR-52, DI-51): QA puts REVIEW.PRIORITY version 1 in force, the runner scores the GMP records in the review queue
 * from report.review_fact_v1 and the other catalogued inputs, and the review queue orders the same records by it, with
 * the reasons, for a holder of ANALYTICS.VIEW. The queue lists the same records with and without scores, with the
 * runner stopped and with the priority unreadable; an unscored record heads it; and the record with the lowest score
 * still needs everything its review needs: every exception dispositioned on its own, the audit-trail review and the QA
 * review before release. A score never closes, skips or shortens a review step.
 *
 * The record in review is the set-up CLI's review batch (--gmp-review-batch: two alerts sharing one deviation, an action
 * exception with its own, every act through the real server). TEST FIXTURE: two more records in the queue, copies of
 * its batch, state and family rows (written as the database owner with triggers off; no exception, deviation or act of
 * their own), and, for the lowest-score case, a REVIEW_PRIORITY run written as the analytics role through its own
 * record functions, as the runner writes one.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type ReviewSummaryView, type SignableAction } from '@ebmr/api-contract';
import type { AnalyticsRunnerApi } from '../../src/analytics/threaded.ts';
import { REVIEW_METHOD_DEFINITIONS } from '../../src/analytics/review.ts';
import { setupInstallation } from '../../src/cli/setup.ts';
import type { ReviewBatchSeed } from '../../src/cli/review-batch.ts';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { asAnalytics, releaseMethodVersion } from './support.ts';

const database = `ebmr_revprio_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-review-priority-'));
let server: TestServer;
let batch: ReviewBatchSeed;
let qa: TestBrowser;
let issuer: TestBrowser;
const copies: { id: string; number: string }[] = [];

const runner = (): AnalyticsRunnerApi => {
  const r = server.built.analytics;
  if (!r) throw new Error('the GMP server started without its analytics runner');
  return r;
};
const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.code ?? 'refused'));

/**
 * TEST FIXTURE: a record in the queue copied from the review batch (its family, MBR pin, control recipe, batch and state
 * rows under new ids), at EXECUTION_COMPLETE.
 */
async function copyRecord(number: string): Promise<string> {
  const [id, pin, cr] = [randomUUID(), randomUUID(), randomUUID()];
  const copy = (table: string, key: string, over: Record<string, unknown>) =>
    `insert into ${table} select (jsonb_populate_record(null::${table}, to_jsonb(t) || '${JSON.stringify(over).replace(/'/g, "''")}'::jsonb)).* from ${table} t where t.${key} = $1`;
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(copy('recipe.stub_batch', 'id', { id, batch_number: number }), [batch.batchId]);
    await c.query(copy('recipe.batch_mbr_pin', 'batch_id', { id: pin, batch_id: id }), [batch.batchId]);
    await c.query(copy('recipe.control_recipe', 'batch_id', { id: cr, batch_id: id, pin_id: pin }), [batch.batchId]);
    await c.query(copy('recipe.batch_execution', 'id', { id, batch_number: number, control_recipe_id: cr, issue_signature_id: randomUUID() }), [batch.batchId]);
    await c.query(copy('recipe.execution_state', 'batch_id', { batch_id: id, status: 'EXECUTION_COMPLETE' }), [batch.batchId]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  return id;
}

/**
 * A REVIEW.PRIORITY run with the given scores (and, per record, its own reasons and values), written as the analytics
 * role through its record functions.
 */
async function scoredRun(scores: Record<string, number>, own: Record<string, { reasons: unknown[]; values: Record<string, unknown> }> = {}): Promise<string> {
  const inputs = [{ view: 'report.review_fact_v1', version: 1, filter: null, data_as_of: new Date().toISOString(), rows: Object.keys(scores).length, sha256: 'a'.repeat(64) }];
  const runtime = { package: '@ebmr/analytics 0.1.0', commit: 'test', node: process.version, libraries: {} };
  const [r] = await asAnalytics<{ id: string }>(server, "select analytics.begin_run('REVIEW.PRIORITY', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb)::text as id", [JSON.stringify(inputs), JSON.stringify(runtime)]);
  for (const [batchId, score] of Object.entries(scores)) {
    const reasons = own[batchId]?.reasons ?? (score === 0 ? [] : [{ code: 'DEVIATION', text: `${String(score / 4)} linked deviations (4 points each)`, weight: score }]);
    const values = own[batchId]?.values ?? { score };
    await asAnalytics(server, "select analytics.record_output($1, 'BATCH', $2, 'REVIEW_PRIORITY', $3::jsonb, $4::jsonb)", [r!.id, batchId, JSON.stringify(values), JSON.stringify(reasons)]);
  }
  await asAnalytics(server, "select analytics.finish_run($1, $2, '{}')", [r!.id, 'b'.repeat(64)]);
  return r!.id;
}

const queueOf = async (who: TestBrowser) => valueOf(await who.call(routes.review.queue, { query: {} }));
const ids = (bs: readonly ReviewSummaryView[]): string[] => bs.map((b) => b.batchId).sort();
const mine = (bs: readonly ReviewSummaryView[]): ReviewSummaryView[] => bs.filter((b) => [batch.batchId, ...copies.map((c) => c.id)].includes(b.batchId));

beforeAll(async () => {
  const keysDir = join(dir, 'keys');
  const seed = await setupInstallation({ installation: 'GMP', database, keysDir, exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, reviewBatch: true, log: () => undefined });
  batch = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as ReviewBatchSeed;
  server = await startServer('GMP', {
    prepared: { database, seed }, env: { EBMR_SEAL_KEY_FILE: join(keysDir, 'gmp-seal-key.json'), EBMR_ANALYTICS: 'on' }, analytics: { pollMs: 3_600_000 },
  });
  for (const n of ['RPX-0001', 'RPX-0002']) copies.push({ id: await copyRecord(n), number: n });
  [qa, issuer] = await Promise.all([server.asPersona('qaInvestigator'), server.asPersona('issuer')]);
  // QA's version 1 of the method, in force as the release writes it (the methods route under a change record is proven
  // in routes.test.ts and spc.test.ts).
  const v1 = REVIEW_METHOD_DEFINITIONS[0]!;
  await releaseMethodVersion(server, v1.method, 1, { parameters: v1.parameters });
}, 900_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the review priority orders the review queue and never skips a review (GMP; REVIEW.PRIORITY)', () => {
  it('[PR-61] the review queue lists the same records with scores, without scores and with the runner down', async () => {
    // Before any run: the records, none scored, ordered as the priority orders an unscored queue.
    const before = await queueOf(qa);
    const set = ids(before.batches);
    expect(set).toEqual(expect.arrayContaining([batch.batchId, ...copies.map((c) => c.id)]));
    expect(before.ordering).toMatchObject({ by: 'REVIEW_PRIORITY', advisory: true, notForGmpDecisions: true, dataAgeSeconds: null });
    expect(mine(before.batches).every((b) => b.priority === null)).toBe(true);

    // The runner scores every record in the queue; the queue lists the same records, each with its score and reasons.
    const reports = await runner().runAll('ON_DEMAND');
    expect(reports.find((r) => r.method === 'REVIEW.PRIORITY'), JSON.stringify(reports)).toMatchObject({ status: 'DONE', version: 1 });
    const scored = await queueOf(qa);
    expect(ids(scored.batches)).toEqual(set);
    expect(scored.ordering).toMatchObject({ by: 'REVIEW_PRIORITY', advisory: true });
    expect(scored.ordering?.dataAgeSeconds).not.toBeNull();
    const real = scored.batches.find((b) => b.batchId === batch.batchId)!;
    // The review batch: two alerts (minor, 1 each), one action exception (major, 3) and two linked deviations (4 each).
    expect(real.priority).toMatchObject({ methodVersion: { id: 'REVIEW.PRIORITY', version: 1 } });
    expect(real.priority!.score).toBeGreaterThanOrEqual(13);
    expect(real.priority!.reasons).toHaveLength(3);
    expect(real.priority!.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['DEVIATION', 'EXCEPTION_MAJOR']));
    expect(real.priority!.reasons[0]).toMatchObject({ code: 'DEVIATION', weight: 8, text: '2 linked deviations (4 points each)' });
    // The highest score leads the scored records (the copies have no exception or deviation of their own).
    const waiting = mine(scored.batches);
    expect(waiting[0]!.batchId).toBe(batch.batchId);
    for (const c of copies) expect(scored.batches.find((b) => b.batchId === c.id)!.priority!.score).toBeLessThan(real.priority!.score);
    // The one-record route shows the same priority under the advisory envelope.
    const one = valueOf(await qa.call(routes.analyticsReview.priority, { params: { batchId: batch.batchId } }));
    expect(one).toMatchObject({ advisory: true, notForGmpDecisions: true, method: { id: 'REVIEW.PRIORITY', version: 1 }, batchId: batch.batchId, priority: real.priority });

    // The runner stopped, and a later run failed: the queue lists the same records with the last completed scores.
    await runner().stop();
    const [failed] = await asAnalytics<{ id: string }>(server, "select analytics.begin_run('REVIEW.PRIORITY', 1, null, 'ON_DEMAND', $1::jsonb, '{\"package\": \"@ebmr/analytics 0.1.0\", \"commit\": \"test\", \"node\": \"v22\", \"libraries\": {}}'::jsonb)::text as id",
      [JSON.stringify([{ view: 'report.review_fact_v1', version: 1, filter: null, data_as_of: new Date().toISOString(), rows: 0, sha256: 'c'.repeat(64) }])]);
    await asAnalytics(server, "select analytics.record_output($1, 'BATCH', $2, 'REVIEW_PRIORITY', '{\"score\": 999}', '[]')", [failed!.id, batch.batchId]);
    await asAnalytics(server, "select analytics.fail_run($1, 'stopped on purpose')", [failed!.id]);
    const down = await queueOf(qa);
    expect(ids(down.batches)).toEqual(set);
    expect(down.batches.find((b) => b.batchId === batch.batchId)!.priority).toEqual(real.priority);

    // The priority unreadable (the view's grant withdrawn in this test's own database): the same records, unordered by it.
    await server.db.admin.query('revoke select on analytics.review_priority_v1 from ebmr_app');
    try {
      const unreadable = await queueOf(qa);
      expect(ids(unreadable.batches)).toEqual(set);
      expect(unreadable.ordering).toMatchObject({ by: 'BATCH_NUMBER', advisory: false });
      expect(unreadable.batches.every((b) => b.priority === undefined)).toBe(true);
    } finally {
      await server.db.admin.query('grant select on analytics.review_priority_v1 to ebmr_app');
    }

    // A person without ANALYTICS.VIEW sees the same records in batch-number order, without the priority.
    const plain = await queueOf(issuer);
    expect(ids(plain.batches)).toEqual(set);
    expect(plain.ordering).toMatchObject({ by: 'BATCH_NUMBER' });
    expect(plain.batches.every((b) => b.priority === undefined)).toBe(true);
    expect(plain.batches.map((b) => b.batchNumber)).toEqual([...plain.batches.map((b) => b.batchNumber)].sort());
  }, 600_000);

  it('[PR-61] an unscored record is listed first', async () => {
    const late = { id: await copyRecord('RPX-0003'), number: 'RPX-0003' };
    copies.push(late);
    const q = await queueOf(qa);
    const waiting = q.batches.filter((b) => b.reviewState !== 'QA_REVIEWED');
    expect(waiting[0]).toMatchObject({ batchId: late.id, priority: null });
    // Every unscored record comes before every scored one.
    const firstScored = waiting.findIndex((b) => b.priority !== null);
    expect(waiting.slice(firstScored).every((b) => b.priority !== null)).toBe(true);
    // The one-record route says it is not scored.
    expect(valueOf(await qa.call(routes.analyticsReview.priority, { params: { batchId: late.id } }))).toMatchObject({ advisory: true, method: null, run: null, priority: null });
    // A batch id that is no GMP record answers 404.
    expect(refusalOf(await qa.call(routes.analyticsReview.priority, { params: { batchId: randomUUID() } })).code).toBe('EBMR-ANA-040');
    // Without ANALYTICS.VIEW the route is refused by the database.
    expect(refusalOf(await issuer.call(routes.analyticsReview.priority, { params: { batchId: batch.batchId } })).code).toMatch(/EBMR-IAM-040/);
  }, 300_000);

  it('[PR-61] a record with the lowest score still needs the full review and the audit-trail review before release', async () => {
    const B = batch.batchId;
    const head = await server.asPersona('head1');
    const view = async () => valueOf(await qa.call(routes.review.batch, { params: { batchId: B } }));
    const trail = async () => valueOf(await qa.call(routes.review.auditTrail, { params: { batchId: B }, query: {} }));
    const [viewBefore, trailBefore] = [await view(), await trail()];
    // The record in review gets the lowest score of the queue (0), the others more.
    await scoredRun({ [B]: 0, ...Object.fromEntries(copies.map((c) => [c.id, 12])) });
    const q = await queueOf(qa);
    const waiting = q.batches.filter((b) => b.reviewState !== 'QA_REVIEWED' && b.priority !== null);
    expect(waiting[waiting.length - 1]).toMatchObject({ batchId: B, priority: { score: 0, reasons: [] } });
    // A score never closes, skips or shortens a review step: the record's state, acts, gates and the audit-trail review
    // it must sign are exactly as before.
    const [viewAfter, trailAfter] = [await view(), await trail()];
    expect(viewAfter.reviewState).toBe(viewBefore.reviewState);
    expect(viewAfter.acts).toEqual(viewBefore.acts);
    expect(viewAfter.gates).toEqual(viewBefore.gates);
    expect({ ...trailAfter, generatedAt: null }).toMatchObject({ reviewId: trailBefore.reviewId, kind: trailBefore.kind, eventCount: trailBefore.eventCount, covered: false });
    expect(trailAfter.reportHash).toBe(trailBefore.reportHash);
    // The QA review is not open before production's approval and the audit-trail review; the audit-trail review is due.
    expect(viewAfter.gates.qaReview.ready).toBe(false);
    expect(codeOf(await signAction(server, qa, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: B, input: { expectedEpoch: viewAfter.epoch } }))).not.toBe('ok');
    valueOf(await signAction(server, head, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: B, input: {} }));
    const approved = await view();
    expect(approved.reviewState).toBe('PRODUCTION_APPROVED');
    expect(approved.gates.qaReview.ready).toBe(false);
    expect(approved.gates.qaReview.problems.join(' ')).toMatch(/audit/i);
    // Release needs the QA review: no lot of the record is releasable while it is not QA_REVIEWED.
    const { rows } = await server.db.admin.query<{ s: string }>('select recipe.batch_review_state($1) as s', [B]);
    expect(rows[0]!.s).not.toBe('QA_REVIEWED');
  }, 600_000);

  it('[PR-52] every exception of a low-priority record is still dispositioned individually', async () => {
    const B = batch.batchId;
    const q = await queueOf(qa);
    expect(q.batches.find((b) => b.batchId === B)!.priority).toMatchObject({ score: 0 });
    const items = (ids2: string[], justification: string): SignableAction => ({ kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: B, input: { items: ids2, disposition: 'ACCEPT', justification } });
    // The register lists every exception of the record, each with its own status, whatever its priority.
    const shown = valueOf(await qa.call(routes.review.register, { params: { batchId: B }, body: {} }));
    expect(shown.items.map((i) => i.exceptionId).sort()).toEqual(['EX-1', 'EX-2', 'EX-3']);
    expect(shown.items.every((i) => i.reviewStatus !== 'ACCEPTED')).toBe(true);
    // Grouped acceptance of the two alerts sharing a deviation gives one disposition row per item; the third stays open.
    valueOf(await signAction(server, qa, 'qaInvestigator', items(['EX-1', 'EX-2'], 'Both alerts were corrected at the booth before any material was handled; no impact on the batch.')));
    const after = valueOf(await qa.call(routes.review.register, { params: { batchId: B }, body: {} }));
    expect(after.items.filter((i) => i.reviewStatus === 'ACCEPTED').map((i) => i.exceptionId).sort()).toEqual(['EX-1', 'EX-2']);
    expect(after.items.find((i) => i.exceptionId === 'EX-3')!.reviewStatus).not.toBe('ACCEPTED');
    const { rows } = await server.db.admin.query<{ exception_id: string }>('select exception_id from recipe.review_item_disposition where batch_id = $1 order by exception_id', [B]);
    expect(rows.map((r) => r.exception_id)).toEqual(['EX-1', 'EX-2']);
    // The QA review still waits for the open item.
    const v = valueOf(await qa.call(routes.review.batch, { params: { batchId: B } }));
    expect(v.gates.qaReview.ready).toBe(false);
  }, 300_000);

  it('[DI-53][PR-61] the audit-trail term of a score is shown only to data-integrity review; anyone else sees and is ordered by the score without it', async () => {
    const di = await loginOf(server, await grantedPerson(server, 'CSV_DI_LEAD', 'Lata Krishnan (DI lead)'));
    const C = copies[0]!.id;
    const audit = { code: 'OPEN_AUDIT_FLAG', text: "1 audit-trail rule hit on this record's entries (3 points each; the details are for data-integrity review)", weight: 3 };
    const deviation = { code: 'DEVIATION', text: '1 linked deviation (4 points each)', weight: 4 };
    await scoredRun({ [C]: 7 }, { [C]: { reasons: [deviation, audit], values: { score: 7, 'OPEN_AUDIT_FLAG.count': 1, 'OPEN_AUDIT_FLAG.points': 3, 'DEVIATION.points': 4 } } });
    // QA (no ANALYTICS.DI_REVIEW): the score without the audit-trail term, and no reason or word of it.
    const forQa = (await queueOf(qa)).batches.find((b) => b.batchId === C)!;
    expect(forQa.priority).toMatchObject({ score: 4, reasons: [deviation] });
    expect(JSON.stringify(forQa)).not.toMatch(/audit-trail|OPEN_AUDIT_FLAG/);
    expect(valueOf(await qa.call(routes.analyticsReview.priority, { params: { batchId: C } })).priority).toMatchObject({ score: 4, reasons: [deviation] });
    // The data-integrity lead: the full score and both reasons.
    const forDi = (await queueOf(di)).batches.find((b) => b.batchId === C)!;
    expect(forDi.priority).toMatchObject({ score: 7, reasons: [deviation, audit] });
    expect(valueOf(await di.call(routes.analyticsReview.priority, { params: { batchId: C } })).priority).toMatchObject({ score: 7, reasons: [deviation, audit] });
    // Either way the same records are listed.
    expect(ids((await queueOf(di)).batches)).toEqual(ids((await queueOf(qa)).batches));
  }, 300_000);
});
