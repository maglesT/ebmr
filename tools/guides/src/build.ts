/**
 * Builds each guide into one self-contained HTML file (its pages and the generated reference pages in order, the
 * brand's images and the stylesheet inline, every link between its pages an anchor inside the file) and prints it to
 * PDF through the browser suite's Playwright (tools/e2e's playwright-core and the pre-installed Chromium). The cover
 * carries Batchwright with the Medhanta logo (decision 0020). The output goes to .reports/guides and is not committed
 * (D-P7-13: rebuilt from the sources).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { escapeHtml, toHtml, type Resolver } from './html.ts';
import { REFERENCE } from './md.ts';

/** The part of playwright-core's API the PDF print uses (the package is tools/e2e's, loaded at run time). */
interface PrintBrowser {
  newPage(): Promise<{ setContent(html: string, o: { waitUntil: 'load' }): Promise<void>; pdf(o: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }>;
  close(): Promise<void>;
}

export interface Guide {
  id: 'user-guide' | 'admin-guide';
  title: string;
  /** The guide's pages in reading order, repository-relative: its README, its numbered pages, then the reference pages. */
  pages: string[];
}

/** The guides and their pages (the README first, then NN-*.md by number, then the generated reference). */
export function guides(root: string): Guide[] {
  const pagesOf = (dir: string, reference: string[]) => [
    `${dir}/README.md`,
    ...readdirSync(join(root, dir))
      .filter((f) => /^\d\d-.*\.md$/.test(f))
      .sort()
      .map((f) => `${dir}/${f}`),
    ...reference,
  ];
  return [
    { id: 'user-guide', title: 'Batchwright Tablets: user guide', pages: pagesOf('docs/guides/user-guide', [`${REFERENCE}/permissions.md`, `${REFERENCE}/screens.md`]) },
    { id: 'admin-guide', title: 'Batchwright Tablets: administrator guide', pages: pagesOf('docs/guides/admin-guide', [`${REFERENCE}/permissions.md`]) },
  ];
}

const pageId = (page: string): string => `p-${page.replace(/^docs\/guides\//, '').replace(/\.md$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

function dataUri(root: string, rel: string): string {
  const type = rel.endsWith('.svg') ? 'image/svg+xml' : rel.endsWith('.png') ? 'image/png' : null;
  if (!type) throw new Error(`guides: image ${rel} is neither SVG nor PNG`);
  return `data:${type};base64,${readFileSync(join(root, rel)).toString('base64')}`;
}

const CSS = `
:root { --red-orange: #D4553A; --grey: #6C6C6C; --text: #202124; }
body { font-family: 'Noto Sans', system-ui, sans-serif; color: var(--text); line-height: 1.5; max-width: 900px; margin: 0 auto; padding: 24px; }
.cover { min-height: 80vh; display: flex; flex-direction: column; justify-content: center; gap: 24px; border-bottom: 4px solid var(--red-orange); }
.cover .lockup { height: 120px; width: auto; align-self: flex-start; }
.cover .maker { display: flex; align-items: center; gap: 10px; color: var(--grey); font-weight: 600; }
.cover .maker img { height: 64px; width: auto; }
.cover h1 { font-size: 2em; margin: 0; }
section.page { break-before: page; padding-top: 8px; }
h1, h2, h3 { line-height: 1.25; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.9em; }
th, td { border: 1px solid #dadce0; padding: 4px 8px; text-align: left; vertical-align: top; }
thead th { background: #f1f3f4; }
code { font-family: ui-monospace, 'DejaVu Sans Mono', monospace; font-size: 0.9em; background: #f8f9fa; padding: 0 3px; }
pre { background: #f8f9fa; padding: 8px 12px; overflow-x: auto; }
blockquote { border-left: 4px solid var(--red-orange); margin: 12px 0; padding: 4px 12px; background: #fff8f5; }
.path { color: var(--grey); font-size: 0.9em; }
nav.toc ol { columns: 2; }
@media print { body { max-width: none; padding: 0; } a { color: inherit; } }
`;

/** One guide as a self-contained HTML document. */
export function guideHtml(root: string, guide: Guide, version: string): string {
  const inDoc = new Set(guide.pages);
  const sections = guide.pages.map((page) => {
    const id = pageId(page);
    const dir = posix.dirname(page);
    const r: Resolver = {
      headingId: (s) => `${id}--${s}`,
      href(target) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
        const hash = target.indexOf('#');
        const path = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash + 1);
        const rel = path === '' ? page : posix.normalize(posix.join(dir, decodeURI(path)));
        if (!inDoc.has(rel)) return null;
        return frag ? `#${pageId(rel)}--${frag}` : `#${pageId(rel)}`;
      },
      image: (target) => dataUri(root, posix.normalize(posix.join(dir, target))),
    };
    return `<section class="page" id="${id}">\n${toHtml(readFileSync(join(root, page), 'utf8'), r)}\n</section>`;
  });
  const toc = guide.pages.map((p) => {
    const first = /^#\s+(.*)$/m.exec(readFileSync(join(root, p), 'utf8'))?.[1] ?? p;
    return `<li><a href="#${pageId(p)}">${escapeHtml(first.replace(/[`*]/g, ''))}</a></li>`;
  });
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(guide.title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<header class="cover">',
    `<img class="lockup" alt="Batchwright Tablets" src="${dataUri(root, 'docs/brand/batchwright-tablets.svg')}">`,
    `<div class="maker"><span>by</span><img alt="Medhanta" src="${dataUri(root, 'docs/brand/medhanta-logo-278x148.png')}"></div>`,
    `<h1>${escapeHtml(guide.title)}</h1>`,
    `<p>Version ${escapeHtml(version)}. Batchwright by Medhanta. The records this system makes carry your company's name and site, never ours.</p>`,
    `<nav class="toc" aria-label="Contents"><h2>Contents</h2><ol>${toc.join('')}</ol></nav>`,
    '</header>',
    ...sections,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The version the guides describe: the server's package version, which the about page and /api/meta report. */
export function productVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'apps/tablets-server/package.json'), 'utf8')) as { version: string }).version;
}

/** Writes <out>/<guide>.html for each guide and, with `pdf`, <out>/<guide>.pdf. Returns the files written. */
export async function buildGuides(root: string, out: string, opts: { pdf: boolean }): Promise<string[]> {
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  const version = productVersion(root);
  const docs = guides(root).map((g) => ({ g, html: guideHtml(root, g, version) }));
  for (const { g, html } of docs) {
    const file = join(out, `${g.id}.html`);
    writeFileSync(file, html);
    written.push(file);
  }
  if (!opts.pdf) return written;
  if (!process.env['PLAYWRIGHT_BROWSERS_PATH'] && existsSync('/opt/pw-browsers')) process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers';
  // The browser suite's Playwright (tools/e2e), so the guides add no browser of their own.
  const { chromium } = createRequire(join(root, 'tools/e2e/package.json'))('playwright-core') as { chromium: { launch(): Promise<PrintBrowser> } };
  const browser = await chromium.launch();
  try {
    for (const { g, html } of docs) {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const file = join(out, `${g.id}.pdf`);
      await page.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#6C6C6C">${escapeHtml(g.title)} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>` });
      await page.close();
      written.push(file);
    }
  } finally {
    await browser.close();
  }
  return written;
}
