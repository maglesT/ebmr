/** All handbook checks (decision 0014): claims, packages, pages, links, migration back-links, generated pages current. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HANDBOOK_DIR, loadManifest, type Manifest } from './manifest.ts';
import { checkLinks } from './links.ts';
import { buildModel, type Model } from './model.ts';
import { renderAll } from './render.ts';
import { compare, listFiles, read, under } from './repo.ts';

const FEATURES = 'apps/tablets-server/src/features';
const CONTRACT_NS = 'packages/api-contract/src/ns';
const SCREENS = 'apps/tablets-web/src/features';

/** The entries (first path segment) of a folder, from the file list. */
function entries(files: readonly string[], dir: string, filter: (entry: string) => boolean = () => true): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(`${dir}/`)) continue;
    const seg = f.slice(dir.length + 1).split('/')[0] ?? '';
    if (filter(seg)) out.add(`${dir}/${seg}`);
  }
  return [...out].sort(compare);
}

/** (a) each server feature entry, contract namespace file and screens folder belongs to exactly one module. */
export function claimProblems(model: Model): string[] {
  const problems: string[] = [];
  const kinds: [string[], 'server' | 'contract' | 'screens', string][] = [
    [entries(model.files, FEATURES), 'server', 'server feature'],
    [entries(model.files, CONTRACT_NS, (e) => e.endsWith('.ts')), 'contract', 'contract file'],
    [entries(model.files, SCREENS, (e) => !e.includes('.')), 'screens', 'screens folder'],
  ];
  for (const [list, kind, label] of kinds) {
    for (const entry of list) {
      const owners = model.manifest.modules.filter((m) => m[kind].some((p) => under(p, entry))).map((m) => m.id);
      if (owners.length === 0) problems.push(`unclaimed ${label}: ${entry} (no module lists it under ${kind})`);
      else if (owners.length > 1) problems.push(`${label} ${entry} is claimed by ${owners.length} modules: ${owners.join(', ')}`);
    }
  }
  return problems;
}

/** (b) each package or app folder under packages/, apps/ and tools/ is the package of some module. */
export function packageProblems(model: Model): string[] {
  const packages = new Set(model.manifest.modules.map((m) => m.package));
  const problems: string[] = [];
  for (const top of ['packages', 'apps', 'tools']) {
    for (const dir of entries(model.files, top, (e) => !e.includes('.'))) {
      if (!packages.has(dir)) problems.push(`${dir} has no module in modules.yaml (set some module's package to it)`);
    }
  }
  return problems;
}

/** (d) each module page exists (or is pending) and is a page of the README's module table. */
export function pageProblems(root: string, manifest: Manifest): string[] {
  const problems: string[] = [];
  const readme = existsSync(join(root, HANDBOOK_DIR, 'README.md')) ? read(root, `${HANDBOOK_DIR}/README.md`) : '';
  for (const m of manifest.modules) {
    const file = m.page.split('#')[0] ?? '';
    if (!existsSync(join(root, HANDBOOK_DIR, file)) && !manifest.pending.includes(file)) {
      problems.push(`module ${m.id}: page ${m.page} does not exist and is not pending`);
    }
    if (!readme.includes(`](${file})`)) problems.push(`module ${m.id}: page ${file} is not linked from ${HANDBOOK_DIR}/README.md`);
  }
  for (const p of manifest.pending) {
    if (existsSync(join(root, HANDBOOK_DIR, p))) problems.push(`pending page ${p} exists now: remove it from pending in modules.yaml`);
  }
  return problems;
}

/** A migration above its source's mark names its handbook page in a `-- Handbook:` line within its first 10 lines. */
export function headerProblems(model: Model): string[] {
  const problems: string[] = [];
  for (const mig of model.migrations) {
    const mark = model.manifest.migrationHeaderFrom[mig.source];
    const n = Number(/^(\d+)_/.exec(mig.name)?.[1] ?? NaN);
    if (mark === undefined) {
      problems.push(`${mig.file}: its source ${mig.source} has no migration_header_from mark in modules.yaml`);
      continue;
    }
    if (!(n > mark)) continue;
    const head = read(model.root, mig.file).split('\n').slice(0, 10);
    if (!head.some((l) => /^--\s*Handbook:\s*\S/.test(l))) {
      problems.push(`${mig.file}: a new migration names its handbook page in a "-- Handbook: <page>" line within its first 10 lines`);
    }
  }
  return problems;
}

/** The user and administrator guides (slice 7e): their pages' links are checked as the handbook's are. */
export const GUIDES_DIR = 'docs/guides';

/** (c) the link checker over docs/handbook/**.md and docs/guides/**.md, the generated pages read as they would be written. */
export function linkProblems(model: Model, generated: ReadonlyMap<string, string>): string[] {
  const pending = new Set(model.manifest.pending.map((p) => `${HANDBOOK_DIR}/${p}`.replace(/\/+$/, '')));
  const pages = new Set([...model.files.filter((f) => (f.startsWith(`${HANDBOOK_DIR}/`) || f.startsWith(`${GUIDES_DIR}/`)) && f.endsWith('.md')), ...generated.keys()]);
  const cache = new Map<string, string>();
  const symbols = new Map<string, Set<string>>();
  const ctx = { root: model.root, pending, overlay: generated };
  const inPages = [...pages].sort(compare).flatMap((p) => checkLinks(ctx, p, generated.get(p) ?? read(model.root, p), cache, symbols));
  // The code-to-handbook back-links: the `Handbook:` line of each package or feature README.
  const readmes = model.files.filter((f) => /^(packages|apps|tools)\/.*README\.md$/.test(f));
  const backLinks = readmes.flatMap((f) => {
    const lines = read(model.root, f).split('\n').filter((l) => l.startsWith('Handbook:'));
    if (lines.length === 0) return [`${f}: a package or feature README names its handbook page in a "Handbook: [page](link)" line`];
    return checkLinks(ctx, f, lines.join('\n'), cache, symbols);
  });
  return [...inPages, ...backLinks];
}

export interface Result {
  readonly model: Model;
  readonly generated: Map<string, string>;
  readonly problems: string[];
  /** Generated files whose content on disk differs. */
  readonly stale: string[];
}

export function runChecks(root: string): Result {
  const manifest = loadManifest(root);
  const files = listFiles(root);
  const model = buildModel(root, manifest, files);
  const generated = renderAll(model);
  const stale = [...generated.entries()]
    .filter(([path, text]) => !existsSync(join(root, path)) || read(root, path) !== text)
    .map(([path]) => path);
  const problems = [
    ...model.problems,
    ...claimProblems(model),
    ...packageProblems(model),
    ...pageProblems(root, manifest),
    ...headerProblems(model),
    ...linkProblems(model, generated),
  ];
  return { model, generated, problems, stale };
}
