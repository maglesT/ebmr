/**
 * The code map's model: every module with the files it claims. Matching is ordered: a file belongs to the first module
 * (in modules.yaml order) whose pattern matches it, so a specific module listed early takes its files before a broad one.
 */
import type { Manifest, ModuleDef } from './manifest.ts';
import { compare, globToRegExp, isTestFile, read, under } from './repo.ts';
import { dbObjects, type DbObject } from './sql.ts';
import { loadControls, parseRoutes, type ControlRow, type RouteRow } from './sources.ts';

export type CodeKind = 'server' | 'contract' | 'screens' | 'src';
export const CODE_KINDS: readonly CodeKind[] = ['server', 'contract', 'screens', 'src'];

export interface Migration {
  readonly file: string;
  readonly source: string;
  readonly name: string;
  /** Position in apply order: source order, then file name. */
  readonly order: number;
  readonly objects: readonly DbObject[];
}

export interface ModuleModel {
  readonly def: ModuleDef;
  readonly migrations: Migration[];
  readonly code: Record<CodeKind, string[]>;
  readonly tests: string[];
  readonly routes: RouteRow[];
  readonly controls: ControlRow[];
}

export interface Model {
  readonly root: string;
  readonly manifest: Manifest;
  readonly files: readonly string[];
  readonly migrations: readonly Migration[];
  readonly modules: readonly ModuleModel[];
  readonly controls: readonly ControlRow[];
  /** migration file -> module id */
  readonly migrationOwner: ReadonlyMap<string, string>;
  /** any claimed file -> module id */
  readonly fileOwner: ReadonlyMap<string, string>;
  readonly problems: string[];
}

export function buildModel(root: string, manifest: Manifest, files: readonly string[]): Model {
  const problems: string[] = [];
  const modules: ModuleModel[] = manifest.modules.map((def) => ({
    def,
    migrations: [],
    code: { server: [], contract: [], screens: [], src: [] },
    tests: [],
    routes: [],
    controls: [],
  }));

  // Migrations, in apply order.
  const migrations: Migration[] = [];
  const migrationOwner = new Map<string, string>();
  for (const [si, source] of manifest.migrationSources.entries()) {
    const inSource = files.filter((f) => f.startsWith(`${source}/`) && f.endsWith('.sql') && !f.slice(source.length + 1).includes('/'));
    if (inSource.length === 0) problems.push(`migration source ${source} holds no .sql file`);
    for (const file of inSource) {
      const name = file.slice(source.length + 1);
      const mig: Migration = { file, source, name, order: si * 100000 + migrations.length, objects: dbObjects(read(root, file)) };
      migrations.push(mig);
      const owner = modules.find((m) => (m.def.migrations[source] ?? []).some((re) => re.test(name)));
      if (!owner) problems.push(`unclaimed migration: ${file} (no module in modules.yaml matches it)`);
      else {
        owner.migrations.push(mig);
        migrationOwner.set(file, owner.def.id);
      }
    }
  }
  for (const m of modules) {
    for (const [source, patterns] of Object.entries(m.def.migrations)) {
      if (!manifest.migrationSources.includes(source)) problems.push(`module ${m.def.id}: ${source} is not a migration source`);
      for (const re of patterns) {
        const names = files.filter((f) => f.startsWith(`${source}/`) && f.endsWith('.sql')).map((f) => f.slice(source.length + 1));
        if (!names.some((n) => re.test(n))) problems.push(`module ${m.def.id}: migration pattern ${re.source} in ${source} matches no file`);
      }
    }
  }

  // Code files, then tests: first module wins.
  const fileOwner = new Map<string, string>();
  for (const m of modules) {
    for (const kind of CODE_KINDS) {
      for (const path of m.def[kind]) {
        const hits = files.filter((f) => under(f, path));
        if (hits.length === 0) problems.push(`module ${m.def.id}: ${kind} path ${path} does not exist`);
        for (const f of hits) {
          if (fileOwner.has(f)) continue;
          fileOwner.set(f, m.def.id);
          m.code[kind].push(f);
        }
      }
    }
  }
  const testFiles = files.filter(isTestFile);
  const testOwner = new Map<string, string>();
  for (const m of modules) {
    for (const glob of m.def.tests) {
      const re = globToRegExp(glob);
      const hits = testFiles.filter((f) => re.test(f));
      if (hits.length === 0) problems.push(`module ${m.def.id}: test glob ${glob} matches no test file`);
      for (const f of hits) {
        if (testOwner.has(f)) continue;
        testOwner.set(f, m.def.id);
        m.tests.push(f);
      }
    }
  }
  for (const [f, id] of testOwner) fileOwner.set(f, id);
  for (const f of migrationOwner.keys()) fileOwner.set(f, migrationOwner.get(f) ?? '');

  // Routes from each module's contract files.
  for (const m of modules) {
    for (const f of m.code.contract) if (f.endsWith('.ts')) m.routes.push(...parseRoutes(f, read(root, f)));
    m.routes.sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method) || compare(a.id, b.id));
  }

  // Controls touch a module through a file or folder it names, or a test file.
  const controls = loadControls(root, files);
  for (const m of modules) {
    const own = new Set([...m.migrations.map((x) => x.file), ...CODE_KINDS.flatMap((k) => m.code[k]), ...m.tests]);
    const ownList = [...own];
    for (const c of controls) {
      const hit =
        c.paths.some((p) => own.has(p) || ownList.some((f) => under(f, p) && p.includes('/src/'))) || c.testFiles.some((t) => own.has(t));
      if (hit) m.controls.push(c);
    }
  }

  for (const m of modules) {
    for (const k of CODE_KINDS) m.code[k].sort(compare);
    m.tests.sort(compare);
  }
  return { root, manifest, files, migrations, modules, controls, migrationOwner, fileOwner, problems };
}
