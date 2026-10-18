/**
 * Builds the stand-alone record viewer into one self-contained file, dist/record-viewer.html: the page, its style and
 * its script inline, with a content security policy that allows exactly that script and that style (by their SHA-256)
 * and no network, no image, no font, no form and no frame. It opens from the file system (file://) in a current
 * browser, with no server. Run `pnpm --filter @ebmr/record-viewer build`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const hash = (s: string): string => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** Builds the viewer and returns the path of the HTML file. */
export async function buildViewer(outDir = join(here, 'dist')): Promise<string> {
  const out = await build({
    entryPoints: [join(here, 'src', 'main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
  });
  const js = (out.outputFiles[0]?.text ?? '').replace(/<\/script/gi, '<\\/script');
  const css = readFileSync(join(here, 'src', 'style.css'), 'utf8');
  const csp = [
    "default-src 'none'",
    `script-src ${hash(js)}`,
    `style-src ${hash(css)}`,
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
  ].join('; ');
  const template = readFileSync(join(here, 'src', 'index.html'), 'utf8');
  const html = template.replace('%CSP%', () => csp).replace('%STYLE%', () => css).replace('%SCRIPT%', () => js);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'record-viewer.html');
  writeFileSync(file, html);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${await buildViewer()}\n`);
}
