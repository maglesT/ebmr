/**
 * ADR 0023 decision 5 (a) for family 6.1, field visibility: the hand-written copies (the engine's `shown` before the
 * switch-over, and the guards' condition in recipe-core 1862 and 1928) and the copies generated from FIELD_SHOWN (the
 * interpreter the engine now calls, and recipe.rule_library_field_shown) give the same verdict on the seeded corpus:
 * every field of every block of the seed catalogue, on its section's nominal entries and on those entries with each
 * condition's field given every answer of its type, left out, and given a value of the wrong JSON type; and on the
 * entries of the bypass tests. Zero differences. Outside that corpus, on fields no definition check admits, the copies
 * do differ; each such difference is pinned below with the copy that is right (decision 5: decided on its merits).
 *
 * Controls: PR-03 (the master's content decides what is recorded), PR-29 (in-process checks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Json } from '@ebmr/rules';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { nominalEntries } from '../../src/library/index.ts';
import type { FieldDef, SectionDef } from '../../src/library/model.ts';
import { CAPSULE_CATALOGUE, INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_CATALOGUE, INJECTABLE_INSPECTION_CATALOGUE, INJECTABLE_LYO_CATALOGUE, INJECTABLE_ROUTE_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { differences, legacyGuardCondition, LEGACY_CONDITION, verdicts, type Pair } from './field-shown-differential.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const MIGRATIONS = new URL('../../sql/', import.meta.url);

/** Every block of every seed catalogue, once. */
const ITEMS: SeedItem[] = [
  ...new Map(
    [SEED_CATALOGUE, CAPSULE_CATALOGUE, INJECTABLE_CATALOGUE, INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_LYO_CATALOGUE, INJECTABLE_ROUTE_CATALOGUE, INJECTABLE_INSPECTION_CATALOGUE]
      .flat()
      .map((i) => [`${i.definition.code}@${i.definition.version}`, i] as const),
  ).values(),
];

/** Values of the wrong JSON type, or none, for a condition's field. */
const ODD: readonly (Json | undefined)[] = [undefined, null, 'true', 'false', '', 1, 0, [], {}, [true], { value: true }];

/** The answers a condition's field can be given: those of its type, then the odd ones. */
function answers(f: FieldDef, equals: Json): (Json | undefined)[] {
  const own: Json[] = f.type === 'YES_NO' ? [true, false] : f.type === 'CHOICE' ? [...f.options] : [];
  return [...own, equals, typeof equals === 'string' ? equals.toUpperCase() : JSON.stringify(equals), ...ODD];
}

function catalogueCorpus(): { pairs: Pair[]; conditions: number } {
  const pairs: Pair[] = [];
  let conditions = 0;
  for (const item of ITEMS) {
    const def = item.definition;
    const nominal = nominalEntries(def, item.exampleUse as never);
    for (const s of def.sections) {
      const base: Record<string, Json> = (nominal.find((e) => e.kind === s.id) as Record<string, Json> | undefined) ?? {};
      const entries: { label: string; values: Json }[] = [{ label: 'nominal', values: base }, { label: 'empty', values: {} }];
      for (const c of new Set(s.fields.flatMap((f) => (f.showWhen ? [f.showWhen.field] : [])))) {
        const ctrl = s.fields.find((f) => f.id === c);
        const equals = s.fields.find((f) => f.showWhen?.field === c)?.showWhen?.equals ?? null;
        for (const a of ctrl ? answers(ctrl, equals) : ODD) {
          const values: Record<string, Json> = { ...base };
          if (a === undefined) delete values[c];
          else values[c] = a;
          entries.push({ label: `${c}=${JSON.stringify(a) ?? 'absent'}`, values });
        }
      }
      for (const f of s.fields) {
        if (f.showWhen) conditions++;
        for (const e of entries) pairs.push({ label: `${def.code} ${s.id}.${f.id} ${e.label}`, field: f as unknown as Json, values: e.values });
      }
    }
  }
  return { pairs, conditions };
}

/**
 * The entries of the bypass tests of the hidden-field guard (apps/tablets-server/test/mutation/library-blocks.test.ts,
 * recipe-core 1928): a value with the condition answered otherwise, not answered, answered with the wrong JSON type,
 * JSON null; a second hidden field; shown fields; hidden fields left empty.
 */
function bypassCorpus(): Pair[] {
  const section: SectionDef = {
    id: 'rework',
    title: 'Rework',
    fields: [
      { id: 'reworked', label: 'Reworked', type: 'YES_NO' },
      { id: 'reason', label: 'Reason', type: 'TEXT', showWhen: { field: 'reworked', equals: true } },
      { id: 'kind', label: 'Kind', type: 'CHOICE', options: ['MILL', 'SIEVE'], showWhen: { field: 'reworked', equals: true } },
      { id: 'note', label: 'Note', type: 'TEXT', showWhen: { field: 'kind', equals: 'SIEVE' } },
    ],
  } as unknown as SectionDef;
  const data: Record<string, Json>[] = [
    { reworked: false, reason: 'x' },
    { reason: 'x' },
    { reworked: 'true', reason: 'x' },
    { reworked: 1, reason: 'x' },
    { reworked: null, reason: 'x' },
    { reworked: false, reason: null },
    { reworked: false, reason: 'x', kind: 'MILL' },
    { reworked: true, reason: 'x', kind: 'MILL' },
    { reworked: true, reason: 'x', kind: 'SIEVE', note: 'n' },
    { reworked: true, kind: 'MILL', note: 'n' },
    { reworked: false },
    {},
  ];
  return section.fields.flatMap((f) => data.map((values, i) => ({ label: `bypass ${f.id} #${i}`, field: f as unknown as Json, values })));
}

describe('family 6.1: the copies of field visibility agree (ADR 0023, decision 5 (a))', () => {
  it('[PR-03][PR-29] the harness compares the guards as written: recipe-core 1862 holds the visibility condition it runs', () => {
    expect(legacyGuardCondition(new URL('1862_library_limits_judgement.sql', MIGRATIONS))).toBe(LEGACY_CONDITION);
    expect(() => legacyGuardCondition(new URL('1930_rules_generated.sql', MIGRATIONS))).toThrow(/does not hold/);
  });

  it('[PR-03][PR-29] zero differences on the seeded corpus: every field of every seed block, on its nominal entries and with every condition\'s field answered every way', async () => {
    const { pairs, conditions } = catalogueCorpus();
    // The catalogue holds 36 conditions (14 November 2026); every field is compared, conditioned or not.
    expect(conditions).toBeGreaterThanOrEqual(36);
    expect(pairs.length).toBeGreaterThan(4000);
    expect(await differences(db.admin, pairs)).toEqual([]);
    // The corpus reaches both verdicts.
    const vs = await verdicts(db.admin, pairs);
    expect(vs.filter((v) => !v.generated).length).toBeGreaterThan(500);
  }, 120_000);

  it('[PR-03][PR-29] zero differences on the entries of the bypass tests', async () => {
    const pairs = bypassCorpus();
    expect(await differences(db.admin, pairs)).toEqual([]);
    const vs = await verdicts(db.admin, pairs);
    expect(vs.filter((v) => !v.generated).length).toBeGreaterThan(20);
    expect(vs.filter((v) => v.generated).length).toBeGreaterThan(15);
  });

  it('[PR-03][PR-29] outside the corpus, on conditions no definition check admits (LIB-SHOW-WHEN), the copies differ; each difference is decided here', async () => {
    const values = { ok: true, '5': true, '': true, constructor: true };
    const at = async (field: Json, v: Json | undefined) => (await verdicts(db.admin, [{ label: 'x', field, values: v }]))[0];
    // A condition naming a number: the hand-written copies read the key "5" (JavaScript turns the index into text, and
    // `->>` gives its text); the definition names no key that is not a string, so the field is hidden. Hidden is right:
    // the condition names no field (LIB-SHOW-WHEN refuses it), and a hidden field must stay empty, the stricter verdict.
    expect(await at({ id: 'r', showWhen: { field: 5, equals: true } }, values)).toEqual({ legacyEngine: true, engine: false, legacyGuard: true, generated: false });
    // showWhen JSON null: the engine before threw (it read null.field); every other copy shows the field, as for no
    // condition at all. Not a difference of verdict: an entry was refused, now it is judged as having no condition, which
    // the definition check refuses before any master is approved.
    expect(await at({ id: 'r', showWhen: null }, values)).toEqual({ legacyEngine: 'throws', engine: true, legacyGuard: true, generated: true });
    // Every copy agrees on the other odd shapes: an inherited key, a condition with no answer, an object answer, a
    // condition that is a string or an empty object, and an entry with no data at all.
    for (const [field, v, shown] of [
      [{ id: 'r', showWhen: { field: 'constructor', equals: true } }, {}, false],
      [{ id: 'r', showWhen: { field: 'toString', equals: true } }, values, false],
      [{ id: 'r', showWhen: { field: 'missing' } }, values, true],
      [{ id: 'r', showWhen: { field: 'missing' } }, { missing: null }, false],
      [{ id: 'r', showWhen: { field: '', equals: true } }, values, true],
      [{ id: 'r', showWhen: 'ok' }, values, true],
      [{ id: 'r', showWhen: {} }, values, true],
      [{ id: 'r', showWhen: { field: 'ok', equals: true } }, undefined, false],
      [{ id: 'r' }, undefined, true],
    ] as const) {
      expect(await at(field as Json, v as Json | undefined), JSON.stringify(field)).toEqual({ legacyEngine: shown, engine: shown, legacyGuard: shown, generated: shown });
    }
  });
});
