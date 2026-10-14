/**
 * Reading the repository: the file list (git's view when the root is a work tree, so build output and ignored files
 * never reach a generated page), globs and path helpers. Everything here is sorted, so generated pages are deterministic.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report', '.reports', '.stryker-tmp', 'graphify-out', 'var']);

/** Every file under `root` (repository-relative, forward slashes, sorted). */
export function listFiles(root: string): string[] {
  let files: string[] | undefined;
  if (existsSync(join(root, '.git'))) {
    try {
      const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      files = out.split('\0').filter((f) => f !== '' && existsSync(join(root, f)));
    } catch {
      files = undefined;
    }
  }
  if (!files) {
    files = [];
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(root, rel))) {
        if (SKIP_DIRS.has(name)) continue;
        const r = rel === '' ? name : `${rel}/${name}`;
        if (statSync(join(root, r)).isDirectory()) walk(r);
        else files?.push(r);
      }
    };
    walk('');
  }
  return [...new Set(files)].sort(compare);
}

/** Plain code-point order: the same on every machine and locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/** A glob (`**` any number of segments, `*` and `?` within one segment) as a regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      i++;
      if (glob.charAt(i + 1) === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** True when `file` is `path` itself or lies under the directory `path`. */
export function under(file: string, path: string): boolean {
  const p = path.replace(/\/+$/, '');
  return file === p || file.startsWith(`${p}/`);
}

/** The relative link from the page `fromFile` to `target` (both repository-relative). */
export function relLink(fromFile: string, target: string): string {
  return posix.relative(posix.dirname(fromFile), target) || posix.basename(target);
}

export function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file) && !file.includes('/fixtures/');
}
