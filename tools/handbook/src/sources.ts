/** Routes from the contract's namespace files, controls from the register, error codes from the source. */
import { parse } from 'yaml';
import { compare, read } from './repo.ts';

export interface RouteRow {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly file: string;
}

/** The `defineRoute({ id, method, path, ... })` calls of one contract file, in file order. */
export function parseRoutes(file: string, text: string): RouteRow[] {
  const out: RouteRow[] = [];
  const starts = [...text.matchAll(/defineRoute\s*\(\s*\{/g)].map((m) => m.index);
  starts.forEach((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    const id = /\bid:\s*'([^']+)'/.exec(block)?.[1];
    const method = /\bmethod:\s*'([A-Z]+)'/.exec(block)?.[1];
    const path = /\bpath:\s*'([^']+)'/.exec(block)?.[1];
    if (id && method && path) out.push({ id, method, path, file });
  });
  return out;
}

export interface ControlRow {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly targetPhase: string;
  readonly editions: readonly string[];
  readonly buildStatus: string;
  /** Repository paths named in implemented_by.modules (existing or not). */
  readonly paths: readonly string[];
  /** The implemented_by.modules entries as written. */
  readonly moduleTexts: readonly string[];
  readonly guards: readonly string[];
  /** Test files (the part before ` > `). */
  readonly testFiles: readonly string[];
}

const PATH_RE = /(?:packages|apps|tools|compliance|docs|ops)\/[\w.\-/]*[\w-]/g;
const BARE_MIGRATION = /(?<![\w/])\d{4}_[\w-]+\.sql/g;

/** The repository paths an implemented_by entry names; a bare `NNNN_x.sql` after a path is read in that path's folder. */
export function pathsIn(text: string): string[] {
  const out: string[] = [];
  let dir: string | undefined;
  const found: { index: number; value: string; bare: boolean }[] = [];
  for (const m of text.matchAll(PATH_RE)) found.push({ index: m.index, value: m[0], bare: false });
  for (const m of text.matchAll(BARE_MIGRATION)) found.push({ index: m.index, value: m[0], bare: true });
  found.sort((a, b) => a.index - b.index);
  for (const f of found) {
    if (!f.bare) {
      out.push(f.value);
      dir = f.value.includes('/') ? f.value.slice(0, f.value.lastIndexOf('/')) : undefined;
    } else if (dir) out.push(`${dir}/${f.value}`);
  }
  return [...new Set(out)];
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function loadControls(root: string, files: readonly string[]): ControlRow[] {
  const rows: ControlRow[] = [];
  for (const file of files.filter((f) => /^compliance\/controls\/[^/]+\.yaml$/.test(f))) {
    const doc = parse(read(root, file)) as Record<string, unknown> | null;
    if (!doc || typeof doc['id'] !== 'string') continue;
    const impl = (doc['implemented_by'] ?? {}) as Record<string, unknown>;
    const moduleTexts = list(impl['modules']).map(String);
    const tests = list(doc['tests']).map(String);
    rows.push({
      id: doc['id'],
      file,
      title: typeof doc['title'] === 'string' ? doc['title'] : '',
      targetPhase: doc['target_phase'] === undefined ? '' : String(doc['target_phase']),
      editions: list(doc['editions']).map(String),
      buildStatus: typeof doc['build_status'] === 'string' ? doc['build_status'] : '',
      paths: [...new Set(moduleTexts.flatMap(pathsIn))].sort(compare),
      moduleTexts,
      guards: list(impl['guards']).map(String),
      testFiles: [...new Set(tests.map((t) => t.split(' > ')[0]?.trim() ?? '').filter((t) => t !== ''))].sort(compare),
    });
  }
  return rows.sort((a, b) => compareControlIds(a.id, b.id));
}

/** DI-2 before DI-10: prefix, then number. */
export function compareControlIds(a: string, b: string): number {
  const pa = /^([A-Z]+)-(\d+)(.*)$/.exec(a);
  const pb = /^([A-Z]+)-(\d+)(.*)$/.exec(b);
  if (!pa || !pb) return compare(a, b);
  return compare(pa[1] ?? '', pb[1] ?? '') || Number(pa[2]) - Number(pb[2]) || compare(pa[3] ?? '', pb[3] ?? '');
}

export const ERROR_CODE = /EBMR-[A-Z]+-[0-9]+/g;

/** Error code -> the source files (SQL migrations and TypeScript source, not tests) that name it. */
export function errorCodes(root: string, files: readonly string[]): Map<string, string[]> {
  const codes = new Map<string, Set<string>>();
  const sources = files.filter(
    (f) => /^(packages|apps)\/[^/]+\/(sql\/[^/]+\.sql|src\/.+\.tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f),
  );
  for (const f of sources) {
    for (const m of read(root, f).matchAll(ERROR_CODE)) {
      const set = codes.get(m[0]) ?? new Set<string>();
      set.add(f);
      codes.set(m[0], set);
    }
  }
  const out = new Map<string, string[]>();
  for (const code of [...codes.keys()].sort(compareErrorCodes)) out.set(code, [...(codes.get(code) ?? [])].sort(compare));
  return out;
}

export function compareErrorCodes(a: string, b: string): number {
  const pa = a.split('-');
  const pb = b.split('-');
  return compare(pa[1] ?? '', pb[1] ?? '') || Number(pa[2]) - Number(pb[2]);
}
