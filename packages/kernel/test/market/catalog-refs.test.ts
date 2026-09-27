/**
 * India review check (ADR 0008 decision 12; build outline 3.3.6): every key India governs cites the
 * India catalog row (section B) its value was reviewed against, and every cited control exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_TABLES } from '../../src/market/types.ts';
import { seedDocument } from './helpers.ts';

const CATALOG = new URL('../../../../docs/regulatory/control-catalogs/D-india-schedule-m.md', import.meta.url).pathname;
const CONTROLS = new URL('../../../../compliance/controls/', import.meta.url).pathname;

function sectionBRows(): Set<string> {
  const text = readFileSync(CATALOG, 'utf8');
  const start = text.indexOf('## B. Market-profile resolution table');
  const end = text.indexOf('## C.', start);
  return new Set([...text.slice(start, end).matchAll(/^\| (B-\d{2}) \|/gm)].map((m) => m[1] ?? ''));
}

describe('rule keys are reviewed against the India catalog', () => {
  const rowsB = sectionBRows();

  it('[IN-52] the India catalog section B lists rows B-01 to B-26', () => {
    expect(rowsB.size).toBe(26);
  });

  for (const table of RULE_TABLES) {
    it(`[IN-52] every key India governs in the ${table} table cites an existing India catalog row, and every cited control exists`, () => {
      for (const key of seedDocument(table).keys) {
        const refs = key.catalogRefs ?? [];
        if (key.indiaGoverns) expect(refs.filter((r) => r.startsWith('B-')), key.key).not.toEqual([]);
        for (const ref of refs) {
          if (ref.startsWith('B-')) expect(rowsB.has(ref), `${key.key} cites ${ref}`).toBe(true);
          else expect(existsSync(`${CONTROLS}${ref}.yaml`), `${key.key} cites ${ref}`).toBe(true);
        }
      }
    });
  }
});
