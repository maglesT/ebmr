/**
 * Completes the controls' `tests` lists from a run (review F15, round 2): every test tagged with a control that passed
 * and that the control's list does not name yet is added, as `<file> > <describe> > ... > <title>` with every
 * describe, from the names the run reported (so titles built from data are added exactly). The trace refuses such a
 * test until it is listed (trace.ts), so a list cannot drift as tagged tests are added.
 *
 * The entries already listed stay where they are (a clause names them); the added ones follow, in file order and, in
 * a file, in the order the run reported them. Nothing is removed: a listed test the run did not report fails the trace,
 * and whoever renamed or removed it corrects the entry and any clause that names it. A test that did not pass is not
 * added (the trace refuses a listed test that did not run, and fails a failing one anyway).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML, { isSeq, Scalar, YAMLSeq } from 'yaml';
import { CONTROLS_DIR, type ControlRecord } from './register.ts';
import { controlTags, listsResult, type TestResult } from './trace.ts';

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

/**
 * Appends the entries to each control's YAML `tests` list (double-quoted, like the entries written by hand), leaving
 * the rest of the file as it is. Returns the number of entries added.
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
      seq.flow = false;
      seq.items.push(...entries.map(quoted));
    } else {
      const list = new YAMLSeq<Scalar>();
      list.items.push(...entries.map(quoted));
      doc.set('tests', list);
    }
    writeFileSync(path, doc.toString({ lineWidth: 0, blockQuote: 'literal' }));
    added += entries.length;
  }
  return added;
}
