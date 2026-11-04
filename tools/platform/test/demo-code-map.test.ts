/**
 * Phase B slice 5 (lead decision of 4 Nov 2026, option d): the map from today's Batchwright demo codes to the platform's
 * demo company (databsee docs/demo-company.md), which the move uses to link local codes to master items (PL-07: the
 * local records keep their codes; PL-08: the write-time check then finds the master item through the link).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MAP = JSON.parse(readFileSync(new URL('../demo-code-map.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const KINDS = ['product', 'room', 'equipment', 'instrument', 'material'];
/** The master_data code rule (databsee db/master_data: item.code). */
const MASTER_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
/** The demo company's code families per kind (docs/demo-company.md). */
const FAMILY: Record<string, RegExp> = { product: /^FG-/, room: /^RM-1\d\d$/, equipment: /^EQ-[A-Z]+-\d\d$/, instrument: /^IN-[A-Z]+-\d\d$/, material: /^(API|EXC|SOL|PKG)-/ };

describe('the demo code map (PL-07, PL-08)', () => {
  it('[PL-08] maps each kind one to one, onto master codes of the demo company\'s families', () => {
    expect(Object.keys(MAP).filter((k) => k !== '_comment').sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      const pairs = Object.entries(MAP[kind] as Record<string, string>);
      expect(pairs.length, kind).toBeGreaterThan(0);
      const targets = pairs.map(([, to]) => to);
      expect(new Set(targets).size, `${kind}: two codes onto one master item`).toBe(targets.length);
      for (const [from, to] of pairs) {
        expect(from, kind).toMatch(MASTER_CODE);
        expect(to, `${kind} ${from}`).toMatch(MASTER_CODE);
        expect(to, `${kind} ${from}`).toMatch(FAMILY[kind] as RegExp);
      }
    }
  });
});
