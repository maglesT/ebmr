/**
 * The PDF/A-3 true copy of a record (Phase 4 slice 6b; D-6-4, D-P4-7; DI-41, DI-24 clause in the document, DI-40).
 *
 * From a true-copy bundle (true-copy.ts) the record's canonical content is taken: records.json (every row as stored,
 * with its SHA-256) and audit-chain.json (every audit event exactly as hashed). Both are embedded as associated files,
 * with content.json, which names the chain, its head and the SHA-256 of both parts. The content SHA-256 is the SHA-256
 * of content.json; it is in the document's metadata (Keywords) and on every page. The bundle's manifest and verification
 * part carry the time the copy was taken and are left out, so the same record content always renders to the same bytes;
 * the document date is the time of the chain's last audit event.
 *
 * The human-readable rendering shows every row as stored, then the changes after entry (UPDATE events with the original
 * and the new value, who changed it and the reason) and corrections and voids recorded as rows of their own, then the
 * audit trail. The DI-24 clause at the top says so.
 *
 * verifyTrueCopyPdf reads the associated files back and checks them with the kernel verifier (verifyChainPart,
 * verifyRecordsPart), recomputes the content SHA-256 and compares it with the metadata and, when given, with a bundle.
 */
import { createHash } from 'node:crypto';
import { contentKeyword, readPdfA3, renderPdfA3, type PdfaSection } from './pdfa.ts';
import { verifyChainPart, verifyRecordsPart, type AuditChainPart, type RecordsPart, type TrueCopyBundle } from './true-copy.ts';

export const PDF_TRUE_COPY_CONTENT_FORMAT = 'ebmr.true-copy-content/1';

export const DI24_CLAUSE =
  'Corrections, voids and deletions (DI-24): no entry of this record is ever overwritten or deleted. Every row is shown ' +
  'below exactly as stored. A correction or a void is a row of its own that names the entry it corrects, with the ' +
  'person who signed it and the reason; every later change of a stored row is listed under "Changes after entry" with ' +
  'its original value, the new value, the person and the reason. The audit trail closes the document.';

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

export interface TrueCopyContent {
  format: string;
  chainKey: string;
  aggregateType: string;
  aggregateId: string;
  head: { seq: string; hash: string } | null;
  recordDate: string;
  parts: { name: string; sha256: string; bytes: number }[];
}

/** The canonical content of a bundle: content.json text, its SHA-256 and the record date (last audit event). */
export function trueCopyContent(bundle: TrueCopyBundle): { text: string; sha256: string; content: TrueCopyContent; records: string; chain: string } {
  const records = bundle.parts['records.json'];
  const chain = bundle.parts['audit-chain.json'];
  if (records === undefined || chain === undefined) throw new Error('EBMR-REC-111 the bundle has no records or audit-chain part');
  const r = JSON.parse(records) as RecordsPart;
  const c = JSON.parse(chain) as AuditChainPart;
  const last = c.events[c.events.length - 1];
  if (!last) throw new Error(`EBMR-REC-111 ${r.chainKey} has no audit event: there is no record to render`);
  const content: TrueCopyContent = {
    format: PDF_TRUE_COPY_CONTENT_FORMAT,
    chainKey: r.chainKey,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    head: c.head,
    recordDate: last.recordedAt,
    parts: [
      { name: 'records.json', sha256: sha256(records), bytes: utf8(records) },
      { name: 'audit-chain.json', sha256: sha256(chain), bytes: utf8(chain) },
    ],
  };
  const text = JSON.stringify(content, null, 2);
  return { text, sha256: sha256(text), content, records, chain };
}

function flatten(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function rowLines(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [content];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [flatten(parsed)];
  return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => `${k}: ${v === null ? '(none)' : flatten(v)}`);
}

const CORRECTION = /CORRECT|VOID|AMEND|REPLAC/;

/** True when a stored row is a correction or a void of another entry (a row of its own, never an overwrite). */
function isCorrectionRow(content: string): boolean {
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    return ['command_type', 'kind', 'action', 'act', 'event_type'].some((k) => typeof o[k] === 'string' && CORRECTION.test(o[k]));
  } catch {
    return false;
  }
}

interface EventPayload {
  actor?: { legal_name?: string | null } | null;
  reason_code?: string | null;
  reason_text?: string | null;
  body?: { old?: Record<string, unknown> | null; new?: Record<string, unknown> | null } | null;
}

export function trueCopySections(records: RecordsPart, chain: AuditChainPart): PdfaSection[] {
  const sections: PdfaSection[] = [];
  sections.push({
    heading: 'Record',
    lines: [
      `Chain: ${records.chainKey}`,
      `Aggregate: ${records.aggregateType} ${records.aggregateId}`,
      `Audit chain head: ${chain.head ? `event ${chain.head.seq}, hash ${chain.head.hash}` : 'none'}`,
      ...records.tables.map((t) => `Table ${t.table}: ${t.rows.length} row(s)${t.insertOnly ? ', insert-only' : ''}`),
    ],
  });
  for (const t of records.tables) {
    const lines: string[] = [];
    for (const row of t.rows) {
      lines.push(`Row ${row.recordId}  (SHA-256 ${row.sha256})`);
      for (const l of rowLines(row.content)) lines.push(`    ${l}`);
    }
    sections.push({ heading: `Rows of ${t.table}`, lines: lines.length ? lines : ['(no rows)'] });
  }
  const changes: string[] = [];
  for (const e of chain.events) {
    if (e.action !== 'UPDATE') continue;
    const p = JSON.parse(e.payload) as EventPayload;
    changes.push(`Event ${e.seq} at ${e.recordedAt}: ${e.tableName ?? '?'} ${e.recordId ?? '?'} changed by ${p.actor?.legal_name ?? '?'}; reason: ${p.reason_code ?? '-'} ${p.reason_text ?? ''}`.trimEnd());
    const before = p.body?.old ?? {};
    const after = p.body?.new ?? {};
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      changes.push(`    ${k}: original ${flatten(before[k] ?? null)}  ->  new ${flatten(after[k] ?? null)}`);
    }
  }
  for (const t of records.tables) {
    for (const row of t.rows) if (isCorrectionRow(row.content)) changes.push(`Correction or void recorded as row ${row.recordId} of ${t.table} (shown above with the entry it names)`);
  }
  sections.push({ heading: 'Changes after entry (DI-24)', lines: changes.length ? changes : ['No stored row was changed after its entry; no correction or void was recorded.'] });
  sections.push({
    heading: 'Audit trail',
    lines: chain.events.map((e) => {
      const p = JSON.parse(e.payload) as EventPayload;
      return `${e.seq}  ${e.recordedAt}  ${e.action}  ${e.tableName ?? '-'}  ${e.recordId ?? '-'}  by ${p.actor?.legal_name ?? '?'}${p.reason_code || p.reason_text ? `  reason: ${p.reason_code ?? ''} ${p.reason_text ?? ''}`.trimEnd() : ''}  hash ${e.hash}`;
    }),
  });
  return sections;
}

export interface PdfTrueCopy {
  pdf: Uint8Array;
  pdfSha256: string;
  contentSha256: string;
  chainKey: string;
  recordDate: string;
}

/** Renders the PDF/A-3 true copy of a bundle. The same record content gives the same bytes. */
export async function renderTrueCopyPdf(bundle: TrueCopyBundle, opts: { title: string; label: string }): Promise<PdfTrueCopy> {
  const c = trueCopyContent(bundle);
  const records = JSON.parse(c.records) as RecordsPart;
  const chain = JSON.parse(c.chain) as AuditChainPart;
  const pdf = await renderPdfA3({
    title: opts.title,
    subject: `${opts.label}; true copy of ${c.content.chainKey}`,
    recordDate: c.content.recordDate,
    contentSha256: c.sha256,
    integrityClause: DI24_CLAUSE,
    sections: trueCopySections(records, chain),
    attachments: [
      { name: 'content.json', mediaType: 'application/json', relationship: 'Data', description: 'The chain, its head and the SHA-256 of the record parts (content SHA-256)', text: c.text },
      { name: 'records.json', mediaType: 'application/json', relationship: 'Source', description: 'Every row of the record as stored (canonical PostgreSQL jsonb text)', text: c.records },
      { name: 'audit-chain.json', mediaType: 'application/json', relationship: 'Source', description: 'The audit trail of the record, every event exactly as hashed', text: c.chain },
    ],
  });
  return { pdf, pdfSha256: sha256(pdf), contentSha256: c.sha256, chainKey: c.content.chainKey, recordDate: c.content.recordDate };
}

export interface PdfVerificationReport {
  ok: boolean;
  contentSha256: string | null;
  chainKey: string | null;
  problems: string[];
}

/**
 * Checks a PDF true copy offline: the associated files are there, content.json names exactly their SHA-256, the content
 * SHA-256 in the metadata is content.json's, the audit chain and the rows pass the kernel verifier, and (when a bundle is
 * given) the parts are the bundle's.
 */
export async function verifyTrueCopyPdf(pdf: Uint8Array, bundle?: TrueCopyBundle): Promise<PdfVerificationReport> {
  const problems: string[] = [];
  let read;
  try {
    read = await readPdfA3(pdf);
  } catch (error) {
    return { ok: false, contentSha256: null, chainKey: null, problems: [`the file is no readable PDF: ${(error as Error).message}`] };
  }
  if (!read.hasXmp) problems.push('the PDF has no XMP metadata');
  if (!read.hasOutputIntent) problems.push('the PDF has no output intent');
  const contentText = read.attachments.get('content.json');
  const records = read.attachments.get('records.json');
  const chainText = read.attachments.get('audit-chain.json');
  if (contentText === undefined || records === undefined || chainText === undefined) {
    return { ok: false, contentSha256: null, chainKey: null, problems: [...problems, 'the PDF does not carry content.json, records.json and audit-chain.json'] };
  }
  if (read.catalogAf !== read.attachments.size) problems.push('not every embedded file is an associated file of the document');
  const contentSha = sha256(contentText);
  if (!(read.keywords ?? '').includes(contentKeyword(contentSha))) problems.push('the content SHA-256 in the metadata is not the SHA-256 of content.json');
  let content: TrueCopyContent | null = null;
  try {
    content = JSON.parse(contentText) as TrueCopyContent;
  } catch {
    problems.push('content.json is not JSON');
  }
  if (content) {
    const want = new Map(content.parts.map((p) => [p.name, p.sha256]));
    if (want.get('records.json') !== sha256(records)) problems.push('records.json does not match its SHA-256 in content.json');
    if (want.get('audit-chain.json') !== sha256(chainText)) problems.push('audit-chain.json does not match its SHA-256 in content.json');
  }
  try {
    const chain = JSON.parse(chainText) as AuditChainPart;
    const rows = JSON.parse(records) as RecordsPart;
    for (const p of [...verifyChainPart(chain), ...verifyRecordsPart(rows, chain)]) problems.push(p);
  } catch (error) {
    problems.push(`the record parts cannot be read: ${(error as Error).message}`);
  }
  if (bundle) {
    const c = trueCopyContent(bundle);
    if (c.sha256 !== contentSha) problems.push('the PDF is not a rendering of this bundle (content SHA-256 differs)');
  }
  return { ok: problems.length === 0, contentSha256: contentSha, chainKey: content?.chainKey ?? null, problems };
}
