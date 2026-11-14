/**
 * The database refuses a library entry that stores a value in a field its condition hides, as the engine does
 * (recipe-core 1925; follow-up to injectables review pass item 3, lead's ruling of 14 November 2026).
 *
 * Parity: every field of the seed catalogue that carries a condition (showWhen), other than a calculated field (1862
 * judges those through `computed`) and a timer, is recorded through the engine (the generic handler, block-version.ts)
 * with its condition met and with it not met. The row the engine writes is accepted by recipe.library_hidden_problem in
 * both. With the condition not met, the engine refuses the entry that still gives the field a value (LIB-ENTRY-HIDDEN),
 * and the database refuses the engine's row with that value put back into the stored entry, naming the field. So the two
 * give the same verdict on the same inputs. The bypass tests (the trigger itself, written through the application role)
 * are in apps/tablets-server/test/mutation/library-blocks.test.ts.
 *
 * Controls: PR-03 (the master's content decides what is recorded), PR-29 (in-process checks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeState } from '../../src/engine/codec.ts';
import { nominalEntries } from '../../src/library/index.ts';
import type { BlockDefinition, FieldDef, SectionDef } from '../../src/library/model.ts';
import { SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { OP1, substituteBatch } from '../engine/support.ts';
import { issueItem, recordNominal } from './seed-support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

type Json = Record<string, unknown>;
type Entry = Record<string, unknown> & { kind: string };

/** block-version.ts shown: no condition, or its field holds the given answer. */
const shown = (f: FieldDef, e: Readonly<Record<string, unknown>>): boolean => f.showWhen === undefined || e[f.showWhen.field] === f.showWhen.equals;

interface Case {
  item: SeedItem;
  section: SectionDef;
  field: FieldDef;
}
/** Every condition of the catalogue, by field. */
const CONDITIONS: Case[] = SEED_CATALOGUE.flatMap((item) =>
  item.definition.sections.flatMap((section) => section.fields.filter((f) => f.showWhen !== undefined).map((field) => ({ item, section, field }))),
);
/** Those judged here: a calculated field's condition is judged by 1862, a timer is recorded as its own entries. */
const CASES = CONDITIONS.filter((c) => c.field.type !== 'CALC' && c.field.type !== 'TIMER');

/** The section's nominal entry as nominalEntries gives it with no conditions (every field has its nominal value). */
function fullEntry(def: BlockDefinition, config: Record<string, unknown>, section: SectionDef): Entry {
  const open: BlockDefinition = {
    ...def,
    sections: def.sections.map((s) => (s.id === section.id ? { ...s, fields: s.fields.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'showWhen')) as unknown as FieldDef) } : s)),
  };
  return nominalEntries(open, config as never).find((e) => e.kind === section.id) ?? { kind: section.id };
}

/** The section's entries with `assign` applied, then each field the result hides left out and each it shows given its nominal value. */
function shaper(full: Entry, section: SectionDef, assign: Record<string, unknown>): (e: Entry) => Entry {
  return (e) => {
    if (e.kind !== section.id) return e;
    const out: Entry = { ...e, ...assign };
    for (const f of section.fields) {
      if (!shown(f, out)) delete out[f.id];
      else if (!(f.id in out) && full[f.id] !== undefined) out[f.id] = full[f.id];
    }
    return out;
  };
}

/** An answer of the condition's field other than the one that shows the field (a yes/no's other answer, another option). */
function otherAnswer(c: Case): unknown {
  const w = c.field.showWhen;
  if (w === undefined) return undefined;
  const ctrl = c.section.fields.find((x) => x.id === w.field);
  if (ctrl?.type === 'YES_NO') return !w.equals;
  if (ctrl?.type === 'CHOICE') return ctrl.options.find((o) => o !== w.equals);
  return undefined;
}

async function problem(content: Json, old: Json, next: Json): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.library_hidden_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [
    JSON.stringify(content),
    JSON.stringify(old),
    JSON.stringify(next),
  ]);
  return rows[0]?.p ?? null;
}

describe('the database refuses a value in a field its condition hides, as the engine does (recipe-core 1925)', () => {
  it('[PR-03][PR-29] parity over every condition of the seed catalogue: with it met and not met the engine\'s row is accepted; not met, the engine refuses a value in the field (LIB-ENTRY-HIDDEN) and the database refuses the engine\'s row with that value put back, naming the field', async () => {
    // The catalogue holds 36 conditions (14 November 2026), none on a calculated field or a timer; every one is swept.
    expect(CASES.length).toBeGreaterThanOrEqual(36);
    const mismatches: string[] = [];
    let runs = 0;
    for (const c of CASES) {
      const label = `${c.item.definition.code} ${c.section.id}.${c.field.id}`;
      const w = c.field.showWhen;
      const other = otherAnswer(c);
      if (w === undefined || other === undefined) {
        mismatches.push(`${label}: its condition's field ${w?.field ?? '?'} has no other answer to hide it with`);
        continue;
      }
      for (const [name, answer] of [['met', w.equals], ['not met', other]] as const) {
        const { batch, def, config, mbr } = issueItem(c.item);
        const full = fullEntry(def, config, c.section);
        const value = full[c.field.id] ?? '1';
        batch.start('p');
        const old = encodeState(batch.state) as Json;
        const content = { ...(JSON.parse(JSON.stringify(mbr)) as Json), blockDefinitions: [def] };
        if (name === 'not met') {
          // The engine refuses the entry that still gives the hidden field a value, before anything is recorded.
          const bad = { ...shaper(full, c.section, { [w.field]: answer })(full), [c.field.id]: value };
          const refusal = batch.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: substituteBatch(bad, batch.state.header.batchNumber) });
          if (!refusal.message.includes(`${c.field.label} applies only when ${w.field} is ${String(w.equals)}; leave it empty`)) mismatches.push(`${label}: the engine refused with ${refusal.code}: ${refusal.message}`);
        }
        recordNominal(batch, 'p', def, config, mbr, {}, shaper(full, c.section, { [w.field]: answer }));
        const next = encodeState(batch.state) as Json;
        runs++;
        const accepted = await problem(content, old, next);
        if (accepted !== null) mismatches.push(`${label} ${name}: the engine's row is refused: ${accepted}`);
        const entries = next['entries'] as Record<string, Entry & { data: Json }>;
        const added = Object.keys(entries).filter((k) => !(k in (old['entries'] as Json)) && entries[k]?.kind === c.section.id).sort();
        const key = added[0];
        if (key === undefined) {
          mismatches.push(`${label} ${name}: the engine recorded no entry of ${c.section.id}`);
          continue;
        }
        const stored = entries[key]!;
        const shownHere = stored.data[w.field] === w.equals;
        if (shownHere !== (name === 'met')) mismatches.push(`${label} ${name}: the stored entry holds ${w.field} = ${JSON.stringify(stored.data[w.field])}`);
        if (name === 'met') continue;
        if (c.field.id in stored.data) mismatches.push(`${label}: the engine stored the hidden field`);
        const forged = { ...next, entries: { ...entries, [key]: { ...stored, data: { ...stored.data, [c.field.id]: value } } } };
        const refused = await problem(content, old, forged);
        if (refused === null || !refused.startsWith(`stores ${c.field.id} = `) || !refused.endsWith('(LIB-ENTRY-HIDDEN)')) mismatches.push(`${label}: with the value put back the database gives ${refused ?? 'no problem'}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(runs).toBe(2 * CASES.length);
  }, 600_000);

  it('[PR-03][PR-29] every condition of the catalogue names a yes/no or choice field of its own section, so each is swept above; the others are calculated fields (1862) or timers', () => {
    for (const c of CONDITIONS) {
      const ctrl = c.section.fields.find((x) => x.id === c.field.showWhen?.field);
      expect(ctrl?.type === 'YES_NO' || ctrl?.type === 'CHOICE', `${c.item.definition.code} ${c.section.id}.${c.field.id}`).toBe(true);
    }
    expect(CONDITIONS.filter((c) => !CASES.includes(c)).every((c) => c.field.type === 'CALC' || c.field.type === 'TIMER')).toBe(true);
  });
});
