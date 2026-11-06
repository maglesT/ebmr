/**
 * Completes the controls' `tests` lists from a run (review F15, round 2): every test tagged with a control that passed
 * and that the control's list does not name yet is added, as `<file> > <describe> > ... > <title>` with every
 * describe, from the names the run reported (so titles built from data are added exactly). The trace refuses such a
 * test until it is listed (trace.ts), so a list cannot drift as tagged tests are added.
 *
 * Each list is written sorted (code-unit order, one entry per line), and `register validate` refuses an unsorted list,
 * so the order is canonical and two branches that add tests to the same control merge without a conflict unless their
 * entries sort next to each other. Clauses name their tests by text, so the order carries no meaning. Nothing is removed: a listed test the run did not report fails the trace,
 * and whoever renamed or removed it corrects the entry and any clause that names it. A test that did not pass is not
 * added (the trace refuses a listed test that did not run, and fails a failing one anyway).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML, { isSeq, Scalar, YAMLSeq } from 'yaml';
import { CONTROLS_DIR, type ControlRecord } from './register.ts';
import { controlTags, listsResult, type TestResult } from './trace.ts';

/** The canonical order of a control's tests list: by UTF-16 code unit, independent of locale. */
export function compareEntries(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The index of the first entry of a tests list that sorts before the one above it, or -1 when the list is sorted. */
/** The index of the first entry a tests list already holds earlier, or -1 (a test is listed once). */
export function firstDuplicate(tests: readonly string[]): number {
  const seen = new Set<string>();
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i] ?? '';
    if (seen.has(t)) return i;
    seen.add(t);
  }
  return -1;
}

export function firstUnsorted(tests: readonly string[]): number {
  for (let i = 1; i < tests.length; i++) if (compareEntries(tests[i - 1] ?? '', tests[i] ?? '') > 0) return i;
  return -1;
}

/** Per control id, the entries its tests list lacks: passing tests tagged with it that the list does not name. */
export function testsToAdd(controls: readonly ControlRecord[], results: readonly TestResult[]): Map<string, string[]> {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const order = new Map<string, number>();
  const add = new Map<string, Set<string>>();
  for (const r of results) {
    if (r.status !== 'passed' || r.entry === undefined) continue;
    for (const id of controlTags(r.name)) {
      const c = byId.get(id);
      if (!c || listsResult(c, r)) continue;
      if (!order.has(r.entry)) order.set(r.entry, order.size);
      add.set(id, (add.get(id) ?? new Set()).add(r.entry));
    }
  }
  const file = (entry: string): string => entry.slice(0, entry.indexOf(' > '));
  const sorted = (entries: Set<string>): string[] =>
    [...entries].sort((a, b) => (file(a) < file(b) ? -1 : file(a) > file(b) ? 1 : (order.get(a) ?? 0) - (order.get(b) ?? 0)));
  return new Map([...add].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, entries]) => [id, sorted(entries)]));
}

/** Sorts a YAML `tests` sequence in place (block style). */
function sortSeq(seq: YAMLSeq): void {
  seq.flow = false;
  const text = (item: unknown): string => String(item instanceof Scalar ? item.value : item);
  seq.items.sort((a, b) => compareEntries(text(a), text(b)));
}

/**
 * Adds the entries to each control's YAML `tests` list (double-quoted, like the entries written by hand) and sorts the
 * list, leaving the rest of the file as it is. Returns the number of entries added.
 */
export function appendListedTests(additions: ReadonlyMap<string, readonly string[]>, dir = CONTROLS_DIR): number {
  let added = 0;
  for (const [id, entries] of additions) {
    if (entries.length === 0) continue;
    const path = join(dir, `${id}.yaml`);
    const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
    const quoted = (entry: string): Scalar => Object.assign(new Scalar(entry), { type: Scalar.QUOTE_DOUBLE });
    const seq = doc.get('tests', true);
    if (isSeq(seq)) {
      seq.items.push(...entries.map(quoted));
      sortSeq(seq);
    } else {
      const list = new YAMLSeq<Scalar>();
      list.items.push(...entries.map(quoted));
      sortSeq(list);
      doc.set('tests', list);
    }
    writeFileSync(path, doc.toString({ lineWidth: 0, blockQuote: 'literal' }));
    added += entries.length;
  }
  return added;
}

/** Sorts every control's `tests` list that is not sorted yet, leaving the rest of each file as it is. Returns the ids. */
export function sortListedTests(controls: readonly ControlRecord[], dir = CONTROLS_DIR): string[] {
  const sorted: string[] = [];
  for (const c of controls) {
    if (firstUnsorted(c.tests) < 0) continue;
    const path = join(dir, `${c.id}.yaml`);
    const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
    const seq = doc.get('tests', true);
    if (!isSeq(seq)) continue;
    sortSeq(seq);
    writeFileSync(path, doc.toString({ lineWidth: 0, blockQuote: 'literal' }));
    sorted.push(c.id);
  }
  return sorted;
}
