/**
 * The files under compliance/validation/ (Phase 7 slice 7-0, interfaces note section 1c): the control class
 * (control-class.yaml, D-P7-0-4), the critical limits and their boundary tests (critical-limits.yaml), the reviews
 * (reviews.yaml) and the open findings (open-findings.yaml). `pnpm register:validate` checks each against its JSON
 * schema in compliance/schema/, that its entries are sorted by key or id with no duplicate, that every control it
 * names is a control of the register, that every test it names is a test some control lists (so a renamed or unknown
 * test is refused, never carried silently into the pack), and that every backlog it cites exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { loadControls, ROOT, type ControlRecord } from './register.ts';

export const VALIDATION_DIR = join(ROOT, 'compliance/validation');
const SCHEMA_DIR = join(ROOT, 'compliance/schema');

export type ControlClass = 'core' | 'other';

export interface ControlClassEntry {
  id: string;
  class: ControlClass;
  basis: string;
}

export interface CriticalLimit {
  key: string;
  description: string;
  controls: string[];
  boundaryTests: string[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface ReviewEntry {
  id: string;
  date: string;
  scope: string[];
  findings: Record<Severity, { open: number; fixed: number }>;
}

export interface OpenFinding {
  id: string;
  severity: Severity;
  controls: string[];
  summary: string;
  source: string;
}

/** The four files as parsed YAML (unknown until the schema check has passed). */
export interface ValidationFiles {
  'control-class.yaml': unknown;
  'critical-limits.yaml': unknown;
  'reviews.yaml': unknown;
  'open-findings.yaml': unknown;
}

type FileName = keyof ValidationFiles;

/** Each file: its schema, the list it holds and the field its entries are sorted by. */
const LAYOUT: Record<FileName, { schema: string; list: string; key: string }> = {
  'control-class.yaml': { schema: 'control-class.schema.json', list: 'classes', key: 'id' },
  'critical-limits.yaml': { schema: 'critical-limits.schema.json', list: 'limits', key: 'key' },
  'reviews.yaml': { schema: 'reviews.schema.json', list: 'reviews', key: 'id' },
  'open-findings.yaml': { schema: 'open-findings.schema.json', list: 'findings', key: 'id' },
};

export const VALIDATION_FILES = Object.keys(LAYOUT) as FileName[];

/**
 * The order of keys and ids: runs of digits compare as numbers, everything else by UTF-16 code unit (as
 * Array.prototype.sort does), so 6jc-R2 comes before 6jc-R10 and the order never depends on a locale.
 */
export function naturalCompare(a: string, b: string): number {
  const chunks = (s: string): string[] => s.match(/\d+|\D+/g) ?? [];
  const x = chunks(a);
  const y = chunks(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i] ?? '';
    const q = y[i] ?? '';
    if (p === q) continue;
    const digits = /^\d/.test(p) && /^\d/.test(q);
    if (digits) {
      const [m, n] = [p.replace(/^0+(?=\d)/, ''), q.replace(/^0+(?=\d)/, '')];
      if (m.length !== n.length) return m.length - n.length;
      if (m !== n) return m < n ? -1 : 1;
      return p.length - q.length;
    }
    return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/** Reads the four files from a directory; a missing file is an empty document, which the schema refuses. */
export function loadValidationFiles(dir = VALIDATION_DIR): ValidationFiles {
  const read = (name: FileName): unknown => {
    const file = join(dir, name);
    return existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) as unknown) : null;
  };
  return {
    'control-class.yaml': read('control-class.yaml'),
    'critical-limits.yaml': read('critical-limits.yaml'),
    'reviews.yaml': read('reviews.yaml'),
    'open-findings.yaml': read('open-findings.yaml'),
  };
}

/** The problems with the validation files; empty when they are valid. */
export function validationFileErrors(
  files: ValidationFiles = loadValidationFiles(),
  controls: Pick<ControlRecord, 'id' | 'tests'>[] = loadControls(),
  root = ROOT,
): string[] {
  const errors: string[] = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const controlIds = new Set(controls.map((c) => c.id));
  const listedTests = new Set(controls.flatMap((c) => c.tests));
  const valid: Partial<Record<FileName, Record<string, unknown>[]>> = {};

  for (const name of VALIDATION_FILES) {
    const { schema, list, key } = LAYOUT[name];
    const validate = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, schema), 'utf8')) as object);
    const doc = files[name];
    if (!validate(doc)) {
      for (const e of validate.errors ?? []) errors.push(`compliance/validation/${name}: ${e.instancePath || '/'} ${e.message ?? ''}`);
      continue;
    }
    const entries = (doc as Record<string, Record<string, unknown>[]>)[list] ?? [];
    valid[name] = entries;
    const keys = entries.map((e) => String(e[key]));
    for (let i = 1; i < keys.length; i++) {
      const order = naturalCompare(keys[i - 1] ?? '', keys[i] ?? '');
      if (order === 0) errors.push(`compliance/validation/${name}: duplicate ${key} ${keys[i]}`);
      else if (order > 0) errors.push(`compliance/validation/${name}: ${key} ${keys[i]} is out of order (it sorts before ${keys[i - 1]})`);
    }
  }

  const unknownControl = (name: FileName, where: string, id: string): void => {
    if (!controlIds.has(id)) errors.push(`compliance/validation/${name}: ${where} names an unknown control ${id}`);
  };
  for (const e of (valid['control-class.yaml'] ?? []) as unknown as ControlClassEntry[]) unknownControl('control-class.yaml', `class entry ${e.id}`, e.id);
  for (const l of (valid['critical-limits.yaml'] ?? []) as unknown as CriticalLimit[]) {
    for (const id of l.controls) unknownControl('critical-limits.yaml', `limit ${l.key}`, id);
    for (const t of l.boundaryTests) {
      if (!listedTests.has(t)) errors.push(`compliance/validation/critical-limits.yaml: limit ${l.key} names a test no control lists: "${t}"`);
    }
  }
  for (const f of (valid['open-findings.yaml'] ?? []) as unknown as OpenFinding[]) {
    for (const id of f.controls) unknownControl('open-findings.yaml', `finding ${f.id}`, id);
    if (!existsSync(join(root, f.source))) errors.push(`compliance/validation/open-findings.yaml: finding ${f.id} cites a source that does not exist: ${f.source}`);
  }
  return errors;
}

/** The class of a control (D-P7-0-4): the one control-class.yaml gives it, or core when it is not listed. */
export function controlClass(id: string, entries: readonly ControlClassEntry[]): ControlClass {
  return entries.find((e) => e.id === id)?.class ?? 'core';
}
