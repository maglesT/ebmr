/**
 * The database refuses a library entry that stores a value in a field its condition hides, as the engine does
 * (recipe-core 1928; follow-up to injectables review pass item 3, lead's ruling of 14 November 2026).
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
import { byCode, issueItem, recordNominal } from './seed-support.ts';

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

describe('the database refuses a value in a field its condition hides, as the engine does (recipe-core 1928)', () => {
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

  it('[PR-03][PR-29] the engine reads a condition from the submission and the database from the stored entry, and they agree: a nested condition (its field hidden by its own condition), an optional condition field left empty, and a key that is no field is refused before any condition is read', async () => {
    // INJ-STERILE-FILTER: validationRef is shown when extendedUseValidated is yes, which is shown when firstUseToday is no.
    const item = byCode('INJ-STERILE-FILTER');
    const section = item.definition.sections.find((s) => s.id === 'filter')!;
    const run = (assign: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const { batch, def, config, mbr } = issueItem(item);
      const full = fullEntry(def, config, section);
      batch.start('p');
      const old = encodeState(batch.state) as Json;
      const shaped = shaper(full, section, assign)(full);
      return { batch, def, config, mbr, full, old, shaped, extra, content: { ...(JSON.parse(JSON.stringify(mbr)) as Json), blockDefinitions: [def] } };
    };
    const engineRefuses = (r: ReturnType<typeof run>, entry: Record<string, unknown>): string =>
      r.batch.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: substituteBatch({ ...r.shaped, ...entry, ...r.extra }, r.batch.state.header.batchNumber) }).message;
    const stored = (r: ReturnType<typeof run>, assign: Record<string, unknown>): { next: Json; key: string; data: Json } => {
      recordNominal(r.batch, 'p', r.def, r.config, r.mbr, {}, (e) => (e.kind === section.id ? { ...shaper(r.full, section, assign)(e), ...r.extra } : e));
      const next = encodeState(r.batch.state) as Json;
      const entries = next['entries'] as Record<string, Entry & { data: Json }>;
      const key = Object.keys(entries).filter((k) => !(k in (r.old['entries'] as Json)) && entries[k]?.kind === section.id).sort()[0]!;
      return { next, key, data: entries[key]!.data };
    };
    const forge = (next: Json, key: string, data: Json): Json => {
      const entries = next['entries'] as Record<string, Json>;
      return { ...next, entries: { ...entries, [key]: { ...entries[key], data } } };
    };

    // Nested: first use today (yes) hides extendedUseValidated, and so validationRef too.
    const a = run({ firstUseToday: true });
    expect(engineRefuses(a, { extendedUseValidated: true, validationRef: 'VAL-1' })).toMatch(/applies only when firstUseToday is false; leave it empty/);
    expect(engineRefuses(a, { validationRef: 'VAL-1' })).toMatch(/applies only when extendedUseValidated is true; leave it empty/);
    const sa = stored(a, { firstUseToday: true });
    expect('extendedUseValidated' in sa.data || 'validationRef' in sa.data).toBe(false);
    expect(await problem(a.content, a.old, sa.next)).toBeNull();
    expect(await problem(a.content, a.old, forge(sa.next, sa.key, { ...sa.data, extendedUseValidated: true, validationRef: 'VAL-1' }))).toMatch(/^stores extendedUseValidated = true in entry .*applies only when firstUseToday is false \(LIB-ENTRY-HIDDEN\)$/);
    expect(await problem(a.content, a.old, forge(sa.next, sa.key, { ...sa.data, validationRef: 'VAL-1' }))).toMatch(/^stores validationRef = "VAL-1" in entry .*applies only when extendedUseValidated is true \(LIB-ENTRY-HIDDEN\)$/);

    // Shown at both levels: the engine stores both, and the database accepts them.
    const b = run({ firstUseToday: false, extendedUseValidated: true });
    const sb = stored(b, { firstUseToday: false, extendedUseValidated: true });
    expect(sb.data).toMatchObject({ firstUseToday: false, extendedUseValidated: true });
    expect(sb.data['validationRef']).toBeDefined();
    expect(await problem(b.content, b.old, sb.next)).toBeNull();

    // A key that is no field of the section is refused by the entry schema before the handler reads any condition
    // (ENG-ENTRY-SCHEMA), so the stored data holds only fields and the database reads a condition from the same values.
    const c = run({ firstUseToday: true }, { readingId: 'R-1' });
    expect(engineRefuses(c, {})).toMatch(/filter\.readingId is not a field of this block \(unknown fields are refused\)/);
    const sc = stored(run({ firstUseToday: true }), { firstUseToday: true });
    // Besides fields, the stored data holds only the facts the server read (lots, equipment) and the server's calculated
    // figures (computed); a condition names a field of its section (LIB-SHOW-WHEN), never one of these.
    const others = Object.keys(sc.data).filter((k) => !section.fields.some((f) => f.id === k));
    expect(others.every((k) => ['computed', 'lots', 'equipment'].includes(k)), others.join(', ')).toBe(true);
    expect(section.fields.some((f) => ['computed', 'lots', 'equipment'].includes(f.showWhen?.field ?? ''))).toBe(false);
  }, 120_000);

  it('[PR-03][PR-29] every condition of the catalogue names a yes/no or choice field of its own section, so each is swept above; the others are calculated fields (1862) or timers', () => {
    for (const c of CONDITIONS) {
      const ctrl = c.section.fields.find((x) => x.id === c.field.showWhen?.field);
      expect(ctrl?.type === 'YES_NO' || ctrl?.type === 'CHOICE', `${c.item.definition.code} ${c.section.id}.${c.field.id}`).toBe(true);
    }
    expect(CONDITIONS.filter((c) => !CASES.includes(c)).every((c) => c.field.type === 'CALC' || c.field.type === 'TIMER')).toBe(true);
  });
});
