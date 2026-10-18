/**
 * The periodic evaluation pack of the system and its readability report (kernel 1336, site-services 1120, recipe-core
 * 1240; Phase 7 slice 7b-2; DI-11 clause 1, DI-44 clause 1).
 *
 * The pack of a test period is generated through the reporting path (ebmr_report) and stored; 5 sampled entries of each
 * topic are traced back to their source logs. The database stores a pack only with its SHA-256 and only when its entries
 * are exactly the source logs' entries of an ended period and its readability report exactly the seeded sample; QA
 * signs it off with a signature bound to that hash. The source-log rows of the topics are fixtures written by the
 * superuser with triggers off (each act is proven where it is built); incidents, investigations and signatures are real
 * acts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { contentForSigning } from '../../src/esig/signing.ts';
import {
  approveEvaluationPack,
  evaluationPack,
  runPeriodicEvaluation,
  serializeEvaluationPack,
  storeEvaluationPack,
  type EvaluationPack,
} from '../../src/records/evaluation-pack.ts';
import { seedAdministration, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { ExportWorld } from './export-world.ts';
import { again, inSecondRole, signerActor, testActor } from './helpers.ts';

let db: TestDatabase;
let w: ExportWorld;
let from: string;
let to: string;
let beforePeriod: string;
let closed: string[];
let investigation: { id: string; signatureId: string };
let stored: { packId: string; packSha256: string; text: string; pack: EvaluationPack };

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const SEED = 'evaluation 2026-Q3';

/** A source-log row written by the superuser with triggers off (fixture). */
async function fixture(sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
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

const hex = () => sha(randomUUID());
const changeRecord = (n: string) =>
  fixture("insert into platform.change_record (number, title, description, areas, raised_by_person, raised_by_account) values ($1, 'Evaluation fixture change', 'a change', '{SYSTEM_DESCRIPTION}', $2, $2)", [n, randomUUID()]);

/** Five rows of every topic's source logs (and more incidents through the real acts). */
async function fiveOfEach(): Promise<void> {
  for (let i = 1; i <= 5; i++) {
    const who = randomUUID();
    const serial = 100000 + Math.floor(Math.random() * 800000);
    await changeRecord(`CR-EVAL-${randomUUID().slice(0, 8)}`);
    await fixture("insert into recipe.change_record (number, title, change_class, process_impacting, recorded_by_person, recorded_by_account) values ($1, 'MBR change', 'MINOR', false, $2, $2)", [`MCR-${randomUUID().slice(0, 8)}`, who]);
    await fixture("insert into platform.config_version (area, item_key, value, valid_from, source_row, basis, person_id) values ('EVALUATION_FIXTURE', $1, '{}', clock_timestamp(), '{}', 'BEFORE_CONTROL', $2)", [`item-${i}`, who]);
    await fixture("insert into iam.access_recertification (account_id, reviewer_person, reviewer_account, outcome, comment, grants_reviewed, next_due_at) values ($1, $1, $1, 'CONFIRMED', 'still needed', '{}', clock_timestamp() + interval '180 days')", [who]);
    await fixture(
      `insert into continuity.backup_job_run (job_name, tier, status, backup_id, started_at, finished_at, report_sha256, recorded_by_person_id, recorded_by_account_id, correlation_id)
       values ('nightly', 'RETENTION_GRADE', 'SUCCEEDED', $1, clock_timestamp() - interval '1 hour', clock_timestamp(), $2, $3, $3, $3)`, [`bk-${i}-${randomUUID()}`, hex(), who]);
    await fixture(
      `insert into continuity.restore_drill (drill_id, source_database, restored_database, backup_sha256, result, tables_compared, tables_matching, chains_verified, report_sha256, report_uri,
                                             started_at, finished_at, recorded_by_person_id, recorded_by_account_id, correlation_id)
       values ($1, 'gmp', 'gmp_restored', $2, 'PASS', 10, 10, 5, $2, 'file:///drills/report.json', clock_timestamp() - interval '1 hour', clock_timestamp(), $3, $3, $3)`, [`drill-${randomUUID()}`, hex(), who]);
    await fixture("insert into platform.integration_alarm (adapter_id, adapter_code, kind, severity) values ($1, 'ERP-1', 'SEQUENCE_GAP', 'MAJOR')", [who]);
    await fixture("insert into platform.time_anomaly (kind, aggregate_type, aggregate_id, aggregate_seq, event_recorded_at, previous_recorded_at) values ('CLOCK_REGRESSION', 'batch', $1, 2, clock_timestamp() - interval '1 second', clock_timestamp())", [who]);
    await fixture("insert into kernel.audit_verification_run (started_at, finished_at, chains_checked, problem_count, problems, run_by) values (clock_timestamp(), clock_timestamp(), 120, 0, '[]', 'nightly job')");
    await fixture(
      `insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id)
       values ($1, $2, 'SITE-1', 2026, $3, 'DEVIATION', 'Evaluation deviation', 'MINOR', 'low risk to product quality', $4, $4, $4)`,
      [randomUUID(), `DEV-SITE-1-2026-${serial}`, serial, who]);
    await fixture(
      `insert into recipe.batch_review_act (batch_id, cycle, act, signature_id, review_number, high_water, report_hash, person_id, account_id, role_code, correlation_id)
       values ($1, 1, 'AUDIT_TRAIL_REVIEWED', gen_random_uuid(), 1, '{"seq": 10}', $2, $3, $3, 'QA_REVIEWER', $3)`, [randomUUID(), hex(), who]);
  }
}

/** A pack text with `change` applied, and its SHA-256. */
function variant(change: (p: EvaluationPack) => void): { text: string; sha: string } {
  const p = JSON.parse(stored.text) as EvaluationPack;
  change(p);
  const text = serializeEvaluationPack(p);
  return { text, sha: sha(text) };
}
const store = (ctx: ActorContext, v: { text: string; sha: string }) => withCommand(db.app, again(ctx), (c) => storeEvaluationPack(c, v.text, v.sha));

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ExportWorld.create(db);
  await changeRecord('CR-BEFORE-PERIOD');
  beforePeriod = (await db.admin.query<{ id: string }>("select id::text from platform.change_record where number = 'CR-BEFORE-PERIOD'")).rows[0]!.id;
  from = await w.now();
  closed = [];
  for (let i = 0; i < 5; i++) closed.push(await w.closedIncident(`Closed incident ${i + 1}`));
  for (let i = 0; i < 5; i++) await w.openIncident(`Open incident ${i + 1}`);
  investigation = await w.closedInvestigation(w.edKey);
  for (let i = 0; i < 4; i++) await w.openInvestigation();
  await fiveOfEach();
  to = await w.now();
  stored = await runPeriodicEvaluation(w.report, db.app, again(w.lead), { from, to, seed: SEED, sampleSize: 4 });
}, 600_000);

afterAll(async () => {
  await db?.drop();
});

describe('the periodic evaluation pack (kernel 1336)', () => {
  it('[DI-11] the pack of a test period lists every topic, read through the reporting path, and 5 sampled entries per topic trace back to their source logs', async () => {
    const pack = stored.pack;
    expect(pack.readThrough).toBe('ebmr_report');
    const topics = pack.topics.map((t) => t.topic);
    expect(topics).toEqual([
      'ACCESS_RECERTIFICATION', 'AUDIT_TRAIL_REVIEW', 'BACKUP', 'CHANGE_RECORD', 'CONFIG_CHANGE', 'DEVIATION', 'INCIDENT', 'INTEGRATION_ALARM', 'INTEGRITY_CHECK',
      'OPEN_ISSUE', 'RESTORE_DRILL', 'TIME_SYNC',
    ]);
    for (const t of pack.topics) {
      expect(t.entries.length, t.topic).toBeGreaterThanOrEqual(5);
      // Five entries spread over the topic, each traced to its source log and row.
      const step = Math.floor(t.entries.length / 5);
      for (const e of [0, 1, 2, 3, 4].map((k) => t.entries[k * step]!)) {
        expect(t.sources.map((s) => s.sourceLog)).toContain(e.sourceLog);
        const { rows } = await db.admin.query<Record<string, unknown>>(`select to_jsonb(x) as r from ${e.sourceLog} x where x.id::text = $1`, [e.sourceRow]);
        expect(rows, `${t.topic} ${e.sourceLog} ${e.sourceRow}`).toHaveLength(1);
        const row = rows[0]!['r'] as Record<string, unknown>;
        if (t.topic !== 'OPEN_ISSUE') expect(Date.parse(e.occurredAt)).toBeGreaterThanOrEqual(Date.parse(from));
        expect(Date.parse(e.occurredAt)).toBeLessThan(Date.parse(to));
        if (e.sourceLog === 'records.incident') expect(e.summary['title']).toBe(row['title']);
        if (e.sourceLog === 'platform.change_record') expect(e.summary['number']).toBe(row['number']);
        if (e.sourceLog === 'site.deviation') expect(e.summary['ref']).toBe(row['ref']);
        if (e.sourceLog === 'recipe.batch_review_act') expect(e.summary['reportHash']).toBe(row['report_hash']);
        if (e.sourceLog === 'continuity.backup_job_run') expect(e.summary['backupId']).toBe(row['backup_id']);
        if (e.sourceLog === 'continuity.restore_drill') expect(e.summary['drill']).toBe(row['drill_id']);
      }
    }
    // The period's bounds hold: a change record raised before it is not in the pack; open issues are those still open.
    expect(pack.topics.find((t) => t.topic === 'CHANGE_RECORD')!.entries.map((e) => e.sourceRow)).not.toContain(beforePeriod);
    const openRows = pack.topics.find((t) => t.topic === 'OPEN_ISSUE')!.entries.map((e) => e.sourceRow);
    for (const c of closed) expect(openRows).not.toContain(c);
    expect(openRows).not.toContain(investigation.id);
    expect(pack.topics.find((t) => t.topic === 'OPEN_ISSUE')!.entries).toHaveLength(9);
    // The reporting role reads the views and nothing behind them, and stays within its segregation.
    await expect(w.report.query('select 1 from records.incident limit 1')).rejects.toThrow(/permission denied/);
    await expect(w.report.query('select report.evaluation_incidents()')).rejects.toThrow(/permission denied/);
    const { rows: problems } = await db.admin.query<{ p: string }>('select p from sandbox.segregation_problems() p');
    expect(problems.filter((r) => r.p.includes('ebmr_report'))).toEqual([]);
  });

  it('[DI-11] the pack is stored with its SHA-256, as generated; the database refuses a pack that is not the source logs\' entries of an ended period', async () => {
    const row = await evaluationPack(db.app, stored.packId);
    expect(row).toMatchObject({ packSha256: sha(stored.text), text: stored.text, generatedByPerson: w.lead.personId, sampleCount: 4, unreadableCount: 0, approval: null });
    expect(row!.entryCount).toBe(stored.pack.summary.entries);
    // A dropped entry, an invented one, a hash of other text, a period not over, a missing topic.
    await expect(store(w.lead, variant((p) => p.topics[0]!.entries.pop()))).rejects.toThrow(/EBMR-REC-155 .*1 missing, 0 not in the source logs/);
    await expect(store(w.lead, variant((p) => p.topics[1]!.entries.push({ ...p.topics[1]!.entries[0]!, sourceRow: randomUUID() })))).rejects.toThrow(/EBMR-REC-155 .*0 missing, 1 not in/);
    await expect(store(w.lead, variant((p) => p.topics[2]!.entries.push(p.topics[2]!.entries[0]!)))).rejects.toThrow(/EBMR-REC-155/);
    await expect(store(w.lead, { text: stored.text, sha: sha(`${stored.text}x`) })).rejects.toThrow(/EBMR-REC-152/);
    await expect(store(w.lead, variant((p) => { p.period.to = '2999-01-01T00:00:00.000000Z'; }))).rejects.toThrow(/EBMR-REC-153/);
    await expect(store(w.lead, variant((p) => { p.topics = p.topics.filter((t) => t.topic !== 'BACKUP'); }))).rejects.toThrow(/EBMR-REC-154/);
    await expect(store(w.lead, variant((p) => { p.format = 'other'; }))).rejects.toThrow(/EBMR-REC-152/);
    // The same pack again: refused (one row per pack hash).
    await expect(store(w.lead, { text: stored.text, sha: stored.packSha256 })).rejects.toThrow(/duplicate|unique/i);
    // Only VALIDATION.MANAGE stores; administrators never; a session alone never.
    const operator = await testActor(db, { roleCode: 'OPERATOR' });
    await expect(store(operator, variant((p) => { p.generatedAt = 'x'; }))).rejects.toThrow(/EBMR-IAM-040/);
    const { admin } = await seedAdministration(db);
    await expect(store(admin, variant((p) => { p.generatedAt = 'y'; }))).rejects.toThrow(/EBMR-IAM-04/);
    await expect(db.app.query('select records.store_evaluation_pack($1, $2)', [stored.text, stored.packSha256])).rejects.toThrow(/EBMR-/);
    // The stored pack cannot be changed, not even by the owner's triggers being bypassed by the application.
    await expect(db.app.query('update records.evaluation_pack set pack = $1 where id = $2', ['{}', stored.packId])).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('update records.evaluation_pack set pack = $1 where id = $2', ['{}', stored.packId])).rejects.toThrow(/EBMR-|not allowed|insert-only/i);
  });

  it('[DI-11] QA signs the pack off with their own signature bound to its hash; the generator, another role or another pack\'s signature cannot', async () => {
    const content = await contentForSigning(db.app, 'evaluation_pack', stored.packId);
    expect(content.state).toBe('STORED');
    // The signed content carries the pack's SHA-256, so the signature's content hash binds that pack.
    expect(content.canonical).toContain(`"pack_sha256":"${stored.packSha256}"`);
    expect(content.contentHash).toBe(sha(content.canonical!));
    const aggregate = { type: 'evaluation_pack', id: stored.packId };
    // The person who generated the pack never signs it off, even in a QA role (INV-03).
    const leadAsQa = (await inSecondRole(db, w.lead, 'QA_REVIEWER')) as SeededActor;
    await expect(w.sign({ ...w.lead, ...leadAsQa, seed: w.lead.seed }, aggregate, 'PERIODIC_EVALUATION_APPROVED', 'STORED')).rejects.toThrow(/EBMR-ESIG-044/);
    const sig = await w.sign(w.qa, aggregate, 'PERIODIC_EVALUATION_APPROVED', 'STORED');
    const approve = (ctx: ActorContext, pack: string, signature: string | null) =>
      withCommand(db.app, again(ctx), (c) => approveEvaluationPack(c, pack, signature as string));
    const operator = await testActor(db, { roleCode: 'OPERATOR' });
    await expect(approve(operator, stored.packId, sig)).rejects.toThrow(/EBMR-IAM-040/);
    await expect(approve(w.lead, stored.packId, sig)).rejects.toThrow(/EBMR-IAM-040/);
    const { admin } = await seedAdministration(db);
    await expect(approve(admin, stored.packId, sig)).rejects.toThrow(/EBMR-IAM-04/);
    await expect(approve(w.qa, randomUUID(), sig)).rejects.toThrow(/EBMR-REC-158/);
    await expect(approve(w.qa, stored.packId, null)).rejects.toThrow(/EBMR-REC-159/);
    const qa2 = await signerActor(db, 'QA_REVIEWER', 'Second QA reviewer');
    await expect(approve(qa2, stored.packId, sig)).rejects.toThrow(/EBMR-REC-159/);
    // A signature of another pack does not sign this one off.
    const other = await runPeriodicEvaluation(w.report, db.app, again(w.lead), { from, to: await w.now(), seed: SEED, sampleSize: 2 });
    await expect(approve(w.qa, other.packId, sig)).rejects.toThrow(/EBMR-ESIG-070/);
    await approve(w.qa, stored.packId, sig);
    expect((await evaluationPack(db.app, stored.packId))!.approval).toMatchObject({ signatureId: sig, approvedByPerson: w.qa.personId });
    expect((await contentForSigning(db.app, 'evaluation_pack', stored.packId)).state).toBe('APPROVED');
    await expect(approve(w.qa, stored.packId, sig)).rejects.toThrow(/EBMR-REC-158/);
    await expect(db.app.query('insert into records.evaluation_pack_approval (pack_id, approved_signature, approved_by_person, approved_by_account) values ($1, $2, $3, $3)', [other.packId, randomUUID(), w.qa.personId])).rejects.toThrow(/permission denied/);
  });
});

describe('the periodic readability report (kernel 1335, 1336)', () => {
  it('[DI-44] the periodic readability report lists the seeded sample of closed records, each opened and rendered with its audit trail, with its result and render hash per record', async () => {
    const r = stored.pack.readability;
    const { rows: sample } = await w.report.query<{ record_type: string; record_id: string }>(
      'select record_type, record_id from report.readability_sample_rows_v1($1, $2::timestamptz, 4) order by rank', [SEED, to]);
    expect(r).toMatchObject({ seed: SEED, sampleSize: 4, closedBefore: stored.pack.period.to });
    expect(r.records.map((x) => `${x.recordType}:${x.recordId}`)).toEqual(sample.map((x) => `${x.record_type}:${x.record_id}`));
    expect(r.records.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
    for (const rec of r.records) {
      expect(rec.result, rec.label).toBe('READABLE');
      expect(rec.renderSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.auditEvents).toBeGreaterThan(0);
      expect(rec.chains[0]!.chainKey).toBe(`${rec.recordType}:${rec.recordId}`);
      for (const c of rec.chains) {
        expect(c.problems).toEqual([]);
        expect(c.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(rec.renderSha256).toBe(sha(rec.chains.map((c) => `${c.chainKey} ${c.pdfSha256}\n`).join('')));
    }
    // The investigation, when sampled, is read with its signature chain (the manifestation rendered with it).
    const all = await runPeriodicEvaluation(w.report, db.app, again(w.lead), { from, to, seed: `${SEED} (all)`, sampleSize: 100 });
    const inv = all.pack.readability.records.find((x) => x.recordId === investigation.id)!;
    expect(inv.chains.map((c) => c.chainKey)).toEqual([`di_investigation:${investigation.id}`, `esig_signature:di_investigation:${investigation.id}`]);
    expect(inv.signatures).toBe(1);
    // The same seed for the same period gives the same report, render hashes included.
    const again2 = await runPeriodicEvaluation(w.report, db.app, again(w.lead), { from, to, seed: SEED, sampleSize: 4 });
    expect(again2.pack.readability.records.map((x) => [x.recordId, x.renderSha256])).toEqual(r.records.map((x) => [x.recordId, x.renderSha256]));
    // The database stores only the seeded sample, each with its result.
    await expect(store(w.lead, variant((p) => p.readability.records.reverse()))).rejects.toThrow(/EBMR-REC-156/);
    await expect(store(w.lead, variant((p) => p.readability.records.pop()))).rejects.toThrow(/EBMR-REC-156/);
    await expect(store(w.lead, variant((p) => { p.readability.records[0]!.renderSha256 = null; }))).rejects.toThrow(/EBMR-REC-157/);
    await expect(store(w.lead, variant((p) => { (p.readability.records[0] as { result: string }).result = 'FINE'; }))).rejects.toThrow(/EBMR-REC-157/);
    await expect(store(w.lead, variant((p) => { p.readability.seed = 'another seed'; }))).rejects.toThrow(/EBMR-REC-156/);
  });

  it('[DI-44] a sampled record whose stored row was altered is reported UNREADABLE with the finding, and the pack records it', async () => {
    const victim = closed[0]!;
    await fixture("update records.incident set title = 'altered after closure' where id = $1", [victim]);
    const res = await runPeriodicEvaluation(w.report, db.app, again(w.lead), { from, to, seed: `${SEED} (corrupt)`, sampleSize: 100 });
    const rec = res.pack.readability.records.find((x) => x.recordId === victim)!;
    expect(rec.result).toBe('UNREADABLE');
    expect(rec.renderSha256).toBeNull();
    expect(rec.chains[0]!.problems.join('\n')).toMatch(/row differs from the hash recorded when it was inserted/);
    expect(res.pack.summary.unreadable).toBe(1);
    expect((await evaluationPack(db.app, res.packId))!.unreadableCount).toBe(1);
  });
});
