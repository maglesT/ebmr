/**
 * Markdown to HTML for the guides: the subset the guides use (headings, paragraphs, lists with one level of nesting,
 * GitHub tables, fenced code, quotes, rules; code spans, bold, italic, links and images). Raw HTML in the source is
 * escaped, never passed through. Links and heading ids are handed to the caller (`Resolver`), which joins the pages of
 * a guide into one document.
 */
import { slug } from '../../handbook/src/links.ts';

export interface Resolver {
  /** The id of a heading of this page with GitHub slug `s`. */
  headingId(s: string): string;
  /** The href of a Markdown link target, or null to show it as text (a repository file outside the document). */
  href(target: string): string | null;
  /** The src of an image (a data: URI). */
  image(target: string): string;
}

/**
 * The href of a link target that names a scheme: kept only for http, https and mailto (P7E-1); any other scheme
 * (javascript:, data:, file:) gives null, so the link is shown as text. Null also when the target names no scheme.
 */
export function externalHref(target: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? target : null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline Markdown: code spans first (their content is literal), then images, links, bold and italic. */
export function inline(src: string, r: Resolver): string {
  const parts = src.split(/(`+[^`]*?`+)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`;
      let s = escapeHtml(part.replace(/\\([\\`*_[\]()#|-])/g, (_m, c: string) => `\uE000${c.charCodeAt(0)}\uE000`));
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `<img alt="${alt}" src="${escapeHtml(r.image(url))}">`);
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
        const href = r.href(url.replace(/&amp;/g, '&'));
        return href === null ? `${label} <span class="path">(${url})</span>` : `<a href="${escapeHtml(href)}">${label}</a>`;
      });
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
      return s.replace(/\uE000(\d+)\uE000/g, (_m, c: string) => String.fromCharCode(Number(c)));
    })
    .join('');
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let code = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** One Markdown page as HTML. */
export function toHtml(md: string, r: Resolver): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const counts = new Map<string, number>();
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,6}\s|```|>|\s*([-*]|\d+\.)\s|\|)/.test(l) || /^-{3,}\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = (h[1] ?? '#').length;
      const base = slug(h[2] ?? '');
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      out.push(`<h${level} id="${escapeHtml(r.headingId(n === 0 ? base : `${base}-${n}`))}">${inline(h[2] ?? '', r)}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) body.push(lines[i++] ?? '');
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) body.push((lines[i++] ?? '').replace(/^>\s?/, ''));
      out.push(`<blockquote>${toHtml(body.join('\n'), r)}</blockquote>`);
      continue;
    }
    if (line.startsWith('|') && /^\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('|')) rows.push(splitRow(lines[i++] ?? ''));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c, r)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((c) => `<td>${inline(c, r)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2] ?? '');
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
        if (m && (m[1] ?? '').length < 2) {
          items.push({ text: m[3] ?? '', sub: [] });
          i++;
        } else if (l.trim() !== '' && /^\s{2,}/.test(l) && items.length > 0) {
          const last = items[items.length - 1];
          if (last) {
            if (/^\s*([-*]|\d+\.)\s/.test(l) || last.sub.length > 0) last.sub.push(l.replace(/^\s{2,4}/, ''));
            else last.text += ` ${l.trim()}`;
          }
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text, r)}${it.sub.length > 0 ? toHtml(it.sub.join('\n'), r) : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && (para.length === 0 || !isBlockStart(lines[i] ?? ''))) para.push((lines[i++] ?? '').trim());
    out.push(`<p>${inline(para.join(' '), r)}</p>`);
  }
  return out.join('\n');
}
