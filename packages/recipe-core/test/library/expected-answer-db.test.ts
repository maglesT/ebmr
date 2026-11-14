/**
 * The database re-checks the expected yes/no answers and the not-allowed choices of a library block as the engine judges
 * them (recipe-core 1924; injectables review pass item 3, lead's ruling of 14 November 2026).
 *
 * - Carried forward: 1924's recipe.library_limits_problem and recipe.library_limits_check are 1862's text with lines
 *   added and the two type lists of the exceptions matched widened; no line of 1862 is removed
 *   (docs/build-plan/injectables/expected-answer-db-1862.diff).
 * - Parity: every expected answer and every not-allowed choice of the seed catalogue, in every section that holds one,
 *   is recorded through the engine (the generic handler, block-version.ts) with the expected and with the other answer
 *   (each allowed and not-allowed choice), and, for a field with a condition, with the condition hiding it. The row the
 *   engine writes is accepted by recipe.library_limits_problem as it stands; without the engine's answer exceptions it
 *   is refused exactly when the engine raised one. So the two give the same verdict on the same inputs, facts included
 *   (the database matches each exception's facts one for one).
 * - Bypass: a critical answer stored as ACTION, an answer exception added for no unexpected answer (also in a row that
 *   adds no entry), and an omitted one are refused.
 *
 * Controls: PR-29 (in-process checks and their exceptions), PR-08 (the limit model's exceptions, one for one).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeState } from '../../src/engine/codec.ts';
import { nominalEntries } from '../../src/library/index.ts';
import type { BlockDefinition, FieldDef, SectionDef } from '../../src/library/model.ts';
import { SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
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
const ANSWER_TYPES = new Set(['LIB_UNEXPECTED_ANSWER', 'LIB_NOT_ALLOWED_CHOICE']);

const SQL = new URL('../../sql/', import.meta.url).pathname;
/** The lines of function `name`'s CREATE in migration `file`, from its header comment line to its closing `$$;`. */
function body(file: string, name: string): string[] {
  const lines = readFileSync(SQL + file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`create or replace function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '$$;');
  if (start < 0 || end < 0) throw new Error(`no ${name} in ${file}`);
  return lines.slice(start, end + 1);
}

/** block-version.ts shown: no condition, or its field holds the given answer. */
const shown = (f: FieldDef, e: Readonly<Record<string, unknown>>): boolean => f.showWhen === undefined || e[f.showWhen.field] === f.showWhen.equals;

/** The fields of the catalogue the engine judges as answers: a YES_NO with an expected answer, a CHOICE with a not-allowed option. */
interface Case {
  item: SeedItem;
  section: SectionDef;
  field: FieldDef;
}
const CASES: Case[] = SEED_CATALOGUE.flatMap((item) =>
  item.definition.sections.flatMap((section) =>
    section.fields
      .filter((f) => (f.type === 'YES_NO' && f.expected !== undefined) || (f.type === 'CHOICE' && (f.notAllowed ?? []).length > 0))
      .map((field) => ({ item, section, field })),
  ),
);

/**
 * The section's entries with `assign` applied, then each field the result hides left out and each field it shows that the
 * nominal entry lacks given its nominal value (as nominalEntries gives it with no conditions).
 */
function shaper(def: BlockDefinition, config: Record<string, unknown>, section: SectionDef, assign: Record<string, unknown>): (e: Entry) => Entry {
  const open: BlockDefinition = { ...def, sections: def.sections.map((s) => (s.id === section.id ? { ...s, fields: s.fields.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'showWhen')) as unknown as FieldDef) } : s)) };
  const full = nominalEntries(open, config as never).find((e) => e.kind === section.id) ?? { kind: section.id };
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

interface Outcome {
  content: Json;
  old: Json;
  next: Json;
  /** The answer exceptions the engine raised (their ids). */
  raised: string[];
}

/** The catalogue item's nominal entries recorded through the engine, the section's entries shaped by `assign`. */
function record(item: SeedItem, section: SectionDef, assign: Record<string, unknown>): Outcome {
  const { batch, def, config, mbr } = issueItem(item);
  batch.start('p');
  const old = encodeState(batch.state) as Json;
  recordNominal(batch, 'p', def, config, mbr, {}, shaper(def, config, section, assign));
  const next = encodeState(batch.state) as Json;
  const raised = Object.entries(batch.state.exceptions).filter(([k, x]) => !(k in (old['exceptions'] as Json)) && ANSWER_TYPES.has(x.type)).map(([k]) => k);
  return { content: { ...(JSON.parse(JSON.stringify(mbr)) as Json), blockDefinitions: [def] }, old, next, raised };
}

async function problem(content: Json, old: Json, next: Json): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.library_limits_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [
    JSON.stringify(content),
    JSON.stringify(old),
    JSON.stringify(next),
  ]);
  return rows[0]?.p ?? null;
}

const without = (state: Json, ids: readonly string[]): Json => ({
  ...state,
  exceptions: Object.fromEntries(Object.entries(state['exceptions'] as Json).filter(([k]) => !ids.includes(k))),
});

/** The answers a case records: the expected and the other answer, each allowed and not-allowed choice; and hidden. */
function variants(c: Case): { name: string; assign: Record<string, unknown>; raises: boolean }[] {
  const f = c.field;
  const r = c.section.repeat;
  // A loop's YES_NO endpoint is the loop's to judge; any other endpoint once the loop is exhausted (one entry here, so
  // never exhausted unless the loop allows one repeat).
  const endpoint = r?.kind === 'UNTIL_PASS' && r.untilField === f.id;
  const show: Record<string, unknown> = f.showWhen !== undefined ? { [f.showWhen.field]: f.showWhen.equals } : {};
  const out: { name: string; assign: Record<string, unknown>; raises: boolean }[] = [];
  if (f.type === 'YES_NO' && f.expected !== undefined) {
    out.push({ name: 'expected', assign: { ...show, [f.id]: f.expected }, raises: false });
    out.push({ name: 'unexpected', assign: { ...show, [f.id]: !f.expected }, raises: !endpoint });
  }
  if (f.type === 'CHOICE') {
    for (const o of f.options) out.push({ name: `choice ${o}`, assign: { ...show, [f.id]: o }, raises: (f.notAllowed ?? []).includes(o) && !endpoint });
  }
  if (f.showWhen !== undefined) {
    const ctrl = c.section.fields.find((x) => x.id === f.showWhen?.field);
    const other = ctrl?.type === 'YES_NO' ? !f.showWhen.equals : ctrl?.type === 'CHOICE' ? ctrl.options.find((o) => o !== f.showWhen?.equals) : undefined;
    if (other !== undefined) out.push({ name: 'hidden', assign: { [f.showWhen.field]: other }, raises: false });
  }
  return out;
}

describe('the database re-checks expected answers and allowed choices as the engine does (recipe-core 1924)', () => {
  it('[PR-29][PR-08] 1924 carries 1862\'s library_limits_problem and library_limits_check forward: every line of 1862 is kept in order, apart from the two type lists of the exceptions matched, which only add LIB_UNEXPECTED_ANSWER and LIB_NOT_ALLOWED_CHOICE', () => {
    const widen = (l: string): string => l.replace("('LIB_LIMIT_BREACH', 'LIB_REPEAT_LIMIT_REACHED')", "('LIB_LIMIT_BREACH', 'LIB_REPEAT_LIMIT_REACHED', 'LIB_UNEXPECTED_ANSWER', 'LIB_NOT_ALLOWED_CHOICE')");
    for (const name of ['recipe.library_limits_problem', 'recipe.library_limits_check']) {
      const before = body('1862_library_limits_judgement.sql', name);
      const after = body('1924_library_expected_answers.sql', name);
      // Each line of 1862 (a widened type list as widened) is found in 1924 in the same order; the rest of 1924 is added.
      let at = 0;
      const missing: string[] = [];
      let widened = 0;
      for (const l of before) {
        const want = widen(l);
        if (want !== l) widened++;
        const i = after.indexOf(want, at);
        if (i < 0) missing.push(l);
        else at = i + 1;
      }
      expect(missing, name).toEqual([]);
      expect(widened, name).toBe(1);
      const added = after.length - before.length;
      expect(added, name).toBe(name === 'recipe.library_limits_problem' ? 11 : 0);
    }
    // The committed diff is the diff of these bodies: it removes only the two widened lines.
    const diff = readFileSync(new URL('../../../../docs/build-plan/injectables/expected-answer-db-1862.diff', import.meta.url), 'utf8').split('\n');
    const removed = diff.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(removed.map((l) => widen(l.slice(1)) !== l.slice(1))).toEqual([true, true]);
    expect(diff.filter((l) => l.startsWith('+') && !l.startsWith('+++'))).toHaveLength(13);
  });

  it('[PR-29][PR-08] parity over every expected answer and not-allowed choice of the seed catalogue, hidden fields included: the row the engine writes is accepted, and without its answer exceptions it is refused exactly when the engine raised one', async () => {
    // The catalogue holds about 190 expected answers (the assessment's count); every one is swept.
    const yesNo = CASES.filter((c) => c.field.type === 'YES_NO');
    expect(yesNo.length).toBeGreaterThanOrEqual(180);
    expect(CASES.some((c) => c.field.type === 'YES_NO' && c.field.unexpectedCritical === true)).toBe(true);
    const mismatches: string[] = [];
    let runs = 0;
    let raisedRuns = 0;
    let hiddenRuns = 0;
    for (const c of CASES) {
      for (const v of variants(c)) {
        const label = `${c.item.definition.code} ${c.section.id}.${c.field.id} ${v.name}`;
        const o = record(c.item, c.section, v.assign);
        runs++;
        if (v.name === 'hidden') hiddenRuns++;
        // The engine's own verdict on this field (other fields of the section may raise their own).
        const raisedHere = o.raised.filter((k) => ((o.next['exceptions'] as Record<string, Json>)[k]?.['source'] as Json | undefined)?.['item'] === `p.${c.field.id}`);
        if ((raisedHere.length > 0) !== v.raises) mismatches.push(`${label}: the engine raised ${raisedHere.length}, expected ${v.raises ? 'some' : 'none'}`);
        if (raisedHere.length > 0) raisedRuns++;
        const accepted = await problem(o.content, o.old, o.next);
        if (accepted !== null) mismatches.push(`${label}: the engine's row is refused: ${accepted}`);
        const bare = await problem(o.content, o.old, without(o.next, o.raised));
        if ((bare !== null) !== (o.raised.length > 0)) mismatches.push(`${label}: without its ${o.raised.length} answer exceptions the row gives ${bare ?? 'no problem'}`);
        else if (bare !== null && !/without the LIB_(UNEXPECTED_ANSWER|NOT_ALLOWED_CHOICE) it requires/.test(bare)) mismatches.push(`${label}: ${bare}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(raisedRuns).toBeGreaterThanOrEqual(yesNo.length - 10);
    expect(hiddenRuns).toBeGreaterThan(0);
    expect(runs).toBeGreaterThan(2 * yesNo.length);
  }, 600_000);

  it('[PR-29][PR-08] a critical unexpected answer stored as ACTION, without its QA-only or release flags or its downstream block, or with another item, is refused; an answer exception added for no unexpected answer is refused, also in a row that adds no entry', async () => {
    const c = CASES.find((x) => x.field.type === 'YES_NO' && x.field.unexpectedCritical === true);
    if (!c || c.field.type !== 'YES_NO' || c.field.expected === undefined) throw new Error('no critical expected answer in the catalogue');
    const show = c.field.showWhen !== undefined ? { [c.field.showWhen.field]: c.field.showWhen.equals } : {};
    const o = record(c.item, c.section, { ...show, [c.field.id]: !c.field.expected });
    const xs = o.next['exceptions'] as Record<string, Json>;
    const [id] = o.raised.filter((k) => (xs[k]?.['source'] as Json)['item'] === `p.${c.field.id}`);
    if (id === undefined) throw new Error('the engine raised no exception for the critical answer');
    const x = xs[id] as Json;
    expect(x).toMatchObject({ type: 'LIB_UNEXPECTED_ANSWER', severity: 'CRITICAL', qaOnly: true, releaseBlocking: true, deviationRequired: true });
    expect(await problem(o.content, o.old, o.next)).toBeNull();
    const block = x['block'] as Json;
    const weakened: Json[] = [
      { ...x, severity: 'ACTION' },
      { ...x, qaOnly: false },
      { ...x, releaseBlocking: false },
      { ...x, deviationRequired: false },
      { ...x, block: { steps: block['steps'], until: block['until'] } },
      { ...x, source: { ...(x['source'] as Json), item: 'p.other' } },
      { ...x, type: 'LIB_NOT_ALLOWED_CHOICE' },
    ];
    for (const w of weakened) {
      const p = await problem(o.content, o.old, { ...o.next, exceptions: { ...xs, [id]: w } });
      expect(p, JSON.stringify(w)).toMatch(new RegExp(`^stores ${c.field.id} answered ${String(!c.field.expected)} at step p, where ${String(c.field.expected)} is expected, without the LIB_UNEXPECTED_ANSWER it requires \\(severity CRITICAL, deviation required\\)$`));
    }
    // The expected answer: an answer exception added with it is no answer's.
    const fine = record(c.item, c.section, { ...show, [c.field.id]: c.field.expected });
    const spurious = { ...fine.next, exceptions: { ...(fine.next['exceptions'] as Json), XA: { ...x, id: 'XA' } } };
    expect(await problem(fine.content, fine.old, spurious)).toMatch(/^adds exception XA \(LIB_UNEXPECTED_ANSWER, severity CRITICAL, item p\.\w+\), which no value of the row requires with these facts$/);
    // A row that adds no entry, only the exception.
    expect(await problem(fine.content, fine.next, { ...spurious, entries: fine.next['entries'] })).toMatch(/^adds exception XA \(LIB_UNEXPECTED_ANSWER/);
    // A not-allowed choice exception added for no choice.
    const choice = { ...x, id: 'XC', type: 'LIB_NOT_ALLOWED_CHOICE', severity: 'ACTION' };
    expect(await problem(fine.content, fine.next, { ...fine.next, exceptions: { ...(fine.next['exceptions'] as Json), XC: choice } })).toMatch(/^adds exception XC \(LIB_NOT_ALLOWED_CHOICE/);
  });

  it('[PR-29] an unexpected answer and a not-allowed choice of a step instance the state does not hold are refused as such; a field without its expected answer, a choice not in its not-allowed list and a hidden field are not judged', async () => {
    const def: Json = {
      code: 'ANS-KILL',
      version: 1,
      title: 'Answers',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'run',
          title: 'Run',
          fields: [
            { id: 'ok', label: 'OK', type: 'YES_NO', expected: true },
            { id: 'free', label: 'Free', type: 'YES_NO' },
            { id: 'crit', label: 'Critical', type: 'YES_NO', expected: false, unexpectedCritical: true },
            { id: 'how', label: 'How', type: 'CHOICE', options: ['A', 'B', 'C'], notAllowed: ['C'] },
            { id: 'any', label: 'Any', type: 'CHOICE', options: ['A', 'B'] },
            { id: 'more', label: 'More', type: 'YES_NO', expected: true, showWhen: { field: 'how', equals: 'B' } },
          ],
        },
        { id: 'loop', title: 'Loop', repeat: { kind: 'UNTIL_PASS', untilField: 'done', maxRepeatsSlot: 'maxL' }, fields: [{ id: 'done', label: 'Done', type: 'YES_NO', expected: true }, { id: 'pick', label: 'Pick', type: 'CHOICE', options: ['A', 'C'], notAllowed: ['C'] }] },
        { id: 'cloop', title: 'Choice loop', repeat: { kind: 'UNTIL_PASS', untilField: 'sel', maxRepeatsSlot: 'maxS' }, fields: [{ id: 'sel', label: 'Sel', type: 'CHOICE', options: ['A', 'C'], notAllowed: ['C'] }] },
      ],
      signatures: [],
    };
    const content = { procedure: { kind: 'procedure', id: 'proc', children: [{ kind: 'phase', id: 'p', name: 'p', block: { type: 'LIB-ANS-KILL', version: '1' }, config: { counts: { maxL: '3', maxS: '1' } } }] }, blockDefinitions: [def] };
    // p@x names step p but is not the key of its frames, so it is no step instance (recipe.limit_instance).
    const steps = { 'p@': { key: 'p@', step: 'p', frames: [] }, 'p@x': { key: 'p@x', step: 'p', frames: [] } };
    const entry = (kind: string, data: Json, stepKey = 'p@'): Json => ({ kind, stepKey, data, enteredBy: 'OP-1', recordedSeq: 1 });
    const q = (entries: Json, exceptions: Json = {}): Promise<string | null> => problem(content, { steps, entries: {}, exceptions: {} }, { steps, entries, exceptions });
    const answer = (item: string, extra: Json = {}): Json => ({
      id: 'X1', type: 'LIB_UNEXPECTED_ANSWER', category: 'OUT_OF_LIMIT', title: 'Answers, Run: x', controls: ['PR-29'], severity: 'ACTION',
      source: { stepKey: 'p@', step: 'p', frames: [], item }, raisedAt: { $u: '1' }, raisedSeq: 2, raisedBy: 'OP-1', deviationRequired: true,
      registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN', block: { steps: ['p@'], until: 'DEVIATION' }, ...extra,
    });
    const nominal = { ok: true, free: false, crit: false, how: 'A', any: 'B' };
    expect(await q({ E1: entry('run', nominal) })).toBeNull();
    expect(await q({ E1: entry('run', { ...nominal, free: true, any: 'A' }) })).toBeNull();
    expect(await q({ E1: entry('run', { ...nominal, ok: false }) })).toBe('stores ok answered false at step p, where true is expected, without the LIB_UNEXPECTED_ANSWER it requires (severity ACTION, deviation required)');
    expect(await q({ E1: entry('run', { ...nominal, ok: false }) }, { X1: answer('p.ok') })).toBeNull();
    expect(await q({ E1: entry('run', { ...nominal, ok: false }) }, { X1: answer('p.ok', { block: { steps: [], until: 'DEVIATION' } }) })).toMatch(/^stores ok answered false/);
    expect(await q({ E1: entry('run', { ...nominal, ok: false }) }, { X1: answer('p.ok', { raisedBy: 'OP-2' }) })).toMatch(/^stores ok answered false/);
    expect(await q({ E1: entry('run', { ...nominal, how: 'C' }) })).toBe('stores how = "C" at step p, a choice the formulation does not allow, without the LIB_NOT_ALLOWED_CHOICE it requires (severity ACTION, deviation required)');
    expect(await q({ E1: entry('run', { ...nominal, how: 'C' }) }, { X1: answer('p.how', { type: 'LIB_NOT_ALLOWED_CHOICE' }) })).toBeNull();
    expect(await q({ E1: entry('run', { ...nominal, how: 'C' }) }, { X1: answer('p.how', { type: 'LIB_NOT_ALLOWED_CHOICE', severity: 'CRITICAL' }) })).toMatch(/^stores how = "C"/);
    const critical = answer('p.crit', { severity: 'CRITICAL', qaOnly: true, releaseBlocking: true, block: { steps: ['p@'], until: 'DEVIATION', downstream: { node: 'task:p', frames: [] } } });
    expect(await q({ E1: entry('run', { ...nominal, crit: true }) }, { X1: critical })).toBeNull();
    expect(await q({ E1: entry('run', { ...nominal, crit: true }) }, { X1: answer('p.crit') })).toMatch(/^stores crit answered true .* \(severity CRITICAL, deviation required\)$/);
    // The condition: shown when its field holds the given answer, hidden otherwise (block-version.ts shown).
    expect(await q({ E1: entry('run', { ...nominal, how: 'B', more: false }) })).toMatch(/^stores more answered false/);
    expect(await q({ E1: entry('run', { ...nominal, how: 'A', more: false }) })).toBeNull();
    expect(await q({ E1: entry('run', { ok: true, more: false }) })).toBeNull();
    // A step instance the state does not hold.
    expect(await q({ E1: entry('run', { ...nominal, ok: false }, 'p@x') })).toBe('stores ok answered false at step p, where true is expected, in step instance p@x, which the state does not hold');
    // A loop's YES_NO endpoint is the loop's (a repeat, not an exception); its other fields are judged.
    expect(await q({ E1: entry('loop', { done: false, pick: 'A' }) })).toBeNull();
    expect(await q({ E1: entry('loop', { done: true, pick: 'C' }) })).toMatch(/^stores pick = "C" at step p/);
    // An exhausted loop (its last allowed entry without a pass) still leaves its YES_NO endpoint to the loop: the row needs
    // 1862's LIB_REPEAT_LIMIT_REACHED and no answer exception.
    const limit: Json = {
      id: 'X2', type: 'LIB_REPEAT_LIMIT_REACHED', category: 'OUT_OF_LIMIT', title: 'x', controls: ['PR-08', 'INV-20'], severity: 'ACTION',
      source: { stepKey: 'p@', step: 'p', frames: [], item: 'p.done' }, raisedBy: 'OP-1', deviationRequired: true, registrationRelevant: false, qaOnly: true,
      stageSignOffBlocked: false, releaseBlocking: true, status: 'OPEN', block: { steps: [], until: 'DISPOSITION', downstream: { node: 'task:p', frames: [] } },
    };
    const last = { ...content, procedure: { ...content.procedure, children: [{ ...content.procedure.children[0], config: { counts: { maxL: '1', maxS: '1' } } }] } };
    const lastRow = (exceptions: Json): Promise<string | null> => problem(last, { steps, entries: {}, exceptions: {} }, { steps, entries: { E1: entry('loop', { done: false, pick: 'A' }) }, exceptions });
    expect(await lastRow({ X2: limit })).toBeNull();
    expect(await lastRow({ X2: limit, X1: answer('p.done') })).toMatch(/^adds exception X1 \(LIB_UNEXPECTED_ANSWER/);
    // A CHOICE endpoint always passes its loop (recipe.library_loop_pass), so it is judged only by an exhausted loop, as
    // the engine's accept judges it: recipe.library_answer_records with and without the loop exhausted.
    const records = async (exhausted: boolean, until: string | null, data: Json, section = 2): Promise<Json[]> =>
      (await db.admin.query<{ r: Json[] }>('select recipe.library_answer_records($1::jsonb, $2::jsonb, $3, $4, $5::jsonb, $6, $7, $8) as r', [
        JSON.stringify((def['sections'] as Json[])[section]), JSON.stringify(data), until, exhausted, JSON.stringify(steps['p@']), 'task:p', 'p', 'OP-1',
      ])).rows[0]?.r ?? [];
    expect(await records(false, 'sel', { sel: 'C' })).toEqual([]);
    expect(await records(true, 'sel', { sel: 'C' })).toEqual([{ want: { ...answer('p.sel', { type: 'LIB_NOT_ALLOWED_CHOICE' }), id: undefined, title: undefined, raisedAt: undefined, raisedSeq: undefined }, what: 'sel = "C" at step p, a choice the formulation does not allow,' }].map((x) => JSON.parse(JSON.stringify(x)) as Json));
    expect(await records(true, null, { sel: 'C' })).toHaveLength(1);
    expect(await records(false, null, { done: false, pick: 'C' }, 1)).toHaveLength(2);
    expect(await records(true, 'done', { done: false, pick: 'C' }, 1)).toHaveLength(1);
    // Data that is not an object, or a section without a list of fields, gives no record.
    expect(await records(false, null, ['C'] as unknown as Json)).toEqual([]);
    // An entry that does not hold the field, or a value that is not text of an option.
    expect(await q({ E1: entry('run', { free: true }) })).toBeNull();
    expect(await q({ E1: entry('run', { ...nominal, how: null }) })).toBeNull();
  });
});
