/**
 * The periodic evaluation pack of the system and its readability report (Phase 7 slice 7b-2; DI-11 clause 1, DI-44
 * clause 1; kernel 1335, 1336).
 *
 * For a period that has ended, the pack lists every entry of every registered topic (changes and configuration changes,
 * deviations and incidents, audit-trail reviews, access recertifications, backups and restore drills, integration
 * alarms, time-sync events, integrity checks, open issues), each naming its source log and row, read through the
 * reporting path (the read-only role ebmr_report: report.evaluation_topic_v1, report.evaluation_period_rows_v1). Its
 * readability report takes the seeded sample of the records closed before the period's end
 * (report.readability_sample_rows_v1): each sampled record's archive package is read (records.full_export_snapshot),
 * verified with the true-copy verifier, rendered as a PDF/A-3 true copy with its audit trail (and its signature chain
 * with the manifestations), and the rendering read back and verified; the result and the render SHA-256 are listed per
 * record.
 *
 * The pack is one JSON text; its SHA-256 is the pack hash. records.store_evaluation_pack recomputes the hash and checks
 * the pack against the source logs and the seeded sample before it stores it; QA then signs it off
 * (PERIODIC_EVALUATION_APPROVED over the pack's signed content, which carries the hash; records.approve_evaluation_pack).
 * The selection and layout are the generator's; the storage, the check against the sources and the sign-off are the
 * database's.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { toDbContext, type ActorContext } from '../db/command.ts';
import { renderTrueCopyPdf, verifyTrueCopyPdf } from './pdf-true-copy.ts';
import { trueCopyBundleOfParts, type SnapshotJson } from './qp-package.ts';
import { serializeBundle, verifyTrueCopyBundleText, type RecordsPart } from './true-copy.ts';

export const EVALUATION_PACK_FORMAT = 'ebmr.periodic-evaluation/1';
export const EVALUATION_PACK_AGGREGATE = 'evaluation_pack';
export const EVALUATION_PACK_MEANING = 'PERIODIC_EVALUATION_APPROVED';
/** The readability sample's default and minimum size (the database refuses fewer than 10, or than every closed record when fewer are closed). */
export const DEFAULT_READABILITY_SAMPLE = 10;

/** A reader on the reporting path: a connection logged in as ebmr_report (or a session in that role). */
export interface ReportReader {
  query<R extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface EvaluationEntry {
  sourceLog: string;
  sourceRow: string;
  occurredAt: string;
  endedAt: string | null;
  summary: Record<string, unknown>;
}

export interface EvaluationTopic {
  topic: string;
  sources: { sourceLog: string; selection: 'IN_PERIOD' | 'OPEN_AT_END'; description: string }[];
  entries: EvaluationEntry[];
}

export interface ReadabilityChain {
  chainKey: string;
  events: number;
  rows: number;
  headSeq: string | null;
  manifestSha256: string;
  pdfSha256: string | null;
  problems: string[];
}

export interface ReadabilityRecord {
  rank: number;
  recordType: string;
  recordId: string;
  label: string;
  closedAt: string;
  sampleKey: string;
  result: 'READABLE' | 'UNREADABLE';
  /** SHA-256 over `<chain key> <PDF SHA-256>` lines of every rendered chain; null when a chain could not be rendered. */
  renderSha256: string | null;
  auditEvents: number;
  signatures: number;
  chains: ReadabilityChain[];
}

export interface EvaluationPack {
  format: string;
  period: { from: string; to: string };
  generatedAt: string;
  readThrough: 'ebmr_report';
  topics: EvaluationTopic[];
  readability: { seed: string; sampleSize: number; closedBefore: string; records: ReadabilityRecord[] };
  summary: { entries: number; perTopic: { topic: string; entries: number }[]; sampled: number; unreadable: number };
}

const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
const UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** A time as the database writes it in UTC with microseconds (the pack's form of every time). */
async function utc(db: Pick<pg.PoolClient, 'query'>, at: string): Promise<string> {
  const { rows } = await db.query<{ t: string }>(`select to_char($1::timestamptz at time zone 'UTC', ${UTC}) as t`, [at]);
  return rows[0]?.t ?? '';
}

/** The topics and the period's entries, read through the reporting path. */
async function readTopics(report: ReportReader, from: string, to: string): Promise<EvaluationTopic[]> {
  const { rows: sources } = await report.query<{ topic: string; source_log: string; selection: 'IN_PERIOD' | 'OPEN_AT_END'; description: string }>(
    'select topic, source_log, selection, description from report.evaluation_topic_v1 order by topic collate "C", source_log collate "C"',
  );
  const { rows: entries } = await report.query<{ topic: string; source_log: string; source_row: string; occurred_at: string; ended_at: string | null; summary: Record<string, unknown> }>(
    `select topic, source_log, source_row, to_char(occurred_at at time zone 'UTC', ${UTC}) as occurred_at,
            to_char(ended_at at time zone 'UTC', ${UTC}) as ended_at, summary
       from report.evaluation_period_rows_v1($1::timestamptz, $2::timestamptz)`,
    [from, to],
  );
  const topics = new Map<string, EvaluationTopic>();
  for (const s of sources) {
    const t = topics.get(s.topic) ?? { topic: s.topic, sources: [], entries: [] };
    t.sources.push({ sourceLog: s.source_log, selection: s.selection, description: s.description });
    topics.set(s.topic, t);
  }
  for (const e of entries) {
    topics.get(e.topic)?.entries.push({ sourceLog: e.source_log, sourceRow: e.source_row, occurredAt: e.occurred_at, endedAt: e.ended_at, summary: e.summary });
  }
  return [...topics.values()];
}

interface ReadabilityJson {
  recordType: string;
  recordId: string;
  label: string;
  chains: { chainKey: string; kind: 'RECORD' | 'SIGNATURE'; snapshot: SnapshotJson }[];
}

/**
 * Opens, verifies and renders one sampled record (its chains and signature chains) through the app path
 * (records.readability_snapshot: the sample's record of that rank, with RECORD.EXPORT and, for controlled records,
 * CONTROLLED.READ).
 */
async function readRecord(
  client: pg.PoolClient,
  sample: { seed: string; closedBefore: string; size: number },
  s: { rank: number; record_type: string; record_id: string; label: string; closed_at: string; sample_key: string },
): Promise<ReadabilityRecord> {
  const { rows } = await client.query<{ r: ReadabilityJson }>('select records.readability_snapshot($1, $2::timestamptz, $3, $4) as r', [sample.seed, sample.closedBefore, sample.size, s.rank]);
  const opened = rows[0]?.r;
  const chains: ReadabilityChain[] = [];
  let auditEvents = 0;
  let signatures = 0;
  for (const e of opened?.chains ?? []) {
    const bundle = trueCopyBundleOfParts(e.chainKey, e.snapshot);
    const report = verifyTrueCopyBundleText(serializeBundle(bundle));
    const problems = [...report.problems];
    let pdfSha256: string | null = null;
    try {
      const pdf = await renderTrueCopyPdf(bundle, { title: `Readability check of ${s.label}`, label: s.label });
      const back = await verifyTrueCopyPdf(pdf.pdf, bundle);
      problems.push(...back.problems.map((p) => `rendering: ${p}`));
      pdfSha256 = pdf.pdfSha256;
    } catch (error) {
      problems.push(`rendering: ${(error as Error).message}`);
    }
    auditEvents += report.summary.events;
    if (e.kind === 'SIGNATURE') {
      const records = JSON.parse(bundle.parts['records.json'] ?? '{"tables": []}') as RecordsPart;
      signatures += records.tables.filter((t) => t.table === 'esig.signature').reduce((n, t) => n + t.rows.length, 0);
    }
    chains.push({ chainKey: e.chainKey, events: report.summary.events, rows: report.summary.rows, headSeq: report.summary.headSeq, manifestSha256: bundle.manifestSha256, pdfSha256, problems });
  }
  const readable = chains.length > 0 && chains.every((c) => c.problems.length === 0 && c.pdfSha256 !== null);
  return {
    rank: s.rank,
    recordType: s.record_type,
    recordId: s.record_id,
    label: s.label,
    closedAt: s.closed_at,
    sampleKey: s.sample_key,
    result: readable ? 'READABLE' : 'UNREADABLE',
    renderSha256: readable ? sha256Hex(chains.map((c) => `${c.chainKey} ${c.pdfSha256 ?? ''}\n`).join('')) : null,
    auditEvents,
    signatures,
    chains,
  };
}

/** The pack text: canonical-enough JSON (two-space indentation, a final newline); its SHA-256 is the pack hash. */
export function serializeEvaluationPack(pack: EvaluationPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/**
 * Generates and stores the pack of `period` as `ctx` (holding VALIDATION.MANAGE and RECORD.EXPORT, e.g. the CSV / DI
 * lead): the entries through `report` (ebmr_report), the readability sample's records through `app` in one command that
 * also stores the pack. Returns the stored pack's id, its SHA-256, its text and the pack itself.
 */
export async function runPeriodicEvaluation(
  report: ReportReader,
  app: pg.Pool,
  ctx: ActorContext,
  input: { from: string; to: string; seed: string; sampleSize?: number },
): Promise<{ packId: string; packSha256: string; text: string; pack: EvaluationPack }> {
  const client = await app.connect();
  try {
    await client.query('begin isolation level repeatable read');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const from = await utc(client, input.from);
    const to = await utc(client, input.to);
    const sampleSize = input.sampleSize ?? DEFAULT_READABILITY_SAMPLE;
    // The entries and the sample are read through the reporting path only: a reader in any other role is refused.
    const reader = (await report.query<{ u: string }>('select current_user::text as u')).rows[0]?.u;
    if (reader !== 'ebmr_report') throw new Error(`EBMR-REC-160 the evaluation is read through the reporting role ebmr_report, not ${reader ?? 'an unknown role'} (DI-11)`);
    const topics = await readTopics(report, from, to);
    const { rows: sample } = await report.query<{ rank: number; record_type: string; record_id: string; label: string; closed_at: string; sample_key: string }>(
      `select rank, record_type, record_id, label, to_char(closed_at at time zone 'UTC', ${UTC}) as closed_at, sample_key
         from report.readability_sample_rows_v1($1, $2::timestamptz, $3) order by rank`,
      [input.seed, to, sampleSize],
    );
    const records: ReadabilityRecord[] = [];
    for (const s of sample) records.push(await readRecord(client, { seed: input.seed, closedBefore: to, size: sampleSize }, s));
    const generatedAt = (await client.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', ${UTC}) as t`)).rows[0]?.t ?? '';
    const pack: EvaluationPack = {
      format: EVALUATION_PACK_FORMAT,
      period: { from, to },
      generatedAt,
      readThrough: 'ebmr_report',
      topics,
      readability: { seed: input.seed, sampleSize, closedBefore: to, records },
      summary: {
        entries: topics.reduce((n, t) => n + t.entries.length, 0),
        perTopic: topics.map((t) => ({ topic: t.topic, entries: t.entries.length })),
        sampled: records.length,
        unreadable: records.filter((r) => r.result === 'UNREADABLE').length,
      },
    };
    const text = serializeEvaluationPack(pack);
    const packSha256 = sha256Hex(text);
    const packId = await storeEvaluationPack(client, text, packSha256);
    await client.query('commit');
    return { packId, packSha256, text, pack };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Stores a pack (records.store_evaluation_pack: the database checks it against the source logs); call inside a command. */
export async function storeEvaluationPack(db: pg.Pool | pg.PoolClient, text: string, packSha256: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.store_evaluation_pack($1, $2) as id', [text, packSha256]);
  const id = rows[0]?.id;
  if (!id) throw new Error('EBMR-REC-152 the evaluation pack was not stored');
  return id;
}

/** QA's sign-off of a stored pack with their own PERIODIC_EVALUATION_APPROVED signature; call inside withCommand. */
export async function approveEvaluationPack(db: pg.Pool | pg.PoolClient, packId: string, signatureId: string): Promise<void> {
  await db.query('select records.approve_evaluation_pack($1, $2)', [packId, signatureId]);
}

export interface StoredEvaluationPack {
  id: string;
  packSha256: string;
  text: string;
  periodFrom: Date;
  periodTo: Date;
  entryCount: number;
  sampleCount: number;
  unreadableCount: number;
  /** The readability sample's seed and size, stored and signed with the pack. */
  readabilitySeed: string;
  sampleSize: number;
  generatedByPerson: string;
  approval: { signatureId: string; approvedByPerson: string; recordedAt: Date } | null;
}

/** A stored pack with its sign-off (null until QA signed it off). */
export async function evaluationPack(db: pg.Pool | pg.PoolClient, packId: string): Promise<StoredEvaluationPack | undefined> {
  const { rows } = await db.query<{
    id: string; pack_sha256: string; pack: string; period_from: Date; period_to: Date; entry_count: number; sample_count: number; unreadable_count: number;
    readability_seed: string; sample_size: number; generated_by_person: string; approved_signature: string | null; approved_by_person: string | null; approved_at: Date | null;
  }>(
    `select p.id::text, p.pack_sha256, p.pack, p.period_from, p.period_to, p.entry_count, p.sample_count, p.unreadable_count, p.readability_seed, p.sample_size, p.generated_by_person::text,
            a.approved_signature::text, a.approved_by_person::text, a.recorded_at as approved_at
       from records.evaluation_pack p left join records.evaluation_pack_approval a on a.pack_id = p.id where p.id = $1`,
    [packId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    packSha256: r.pack_sha256,
    text: r.pack,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    entryCount: r.entry_count,
    sampleCount: r.sample_count,
    unreadableCount: r.unreadable_count,
    readabilitySeed: r.readability_seed,
    sampleSize: r.sample_size,
    generatedByPerson: r.generated_by_person,
    approval: r.approved_signature && r.approved_by_person && r.approved_at ? { signatureId: r.approved_signature, approvedByPerson: r.approved_by_person, recordedAt: r.approved_at } : null,
  };
}
