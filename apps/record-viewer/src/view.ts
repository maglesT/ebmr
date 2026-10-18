/**
 * The viewer's screens: plain DOM, every text set as text (an export's content is never parsed as HTML). Nothing here
 * writes, signs, sends or saves: the page has no form, no link and no download, and its policy allows no network.
 */
import type { ExportReport, VerifiedChain, VerifiedRecord, VerifiedSignature } from './verify/export.ts';
import { payloadOf } from './verify/true-copy.ts';
import { jsonText, field } from './verify/lossless-json.ts';

type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const problemList = (problems: string[], testId: string): HTMLElement => h('ul', { class: 'problems', 'data-testid': testId }, ...problems.map((p) => h('li', {}, p)));

export function renderChecking(files: number): HTMLElement {
  return h('p', { class: 'checking', 'data-testid': 'checking', role: 'status' }, `Checking ${files} files: every hash, audit chain and seal is verified before anything is shown.`);
}

function verdict(r: ExportReport): HTMLElement {
  const sha = r.manifestSha256 ?? 'unknown';
  if (!r.readable) {
    return h('div', { class: 'verdict failed', 'data-testid': 'verdict', 'data-ok': 'false', role: 'alert' },
      h('h2', {}, 'Verification failed: the export cannot be trusted. Nothing of it is shown.'),
      problemList(r.problems, 'export-problems'),
      h('p', { class: 'sha' }, `Export SHA-256 of the files opened: ${sha}`));
  }
  const recordsFailed = r.records.filter((x) => !x.ok).length;
  const reference = r.reference === 'MATCHED'
    ? 'It matches the expected export SHA-256: this is the registered export.'
    : 'No expected export SHA-256 was given: compare this SHA-256 with the export register of the installation to prove this is the registered export.';
  const counts = `${r.counts.records} records, ${r.counts.signatures} signatures (${r.counts.sealsVerified} seals verified here, ${r.counts.sealsNotCheckable} checkable only by the installation), ${r.counts.files} files.`;
  if (r.ok) {
    return h('div', { class: 'verdict passed', 'data-testid': 'verdict', 'data-ok': 'true', role: 'status' },
      h('h2', {}, 'All checks passed.'),
      h('p', {}, counts),
      h('p', { class: 'sha' }, `Export SHA-256: ${sha}`),
      h('p', {}, reference));
  }
  return h('div', { class: 'verdict failed', 'data-testid': 'verdict', 'data-ok': 'false', role: 'alert' },
    h('h2', {}, `Verification failed: ${r.problems.length} findings in the export, ${recordsFailed} of ${r.records.length} records failed. A record that fails is not shown.`),
    r.problems.length > 0 ? problemList(r.problems, 'export-problems') : null,
    h('p', {}, counts),
    h('p', { class: 'sha' }, `Export SHA-256: ${sha}`),
    h('p', {}, reference));
}

function sealText(s: VerifiedSignature): string {
  if (!s.seal) return 'Seal: not checked';
  if (s.seal.result === 'VERIFIED') return `Seal verified here (${s.seal.algorithm}, key ${s.seal.keyId}).`;
  if (s.seal.result === 'NOT_CHECKABLE_OFFLINE') {
    return `Seal not checkable offline (${s.seal.algorithm} key ${s.seal.keyId} is a shared secret the installation holds); the installation's check at export: ${s.seal.installationCheck}. The sealed payload, its manifestation and its record were checked here.`;
  }
  return `Seal failed (${s.seal.algorithm}, key ${s.seal.keyId}).`;
}

function signature(s: VerifiedSignature): HTMLElement {
  const m = s.manifestation;
  return h('li', { class: 'signature', 'data-testid': 'signature', 'data-signature-id': s.signatureId, 'data-seal': s.seal?.result ?? 'NONE' },
    h('p', { class: 'manifestation', 'data-testid': 'manifestation' }, s.manifestationText),
    h('dl', {},
      h('dt', {}, 'Signed by'), h('dd', {}, `${m['printed_name'] ?? ''} (user ${m['user_id'] ?? ''}, ${m['role_name'] ?? m['role_code'] ?? ''})`),
      h('dt', {}, 'Meaning'), h('dd', {}, `${s.meaningTitle} (${s.meaningCode})`),
      h('dt', {}, 'Signed at'), h('dd', {}, `${m['signed_at_local'] ?? ''} ${m['utc_offset'] ?? ''} ${m['site_zone'] ?? ''} (UTC ${m['signed_at_utc'] ?? ''})`),
      h('dt', {}, 'Signed content'), h('dd', { class: 'sha' }, s.contentHash)),
    s.invalidated ? h('p', { class: 'note' }, 'This signature was later invalidated (the record changed after it); it is kept as recorded.') : null,
    h('p', { class: 'seal' }, sealText(s)));
}

function auditTrail(c: VerifiedChain): HTMLElement {
  const events = c.chain?.events ?? [];
  const rows = events.map((e) => {
    const p = payloadOf(e);
    const actor = field(p, 'actor');
    const who = `${jsonText(field(actor, 'legal_name')) ?? ''} (${jsonText(field(actor, 'role_code')) ?? ''})`;
    const reason = [jsonText(field(p, 'reason_code')), jsonText(field(p, 'reason_text'))].filter((x) => x).join(': ');
    return h('tr', {}, h('td', {}, e.seq), h('td', {}, e.recordedAt), h('td', {}, e.action), h('td', {}, e.tableName ?? ''), h('td', {}, e.recordId ?? ''), h('td', {}, who), h('td', {}, reason));
  });
  const rowCount = c.records?.tables.reduce((n, t) => n + t.rows.length, 0) ?? 0;
  return h('details', { class: 'chain', 'data-testid': 'chain', 'data-chain-key': c.chainKey },
    h('summary', {}, `Audit trail of ${c.chainKey}: ${events.length} events, ${rowCount} rows, head at seq ${c.chain?.head?.seq ?? '-'}`),
    h('table', { 'data-testid': 'audit-trail' },
      h('thead', {}, h('tr', {}, ...['Seq', 'Recorded (UTC)', 'Action', 'Table', 'Row', 'By', 'Reason'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, ...rows)));
}

function record(r: VerifiedRecord): HTMLElement {
  const head = h('header', {},
    h('h2', {}, r.label),
    h('p', { class: 'meta' }, `${r.recordType} ${r.recordId}, closed ${r.closedAt}`),
    h('p', { class: r.ok ? 'badge passed' : 'badge failed', 'data-testid': 'record-status' }, r.ok ? 'Verified' : 'Failed: not shown'));
  if (!r.ok) {
    return h('section', { class: 'record failed', 'data-testid': 'record', 'data-record-id': r.recordId, 'data-status': 'FAILED' }, head, problemList(r.problems, 'record-problems'));
  }
  return h('section', { class: 'record', 'data-testid': 'record', 'data-record-id': r.recordId, 'data-status': 'VERIFIED' },
    head,
    h('h3', {}, `Signatures (${r.signatures.length})`),
    r.signatures.length > 0 ? h('ul', { class: 'signatures' }, ...r.signatures.map(signature)) : h('p', {}, 'No signature on this record.'),
    h('h3', {}, 'Audit trail'),
    ...r.chains.map(auditTrail));
}

export function renderReport(r: ExportReport): HTMLElement {
  const root = h('div', { 'data-testid': 'report' }, verdict(r));
  if (!r.readable) return root;
  if (r.installation) root.append(h('p', { class: 'meta' }, `Installation: ${r.installation.kind}, release ${r.installation.schemaRelease}; exported ${r.generatedAt ?? ''}`));
  for (const x of r.records) root.append(record(x));
  return root;
}
