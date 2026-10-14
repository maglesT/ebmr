/** The module manifest, docs/handbook/modules.yaml (decision 0014). */
import { parse } from 'yaml';
import { read } from './repo.ts';

export const MANIFEST_PATH = 'docs/handbook/modules.yaml';
export const HANDBOOK_DIR = 'docs/handbook';

export interface ModuleDef {
  readonly id: string;
  readonly title: string;
  /** Relative to docs/handbook, optionally with `#anchor`. */
  readonly page: string;
  readonly package: string;
  /** Source directory -> file-name regular expressions. */
  readonly migrations: Readonly<Record<string, readonly RegExp[]>>;
  readonly server: readonly string[];
  readonly contract: readonly string[];
  readonly screens: readonly string[];
  readonly src: readonly string[];
  readonly tests: readonly string[];
}

export interface Manifest {
  readonly migrationSources: readonly string[];
  readonly migrationHeaderFrom: Readonly<Record<string, number>>;
  /** Relative to docs/handbook. */
  readonly pending: readonly string[];
  readonly modules: readonly ModuleDef[];
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new Error(`${where}: expected a list of strings`);
  return v as string[];
}

function record(v: unknown, where: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: expected a mapping`);
  return v as Record<string, unknown>;
}

export function parseManifest(text: string): Manifest {
  const doc = record(parse(text), 'modules.yaml');
  const seen = new Set<string>();
  const modules = (Array.isArray(doc['modules']) ? (doc['modules'] as unknown[]) : []).map((raw, i): ModuleDef => {
    const m = record(raw, `modules[${i}]`);
    const id = m['id'];
    if (typeof id !== 'string' || id === '') throw new Error(`modules[${i}]: id missing`);
    if (seen.has(id)) throw new Error(`module ${id}: duplicate id`);
    seen.add(id);
    for (const key of ['title', 'page', 'package']) {
      if (typeof m[key] !== 'string') throw new Error(`module ${id}: ${key} missing`);
    }
    const migrations: Record<string, RegExp[]> = {};
    for (const [dir, list] of Object.entries(record(m['migrations'], `module ${id} migrations`))) {
      migrations[dir] = strings(list, `module ${id} migrations ${dir}`).map((r) => new RegExp(r));
    }
    return {
      id,
      title: m['title'] as string,
      page: m['page'] as string,
      package: m['package'] as string,
      migrations,
      server: strings(m['server'], `module ${id} server`),
      contract: strings(m['contract'], `module ${id} contract`),
      screens: strings(m['screens'], `module ${id} screens`),
      src: strings(m['src'], `module ${id} src`),
      tests: strings(m['tests'], `module ${id} tests`),
    };
  });
  const from: Record<string, number> = {};
  for (const [dir, n] of Object.entries(record(doc['migration_header_from'], 'migration_header_from'))) {
    if (typeof n !== 'number') throw new Error(`migration_header_from ${dir}: expected a number`);
    from[dir] = n;
  }
  return {
    migrationSources: strings(doc['migration_sources'], 'migration_sources'),
    migrationHeaderFrom: from,
    pending: strings(doc['pending'], 'pending'),
    modules,
  };
}

export function loadManifest(root: string): Manifest {
  return parseManifest(read(root, MANIFEST_PATH));
}
