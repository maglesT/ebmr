/**
 * Retrieve and render a record (IN-09 clause 3, DI-46 clause 2): the PDF/A-3 true copy of an aggregate's chain, built
 * by the kernel's own code (records.trueCopyBundleFromSnapshot, records.renderTrueCopyPdf) from one snapshot of the
 * database, then checked complete: the PDF verifies, the bundle's offline verification finds no problem, every event of
 * the chain in the database is in it and no table the chain touched is left out.
 *
 * The drills read an isolated copy as its owner (the database superuser): records.true_copy_parts, the body of the
 * product's records.true_copy_snapshot without its permission check, which a drill on a closed copy has no session for.
 * The tests render through the archive route as a QA person as well ([IN-09], [DI-46]).
 */
import type pg from 'pg';
import { records } from '@ebmr/kernel';

export interface RenderedRecord {
  chainKey: string;
  contentSha256: string;
  pdfSha256: string;
  recordDate: string;
  events: number;
  eventsInDatabase: number;
  tables: number;
  rows: number;
  signatures: number;
  problems: string[];
}

/** A client whose snapshot query reads the parts as the owner (the permission check needs a session the drill has not). */
function asOwner(c: pg.Client): pg.PoolClient {
  const query = (text: string, values?: unknown[]) => c.query(text.replace('records.true_copy_snapshot($1)', 'records.true_copy_parts($1, null)'), values);
  return { query } as unknown as pg.PoolClient;
}

export async function renderRecord(c: pg.Client, chainKey: string): Promise<RenderedRecord> {
  await c.query('begin isolation level repeatable read read only');
  try {
    const bundle = await records.trueCopyBundleFromSnapshot(asOwner(c), chainKey);
    const inDb = await c.query<{ n: string }>('select count(*)::text as n from kernel.audit_event where chain_key = $1', [chainKey]);
    // The record's signatures: on the aggregate itself, or on its parts (a batch's issue, steps, stages and exceptions
    // are signed as batch_issue, batch_step ... with ids that start with the batch's id).
    const id = chainKey.slice(chainKey.indexOf(':') + 1);
    const sigs = await c.query<{ n: string }>(
      "select count(*)::text as n from esig.signature where aggregate_type || ':' || aggregate_id = $1 or aggregate_id = $2 or aggregate_id like $2 || ':%'",
      [chainKey, id],
    );
    await c.query('commit');
    const out = await records.renderTrueCopyPdf(bundle, { title: `True copy of ${chainKey}`, label: chainKey });
    const pdfCheck = await records.verifyTrueCopyPdf(out.pdf, bundle);
    const offline = records.verifyTrueCopyBundle(bundle);
    const recordsPart = JSON.parse(bundle.parts['records.json'] ?? '{}') as records.RecordsPart;
    const chain = JSON.parse(bundle.parts['audit-chain.json'] ?? '{}') as records.AuditChainPart;
    const omitted = records.omittedTables(recordsPart, chain);
    const eventsInDatabase = Number(inDb.rows[0]?.n ?? 0);
    const problems = [
      ...pdfCheck.problems.map((p) => `pdf: ${p}`),
      ...(offline.ok ? [] : offline.problems.map((p) => `bundle: ${p}`)),
      ...omitted.map((t) => `table ${t} of the chain is not in the copy`),
      ...(chain.events.length === eventsInDatabase ? [] : [`the copy holds ${String(chain.events.length)} of the chain's ${String(eventsInDatabase)} events`]),
    ];
    return {
      chainKey,
      contentSha256: out.contentSha256,
      pdfSha256: out.pdfSha256,
      recordDate: out.recordDate,
      events: chain.events.length,
      eventsInDatabase,
      tables: recordsPart.tables.length,
      rows: recordsPart.tables.reduce((n, t) => n + t.rows.length, 0),
      signatures: Number(sigs.rows[0]?.n ?? 0),
      problems,
    };
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** The kinds of record a drill renders, in this order: batch records, their reviews, masters and what releases rest on. */
export const RENDERED_KINDS = ['batch', 'batch_review', 'batch_audit_review', 'mbr_version', 'mbr_market_authorisation', 'manufacturing_licence', 'specification', 'deviation', 'material_lot'] as const;

/** Up to `limit` records of the kinds above, each kind's longest chains first. */
export async function recordsToRender(c: pg.Client, limit: number): Promise<string[]> {
  const { rows } = await c.query<{ chain_key: string }>(
    `select h.chain_key from kernel.audit_chain_head h
      where split_part(h.chain_key, ':', 1) = any ($2::text[])
      order by array_position($2::text[], split_part(h.chain_key, ':', 1)), h.last_seq desc, h.chain_key collate "C"
      limit $1`,
    [limit, RENDERED_KINDS],
  );
  return rows.map((r) => r.chain_key);
}
