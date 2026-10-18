/**
 * The document model of the validation pack and its two renderings (Phase 7 slice 7c; D-P7-13): Markdown and
 * self-contained HTML (inline style, no script, no external resource), so a document prints to PDF from any browser.
 *
 * Every generator builds a `Doc` from the bundle; the renderers are pure and deterministic: the same document gives
 * the same bytes (no clock, no locale, no random). Each document's footer names the release, the edition and the
 * bundle's SHA-256 (interfaces section 1, "Determinism").
 */

export type Inline = string;

export type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: Inline }
  | { kind: 'paragraph'; text: Inline }
  | { kind: 'list'; items: Inline[]; ordered?: boolean }
  | { kind: 'table'; head: Inline[]; rows: Inline[][] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'fields'; fields: [Inline, Inline][] }
  | { kind: 'signature'; roles: Inline[] };

export interface Doc {
  /** The document's file stem and artefact id, e.g. `urs`. */
  id: string;
  title: string;
  /** DRAFT documents say so in their header (e.g. a control whose regulatory text is unchecked). */
  status: 'RELEASED' | 'TEMPLATE' | 'DRAFT';
  blocks: Block[];
}

export interface Footer {
  product: string;
  version: string;
  edition: string;
  commit: string;
  schemaRelease: string;
  bundleSha256: string;
}

const h = (level: number, text: string): Block => ({ kind: 'heading', level: level as 2 | 3 | 4, text });
export const heading = (text: string, level: 2 | 3 | 4 = 2): Block => h(level, text);
export const para = (text: string): Block => ({ kind: 'paragraph', text });
export const list = (items: string[], ordered = false): Block => ({ kind: 'list', items, ordered });
export const table = (head: string[], rows: string[][]): Block => ({ kind: 'table', head, rows });
export const fields = (f: [string, string][]): Block => ({ kind: 'fields', fields: f });
export const code = (language: string, text: string): Block => ({ kind: 'code', language, text });
export const signature = (roles: string[]): Block => ({ kind: 'signature', roles });

// ---------------------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------------------

/** Text safe in a Markdown table cell or line: pipes escaped, line breaks as <br>. */
function mdCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
function mdLine(text: string): string {
  return text.replace(/\r?\n/g, ' ');
}

function mdBlock(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${mdLine(b.text)}`;
    case 'paragraph':
      return b.text;
    case 'list':
      return b.items.length === 0 ? '_(none)_' : b.items.map((i, n) => `${b.ordered ? `${String(n + 1)}.` : '-'} ${mdLine(i)}`).join('\n');
    case 'table': {
      if (b.rows.length === 0) return `_(none)_`;
      const head = `| ${b.head.map(mdCell).join(' | ')} |`;
      const rule = `|${b.head.map(() => '---').join('|')}|`;
      return [head, rule, ...b.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');
    }
    case 'code':
      return `\`\`\`${b.language}\n${b.text.replace(/```/g, '`​``')}\n\`\`\``;
    case 'fields':
      return b.fields.map(([k, v]) => `- **${mdLine(k)}:** ${mdLine(v)}`).join('\n');
    case 'signature':
      return ['| Role | Name | Signature | Date |', '|---|---|---|---|', ...b.roles.map((r) => `| ${mdCell(r)} | | | |`)].join('\n');
  }
}

function footerLines(f: Footer): string[] {
  return [
    `${f.product} ${f.version} (${f.edition}), commit ${f.commit}`,
    `Schema release ${f.schemaRelease}`,
    `Generated from evidence bundle SHA-256 ${f.bundleSha256}`,
  ];
}

export function renderMarkdown(doc: Doc, f: Footer): string {
  const parts = [`# ${doc.title}`];
  if (doc.status !== 'RELEASED') parts.push(`**${doc.status}**`);
  for (const b of doc.blocks) parts.push(mdBlock(b));
  parts.push('---', footerLines(f).map((l) => `_${l}_`).join('  \n'));
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const htmlText = (t: string): string => escapeHtml(t).replace(/\r?\n/g, '<br>');

function htmlBlock(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return `<h${String(b.level)}>${htmlText(b.text)}</h${String(b.level)}>`;
    case 'paragraph':
      return `<p>${htmlText(b.text)}</p>`;
    case 'list': {
      if (b.items.length === 0) return '<p class="none">(none)</p>';
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.items.map((i) => `<li>${htmlText(i)}</li>`).join('')}</${tag}>`;
    }
    case 'table':
      if (b.rows.length === 0) return '<p class="none">(none)</p>';
      return `<table><thead><tr>${b.head.map((c) => `<th>${htmlText(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${htmlText(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    case 'code':
      return `<pre class="${escapeHtml(b.language)}">${escapeHtml(b.text)}</pre>`;
    case 'fields':
      return `<dl>${b.fields.map(([k, v]) => `<dt>${htmlText(k)}</dt><dd>${htmlText(v)}</dd>`).join('')}</dl>`;
    case 'signature':
      return `<table class="signature"><thead><tr><th>Role</th><th>Name</th><th>Signature</th><th>Date</th></tr></thead><tbody>${b.roles
        .map((r) => `<tr><td>${htmlText(r)}</td><td></td><td></td><td></td></tr>`)
        .join('')}</tbody></table>`;
  }
}

const STYLE = [
  'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1b1f24;background:#fff;line-height:1.45}',
  'h1{font-size:1.6rem;border-bottom:2px solid #1b1f24;padding-bottom:.3rem}h2{font-size:1.25rem;margin-top:2rem}h3{font-size:1.05rem}',
  'table{border-collapse:collapse;width:100%;margin:.6rem 0;font-size:.85rem}th,td{border:1px solid #9aa4ae;padding:.25rem .4rem;text-align:left;vertical-align:top}',
  'th{background:#eef1f4}pre{background:#f4f6f8;border:1px solid #d0d7de;padding:.6rem;overflow-x:auto;font-size:.8rem}',
  'dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dt{font-weight:600}dd{margin:0}',
  '.status{display:inline-block;border:2px solid #b42318;color:#b42318;font-weight:700;padding:.1rem .5rem}.none{color:#57606a;font-style:italic}',
  '.signature td{height:2.2rem}footer{margin-top:3rem;border-top:1px solid #9aa4ae;font-size:.75rem;color:#57606a}',
  '@media print{body{margin:0;max-width:none}h2{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}}',
].join('');

export function renderHtml(doc: Doc, f: Footer): string {
  const body = doc.blocks.map(htmlBlock).join('\n');
  const status = doc.status === 'RELEASED' ? '' : `<p class="status">${doc.status}</p>\n`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `${status}${body}`,
    `<footer>${footerLines(f).map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</footer>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
