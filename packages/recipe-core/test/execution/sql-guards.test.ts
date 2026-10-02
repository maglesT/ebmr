/**
 * The execution store's SQL guards (recipe-core sql/0270; review findings P22, P24, P25, P29) say the same as the
 * pure engine: the signature meanings each signed command type accepts, the blocks' own meanings and the step a
 * command names (read from the MBR content as the engine expands it), the meaning class of a hold-point decision,
 * the trimming of a justification, the disposition and exception rules, and the role map of decision D4. Wherever
 * the database and the engine differed, the database would refuse an honest command or pass a forged one. Since
 * recipe-core 0298 the database also derives an operator's exception from its RAISE_EXCEPTION as the engine does, and
 * accepts as the state of an ISSUE row only a state in which no person has done anything yet (P25 follow-up). Since
 * recipe-core 0305 it judges every value a row judges against the MBR's limits as the engine does, and derives the limit
 * exception (LIMIT_BREACH, YIELD_OUT_OF_LIMITS) each verdict raises (P25, round-2 verification).
 */
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { GENERIC_BLOCK_VERSIONS } from '../../src/blocks/index.ts';
import {
  encode,
  encodeCommand,
  encodeState,
  holdPointMeaning,
  issue,
  MEANINGS,
  performMeaning,
  prepareForSignature,
  RELEASING_DISPOSITIONS,
  signatureTargetOf,
  step,
  VERIFICATION_MEANINGS,
  type BatchDefinition,
  type BatchState,
  type Command,
  type DataValue,
  type ExceptionRecord,
  type IssueRequest,
  type JsonValue,
  type RaiseExceptionCommand,
} from '../../src/engine/index.ts';
import { expandLibraryCalls } from '../../src/flow/expand.ts';
import { childrenOf, type FlowNode, type MbrContent, type Parameter } from '../../src/flow/model.ts';
import type { LimitRange, LimitSpec } from '../../src/limits/model.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, PACKAGING_SCENARIO, param, QA1, Run, sig, SUP1, T0 } from '../engine/support.ts';
import { endpoint, loadFixture, mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

async function meaningsOf(commandType: string, part: 'signature' | 'approval' = 'signature'): Promise<string[]> {
  const { rows } = await db.admin.query<{ m: string }>('select meaning_code as m from recipe.execution_signature_meaning where command_type = $1 and part = $2 order by 1', [commandType, part]);
  return rows.map((r) => r.m);
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

describe('signature meanings (P24)', () => {
  it('[DI-35][INV-10] every signed command type accepts exactly the meanings the engine asks for, and nothing for an unsigned one', async () => {
    const perform = GENERIC_BLOCK_VERSIONS.flatMap((b) => b.handler?.meanings?.perform ?? []);
    const check = GENERIC_BLOCK_VERSIONS.flatMap((b) => b.handler?.meanings?.check ?? []);
    expect(await meaningsOf('SIGN_PERFORMED')).toEqual(sorted([MEANINGS.PERFORMED, ...perform]));
    expect(await meaningsOf('VERIFY')).toEqual(sorted([...VERIFICATION_MEANINGS, ...check, MEANINGS.WITNESSED, MEANINGS.RE_VERIFIED]));
    expect(await meaningsOf('DISPOSITION_HOLD_POINT')).toEqual(sorted([MEANINGS.HOLD_RELEASED, MEANINGS.HOLD_NOT_RELEASED]));
    expect(await meaningsOf('SIGN_OFF_STAGE')).toEqual([MEANINGS.STAGE_SIGNED_OFF]);
    expect(await meaningsOf('DISPOSITION_EXCEPTION')).toEqual([MEANINGS.EXCEPTION_DISPOSITIONED]);
    expect(await meaningsOf('CORRECT_ENTRY')).toEqual([MEANINGS.CORRECTED]);
    expect(await meaningsOf('CORRECT_ENTRY', 'approval')).toEqual([MEANINGS.CORRECTION_APPROVED]);
    const { rows } = await db.admin.query<{ t: string; signed: boolean; n: string }>(
      `select c.command_type as t, c.signed, (select count(*) from recipe.execution_signature_meaning m where m.command_type = c.command_type)::text as n
         from recipe.execution_command_permission c order by 1`,
    );
    expect(rows.filter((r) => r.signed !== (r.n !== '0')).map((r) => r.t)).toEqual([]);
  });

  it('[PR-45][DI-35] a hold-point decision is signed with the meaning of its class, as in the engine', async () => {
    const decisions = [...RELEASING_DISPOSITIONS, 'NOT_APPROVED', 'REJECTED', 'HOLD', 'approved', ''];
    const { rows } = await db.admin.query<{ d: string; m: string }>('select d, recipe.hold_point_meaning(d) as m from unnest($1::text[]) d', [decisions]);
    expect(rows.map((r) => [r.d, r.m])).toEqual(decisions.map((d) => [d, holdPointMeaning(d)]));
    const none = await db.admin.query<{ m: string }>('select recipe.hold_point_meaning(null) as m');
    expect(none.rows[0]?.m).toBe(MEANINGS.HOLD_NOT_RELEASED);
  });
});

describe('the step a signature is for (P24)', () => {
  it('[DI-35][INV-10] each block version\'s own perform and check meanings are the registry\'s, and the verification meanings the engine\'s', async () => {
    const { rows } = await db.admin.query<{ t: string; v: string; part: 'perform' | 'check'; m: string }>(
      'select block_type as t, block_version as v, part, meaning_code as m from recipe.block_signature_meaning order by 1, 2, 3, 4',
    );
    const expected = GENERIC_BLOCK_VERSIONS.flatMap((b) =>
      (['check', 'perform'] as const).flatMap((part) => (b.handler?.meanings?.[part] ?? []).map((m) => `${b.type}@${b.version}/${part}/${m}`)),
    ).sort();
    expect(rows.map((r) => `${r.t}@${r.v}/${r.part}/${r.m}`).sort()).toEqual(expected);
    const v = await db.admin.query<{ m: string[] }>('select recipe.verification_meanings() as m');
    expect(v.rows[0]?.m).toEqual([...VERIFICATION_MEANINGS]);
  });

  it('[DI-35][DI-04] recipe.step_node finds every step of an MBR as the engine expands it, library calls included', async () => {
    const mbr = loadFixture('tablet-granulation-compression');
    const steps: FlowNode[] = [];
    const walk = (n: FlowNode): void => {
      if (n.kind === 'phase' || n.kind === 'holdPoint') steps.push(n);
      for (const c of childrenOf(n)) walk(c);
    };
    const expanded = expandLibraryCalls(mbr);
    expect(expanded.problems).toEqual([]);
    walk(expanded.root);
    const inlined = steps.filter((s) => s.id.includes('/'));
    expect(inlined.length, 'the fixture inlines a library element').toBeGreaterThan(0);
    const { rows } = await db.admin.query<{ id: string; n: Record<string, unknown> | null }>(
      'select id, recipe.step_node($1::jsonb, id) as n from unnest($2::text[]) id',
      [JSON.stringify(mbr), steps.map((s) => s.id)],
    );
    const facts = (n: Record<string, unknown> | FlowNode | null | undefined) =>
      n ? { kind: n['kind' as keyof typeof n], block: n['block' as keyof typeof n] ?? null, signatures: n['signatures' as keyof typeof n] ?? null, dispositions: n['dispositions' as keyof typeof n] ?? null } : null;
    expect(rows.map((r) => [r.id, facts(r.n)])).toEqual(steps.map((s) => [s.id, facts(s)]));
  });

  it('[DI-35] recipe.step_node answers nothing for an unknown, ambiguous or mis-called step (fail closed)', async () => {
    const phase = (id: string, check?: string) => ({ kind: 'phase', id, block: { type: 'G-04', version: '1' }, signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, ...(check ? { check: { meaning: check, role: 'PRODUCTION_VERIFIER' } } : {}) } });
    const content = {
      procedure: { id: 'P', body: { kind: 'sequence', id: 'root', children: [phase('a'), { kind: 'libraryCall', id: 'c1', element: 'LIB-A', bind: {} }, phase('dup'), phase('dup'), { kind: 'libraryCall', id: 'c9', element: 'LIB-NONE', bind: {} }] } },
      library: [
        { ref: 'LIB-A', level: 'OPERATION', symbols: [], body: { kind: 'sequence', id: 'sa', children: [phase('x', 'WITNESSED'), { kind: 'libraryCall', id: 'c2', element: 'LIB-B', bind: {} }] } },
        { ref: 'LIB-B', level: 'OPERATION', symbols: [], body: phase('y') },
      ],
    };
    const ids = ['a', 'c1/x', 'c1/c2/y', 'x', 'c1', 'c1/y', 'dup', 'c9/x', 'a/x', '', 'c1/c2/y/z'];
    const { rows } = await db.admin.query<{ id: string; n: { id: string; signatures: unknown } | null }>('select id, recipe.step_node($1::jsonb, id) as n from unnest($2::text[]) id', [JSON.stringify(content), ids]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.n ? { id: r.n.id, signatures: r.n.signatures } : null]))).toEqual({
      a: { id: 'a', signatures: phase('a').signatures },
      'c1/x': { id: 'x', signatures: phase('x', 'WITNESSED').signatures },
      'c1/c2/y': { id: 'y', signatures: phase('y').signatures },
      x: null,
      c1: null,
      'c1/y': null,
      dup: null,
      'c9/x': null,
      'a/x': null,
      '': null,
      'c1/c2/y/z': null,
    });
  });
});

describe('dispositions (P25)', () => {
  it('[PR-49][DI-37] recipe.js_trim removes exactly the white space String.prototype.trim removes', async () => {
    const codes = [...Array.from({ length: 0x3100 }, (_, i) => i + 1), 0x205f, 0xfeff, 0xfffe, 0x1680, 0x180e, 0x200b];
    const texts = codes.map((c) => `${String.fromCodePoint(c)}${String.fromCodePoint(c)}a${String.fromCodePoint(c)}b${String.fromCodePoint(c)}`);
    const { rows } = await db.admin.query<{ t: string[] }>('select array_agg(recipe.js_trim(x) order by i) as t from unnest($1::text[]) with ordinality u (x, i)', [texts]);
    const got = rows[0]?.t ?? [];
    const differ = texts.map((t, i) => ({ code: (codes[i] ?? 0).toString(16), js: t.trim(), sql: got[i] })).filter((x) => x.js !== x.sql);
    expect(differ).toEqual([]);
  });

  const PERSON = '11111111-1111-4111-8111-111111111111';
  const SIG = '22222222-2222-4222-8222-222222222222';
  type Json = Record<string, unknown>;
  const raised = (extra: Json = {}): Json => ({ id: 'EX-1', type: 'OPERATOR_RAISED', title: 'Label printer jammed', raisedBy: PERSON, deviationRequired: false, qaOnly: false, status: 'OPEN', ...extra });
  const dispositioned = (x: Json, outcome: string, justification: string): Json => ({ ...x, status: 'DISPOSITIONED', disposition: { by: PERSON, outcome, justification, signature: SIG, at: '1' } });

  /** The code and message of recipe.check_disposition_state for an exception before (x0) and after (x1) the command. */
  async function dispositionState(x0: Json | undefined, x1: Json, cmd: Json): Promise<string> {
    try {
      await db.admin.query('select recipe.check_disposition_state($1::jsonb, $2::jsonb, $3::jsonb, $4::uuid, array[$5::uuid])', [
        JSON.stringify({ exceptions: x0 ? { 'EX-1': x0 } : {} }),
        JSON.stringify({ exceptions: { 'EX-1': x1 } }),
        JSON.stringify({ type: 'DISPOSITION_EXCEPTION', exception: 'EX-1', ...cmd }),
        PERSON,
        SIG,
      ]);
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  it('[PR-49][DI-37] a disposition whose justification is only white space (a tab, a no-break or an ideographic space) is refused, whatever the state records', async () => {
    const blanks = ['', '   ', '\t\n', '  ', '　　', '﻿', '   '];
    for (const blank of blanks) {
      // The state records the engine's trim ('') or the text itself: both are refused.
      for (const recorded of ['', blank]) {
        expect(await dispositionState(raised(), dispositioned(raised(), 'NO_IMPACT', recorded), { outcome: 'NO_IMPACT', justification: blank }), JSON.stringify([blank, recorded])).toMatch(/blank justification.*\[EBMR-EXE-086\]/);
      }
    }
    expect(await dispositionState(raised(), dispositioned(raised(), 'NO_IMPACT', 'Reprint reconciled.'), { outcome: 'NO_IMPACT', justification: '　Reprint reconciled.\t' })).toBe('ok');
  });

  it('[PR-49][DI-37] a disposition whose justification shows nothing (zero-width characters, a word joiner, a soft hyphen, annotation or format controls) is refused as blank, as the engine refuses it (recipe-core 0301, engine 1.1.0)', async () => {
    // Written as code points, so the source holds no invisible character. JavaScript's trim leaves each of them as it is.
    const blanks = [[0x200b], [0x2060], [0xad], [0x180e], [0x200d, 0x200c], [0xfff9, 0xfffb], [0x13430], [0x0600, 0x06dd], [0x2800], [0x3000, 0x200b, 0x09]].map((c) => String.fromCodePoint(...c));
    for (const blank of blanks) {
      const recorded = blank.trim();
      expect(recorded, 'JavaScript trim keeps it').not.toBe('');
      expect(await dispositionState(raised(), dispositioned(raised(), 'NO_IMPACT', recorded), { outcome: 'NO_IMPACT', justification: blank }), JSON.stringify(blank)).toMatch(/blank justification.*\[EBMR-EXE-086\]/);
    }
    const text = `${String.fromCodePoint(0x200b)}Reprint reconciled.`;
    expect(await dispositionState(raised(), dispositioned(raised(), 'NO_IMPACT', text), { outcome: 'NO_IMPACT', justification: ` ${text}\t` })).toBe('ok');
  });

  it('[PR-49][PR-08] a disposition is refused on an exception that is not open, as NO_IMPACT where a deviation is needed, and as DEVIATION_RAISED without a linked deviation', async () => {
    const linked = { deviation: { ref: 'TEST-DEV-0001', linkedBy: PERSON, at: '1' } };
    const cases: [string, Json | undefined, Json, string][] = [
      ['absent', undefined, 'NO_IMPACT', 'not open'],
      ['closed', dispositioned(raised(), 'NO_IMPACT', 'Earlier.'), 'NO_IMPACT', 'not open'],
      ['needs a deviation', raised({ deviationRequired: true, ...linked }), 'NO_IMPACT', 'needs a deviation'],
      ['deviationRequired absent', { ...raised(), deviationRequired: undefined }, 'NO_IMPACT', 'needs a deviation'],
      ['raised without a link', raised(), 'DEVIATION_RAISED', 'no deviation is linked'],
      ['unknown outcome', raised(), 'NOT_RELEVANT', 'NO_IMPACT or DEVIATION_RAISED'],
    ].map(([name, x0, outcome, why]) => [name as string, x0 as Json | undefined, { outcome, justification: 'Investigated.' }, why as string]);
    for (const [name, x0, cmd, why] of cases) {
      expect(await dispositionState(x0, dispositioned(x0 ?? raised(), String(cmd['outcome']), 'Investigated.'), cmd), name).toMatch(new RegExp(`${why}.*\\[EBMR-EXE-086\\]`));
    }
    // The engine's own dispositions of the same exceptions are accepted.
    expect(await dispositionState(raised({ deviationRequired: true, ...linked }), dispositioned(raised({ deviationRequired: true, ...linked }), 'DEVIATION_RAISED', 'Investigated.'), { outcome: 'DEVIATION_RAISED', justification: 'Investigated.' })).toBe('ok');
    expect(await dispositionState(raised(linked), dispositioned(raised(linked), 'DEVIATION_RAISED', 'Investigated.'), { outcome: 'DEVIATION_RAISED', justification: 'Investigated.' })).toBe('ok');
  });

  it('[INV-03][PR-13][PR-49] a disposition by a person who started, entered data in, corrected or signed performed the step that raised the exception is refused (EBMR-EXE-087, recipe-core 0306), as the engine refuses it; anyone else, and an exception raised at no step, is accepted', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const step = (lists: Partial<Record<'performers' | 'dataEnterers' | 'correctors' | 'performedSigners', string[]>>): Json => ({
      key: 'p-1@', step: 'p-1', status: 'IN_PROGRESS', performers: [], dataEnterers: [], correctors: [], performedSigners: [], ...lists,
    });
    const atStep = raised({ source: { stepKey: 'p-1@', step: 'p-1', frames: [] } });
    async function decide(x0: Json, steps: Record<string, Json>): Promise<string> {
      try {
        await db.admin.query('select recipe.check_disposition_state($1::jsonb, $2::jsonb, $3::jsonb, $4::uuid, array[$5::uuid])', [
          JSON.stringify({ exceptions: { 'EX-1': x0 }, steps }),
          JSON.stringify({ exceptions: { 'EX-1': dispositioned(x0, 'NO_IMPACT', 'Investigated.') }, steps }),
          JSON.stringify({ type: 'DISPOSITION_EXCEPTION', exception: 'EX-1', outcome: 'NO_IMPACT', justification: 'Investigated.' }),
          PERSON,
          SIG,
        ]);
        return 'ok';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
    for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) {
      expect(await decide(atStep, { 'p-1@': step({ [list]: [OTHER, PERSON] }) }), list).toMatch(/started, entered data in, corrected or signed performed step p-1@, which raised exception EX-1.*\(INV-03, PR-13, PR-49\)\. \[EBMR-EXE-087\]$/);
    }
    // Another person's involvement, an involvement in another step, and an exception raised at no step.
    expect(await decide(atStep, { 'p-1@': step({ performers: [OTHER], dataEnterers: [OTHER] }), 'p-2@': step({ performers: [PERSON] }) })).toBe('ok');
    expect(await decide(raised(), { 'p-1@': step({ performers: [PERSON] }) })).toBe('ok');
    // A step key the state does not hold involves nobody (the engine's rule reads the stored instance).
    expect(await decide(atStep, {})).toBe('ok');
    // Lists that are not arrays involve nobody, and refuse nothing else.
    expect(await decide(atStep, { 'p-1@': { key: 'p-1@', performers: PERSON, dataEnterers: { a: PERSON } } })).toBe('ok');
  });

  /** The code of recipe.check_exception_changes for the exceptions before and after a row. */
  async function exceptionChanges(e0: Record<string, Json>, e1: Record<string, Json>, kind: string, cmd: Json, accepted = true): Promise<string> {
    try {
      await db.admin.query('select recipe.check_exception_changes($1::jsonb, $2::jsonb, $3, $4::jsonb, $5)', [JSON.stringify({ exceptions: e0 }), JSON.stringify({ exceptions: e1 }), kind, JSON.stringify(cmd), accepted]);
      return 'ok';
    } catch (e) {
      const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
      return m?.[1] ?? String(e);
    }
  }

  it('[DI-26][INV-41][PR-49] a row changes an exception only as its own command does: a disposition by DISPOSITION_EXCEPTION, a link by ATTACH_DEVIATION, a new exception open', async () => {
    const actor = { id: PERSON, kind: 'PERSON', roles: [] };
    const x = raised();
    const link = { ref: 'TEST-DEV-0001', linkedBy: PERSON, at: '1' };
    const other = raised({ id: 'EX-2', title: 'Other' });
    const start = { type: 'START_STEP', actor, step: 'p-1', context: [] };
    const dispose = { type: 'DISPOSITION_EXCEPTION', actor, exception: 'EX-1', outcome: 'NO_IMPACT', justification: 'x' };
    const attach = { type: 'ATTACH_DEVIATION', actor, exception: 'EX-1', deviationRef: ' TEST-DEV-0001　' };
    const outcomes = {
      // Honest rows.
      unchanged: await exceptionChanges({ 'EX-1': x }, { 'EX-1': x }, 'COMMAND', start),
      // A sweep raises a time finding (an operator's exception comes only from its RAISE_EXCEPTION, 0298).
      raisedOpen: await exceptionChanges({ 'EX-1': x }, { 'EX-1': x, 'EX-2': { ...other, type: 'TIME_MAX_BREACH', raisedBy: 'SYSTEM' } }, 'SWEEP', { type: 'SWEEP' }),
      disposition: await exceptionChanges({ 'EX-1': x, 'EX-2': other }, { 'EX-1': dispositioned(x, 'NO_IMPACT', 'x'), 'EX-2': other }, 'COMMAND', dispose),
      attach: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...x, deviation: link } }, 'COMMAND', attach),
      // Forged states.
      removed: await exceptionChanges({ 'EX-1': x, 'EX-2': other }, { 'EX-1': x }, 'COMMAND', start),
      retitled: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...x, title: 'Something else' } }, 'COMMAND', start),
      relaxed: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...x, deviationRequired: false, qaOnly: false, block: null } }, 'COMMAND', dispose),
      closedByStart: await exceptionChanges({ 'EX-1': x }, { 'EX-1': dispositioned(x, 'NO_IMPACT', 'x') }, 'COMMAND', start),
      closedByRefusedRow: await exceptionChanges({ 'EX-1': x }, { 'EX-1': dispositioned(x, 'NO_IMPACT', 'x') }, 'COMMAND', dispose, false),
      closedByPrepare: await exceptionChanges({ 'EX-1': x }, { 'EX-1': dispositioned(x, 'NO_IMPACT', 'x') }, 'PREPARE', { type: 'PREPARE', actor, target: dispose }),
      otherClosed: await exceptionChanges({ 'EX-1': x, 'EX-2': other }, { 'EX-1': dispositioned(x, 'NO_IMPACT', 'x'), 'EX-2': dispositioned(other, 'NO_IMPACT', 'x') }, 'COMMAND', dispose),
      linkedByDisposition: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...dispositioned(x, 'NO_IMPACT', 'x'), deviation: link } }, 'COMMAND', dispose),
      linkedByStart: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...x, deviation: link } }, 'COMMAND', start),
      otherRef: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...x, deviation: { ...link, ref: 'TEST-DEV-0002' } } }, 'COMMAND', attach),
      otherPerson: await exceptionChanges({ 'EX-1': x }, { 'EX-1': { ...x, deviation: { ...link, linkedBy: SIG } } }, 'COMMAND', attach),
      relinked: await exceptionChanges({ 'EX-1': { ...x, deviation: link } }, { 'EX-1': { ...x, deviation: { ...link, ref: 'TEST-DEV-0001' , at: '2' } } }, 'COMMAND', attach),
      unlinked: await exceptionChanges({ 'EX-1': { ...x, deviation: link } }, { 'EX-1': x }, 'COMMAND', start),
      raisedClosed: await exceptionChanges({}, { 'EX-2': dispositioned(other, 'NO_IMPACT', 'x') }, 'SWEEP', { type: 'SWEEP' }),
      raisedLinked: await exceptionChanges({}, { 'EX-2': { ...other, deviation: link } }, 'COMMAND', start),
      noExceptions: await exceptionChanges({ 'EX-1': x }, null as unknown as Record<string, Json>, 'COMMAND', start),
    };
    expect(outcomes).toEqual({
      unchanged: 'ok',
      raisedOpen: 'ok',
      disposition: 'ok',
      attach: 'ok',
      removed: 'EBMR-EXE-044',
      retitled: 'EBMR-EXE-044',
      relaxed: 'EBMR-EXE-044',
      closedByStart: 'EBMR-EXE-044',
      closedByRefusedRow: 'EBMR-EXE-044',
      closedByPrepare: 'EBMR-EXE-044',
      otherClosed: 'EBMR-EXE-044',
      linkedByDisposition: 'EBMR-EXE-044',
      linkedByStart: 'EBMR-EXE-044',
      otherRef: 'EBMR-EXE-044',
      otherPerson: 'EBMR-EXE-044',
      relinked: 'EBMR-EXE-044',
      unlinked: 'EBMR-EXE-044',
      raisedClosed: 'EBMR-EXE-044',
      raisedLinked: 'EBMR-EXE-044',
      noExceptions: 'EBMR-EXE-030',
    });
  });

  it('[PR-49][DI-26][INV-41] a deviation is linked only to an open exception: ATTACH_DEVIATION on an exception already dispositioned is refused (EBMR-EXE-044)', async () => {
    const actor = { id: PERSON, kind: 'PERSON', roles: [] };
    const attach = { type: 'ATTACH_DEVIATION', actor, exception: 'EX-1', deviationRef: 'TEST-DEV-0001' };
    const link = { ref: 'TEST-DEV-0001', linkedBy: PERSON, at: '2' };
    const closed = dispositioned(raised(), 'NO_IMPACT', 'Reprint reconciled.');
    // Everything else about the link is as ATTACH_DEVIATION makes it: the command's reference, by the command's person.
    expect(await exceptionChanges({ 'EX-1': closed }, { 'EX-1': { ...closed, deviation: link } }, 'COMMAND', attach)).toBe('EBMR-EXE-044');
    expect(await exceptionChanges({ 'EX-1': raised() }, { 'EX-1': { ...raised(), deviation: link } }, 'COMMAND', attach)).toBe('ok');
  });
});

describe('an operator\'s exception as its command raised it (P25 follow-up; recipe-core 0298)', () => {
  type Json = Record<string, unknown>;
  /** The engine's exception as the state stores it, without its time of raising. */
  const facts = (x: ExceptionRecord): Json => {
    const rest = { ...(encode(x) as Json) };
    delete rest['raisedAt'];
    delete rest['raisedSeq'];
    return rest;
  };
  /** The operator's exception `command` adds to `state` in the engine, or a SETUP error. */
  function raiseIn(def: BatchDefinition, state: BatchState, nowUs: bigint, command: Command): { state: BatchState; exception: ExceptionRecord } {
    const r = step(def, state, command, { nowUs });
    if (!r.accepted) throw new Error(`SETUP: the engine refused ${command.type}: ${JSON.stringify(r.refusal)}`);
    const added = Object.values(r.state.exceptions).filter((x) => state.exceptions[x.id] === undefined && x.type === 'OPERATOR_RAISED');
    if (added.length !== 1 || !added[0]) throw new Error(`SETUP: ${added.length} operator exceptions were raised`);
    return { state: r.state, exception: added[0] };
  }

  it('[PR-49][PR-13][DI-26] recipe.operator_exception_record gives exactly the exception the engine raises, at every step both fixtures reach (hold points, loops and inlined library steps too), for ALERT and ACTION, with or without a step', async () => {
    let n = 0;
    const kinds = new Set<string>();
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const def = fixtureDefinition(name);
      const run = Run.issue(def, { inputs: FIXTURE_INPUTS[name], variants });
      const first = { state: run.state, nowUs: run.nowUs };
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      const probes: { what: string; command: JsonValue; id: string; want: Json }[] = [];
      const probe = (at: { state: BatchState; nowUs: bigint }, extra: Partial<RaiseExceptionCommand>, what: string): void => {
        n += 1;
        const command: Command = { type: 'RAISE_EXCEPTION', commandId: `PROBE-${n}`, actor: OP1, description: 'Line stopped: probe', severity: 'ALERT', ...extra };
        const { exception } = raiseIn(def, at.state, at.nowUs, command);
        probes.push({ what: `${name}: ${what}`, command: encodeCommand(command), id: exception.id, want: facts(exception) });
      };
      // Every step instance, the first time a state holds it (the engine refuses a step the batch has not reached).
      const seen = new Set<string>();
      for (const at of [first, ...run.log.map((l) => ({ state: l.result.state, nowUs: l.nowUs }))]) {
        for (const inst of Object.values(at.state.steps)) {
          if (seen.has(inst.key)) continue;
          seen.add(inst.key);
          kinds.add(`${inst.kind}${inst.frames.length > 0 ? ' in frames' : ''}${inst.step.includes('/') ? ' inlined' : ''}`);
          for (const severity of ['ALERT', 'ACTION'] as const) probe(at, { step: inst.step, context: inst.frames, severity }, `${severity} at ${inst.key}`);
        }
      }
      probe(first, { severity: 'ACTION' }, 'ACTION without a step');
      probe(first, { severity: 'ALERT', context: [] }, 'ALERT without a step, empty context');
      probe(first, { severity: 'ALERT', description: '\t\u3000 Printer jammed\u0000 once, 100% reprinted\u00a0\n' }, 'a description with white space, % and U+0000');
      const { rows } = await db.admin.query<{ r: Json | null }>(
        'select recipe.operator_exception_record($1::jsonb, u.c::jsonb, u.id) as r from unnest($2::text[], $3::text[]) with ordinality u (c, id, i) order by u.i',
        [JSON.stringify(loadFixture(name)), probes.map((p) => JSON.stringify(p.command)), probes.map((p) => p.id)],
      );
      expect(rows).toHaveLength(probes.length);
      const differ = probes.map((p, i) => ({ what: p.what, engine: p.want, sql: rows[i]?.r })).filter((d) => !isDeepStrictEqual(d.engine, d.sql));
      expect(differ).toEqual([]);
    }
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['HOLD', 'PHASE', 'PHASE in frames', 'PHASE in frames inlined']));
    // A command the engine could not have accepted gives no record (nothing matches it).
    const bad = await db.admin.query<{ r: Json | null }>(
      `select recipe.operator_exception_record($1::jsonb, c, 'EX-1') as r from unnest($2::jsonb[]) c`,
      [JSON.stringify(loadFixture('tablet-granulation-compression')), [
        { type: 'RAISE_EXCEPTION', actor: { id: 'OP1' }, severity: 'ACTION', step: 'no-such-step', description: 'x' },
        { type: 'RAISE_EXCEPTION', actor: { id: 'OP1' }, severity: 'ALERT', step: 7, description: 'x' },
        { type: 'RAISE_EXCEPTION', actor: { id: 'OP1' }, severity: 'ALERT', context: 'frames', description: 'x' },
        { type: 'RAISE_EXCEPTION', actor: { id: 'OP1' }, severity: 'ALERT', description: 7 },
        { type: 'RAISE_EXCEPTION', severity: 'ALERT', description: 'x' },
      ].map((c) => JSON.stringify(c))],
    );
    expect(bad.rows.map((r) => r.r)).toEqual([null, null, null, null, null]);
  });

  it('[PR-49][PR-13][DI-26][INV-41] a row adds an operator\'s exception only as its accepted RAISE_EXCEPTION raised it: one, with the command\'s severity, need of a deviation, flags, title and raiser (EBMR-EXE-044)', async () => {
    const def = define(mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p1'), phase('p2')] }));
    const run = Run.issue(def);
    const prior = run.state;
    const actor = { id: 'OP1', kind: 'PERSON', roles: ['PRODUCTION_OPERATOR'] };
    const cmd = (severity: 'ALERT' | 'ACTION', extra: Json = {}): Command => ({ type: 'RAISE_EXCEPTION', commandId: 'C-1', actor: OP1, description: ' Booth door open ', severity, ...extra });
    const action = raiseIn(def, prior, run.nowUs, cmd('ACTION'));
    const alertAtStep = raiseIn(def, prior, run.nowUs, cmd('ALERT', { step: 'p1', context: [] }));
    const check = async (state: BatchState, kind: string, command: JsonValue, accepted = true): Promise<string> => {
      try {
        await db.admin.query('select recipe.check_exception_changes($1::jsonb, $2::jsonb, $3, $4::jsonb, $5)', [JSON.stringify(encodeState(prior)), JSON.stringify(encodeState(state)), kind, JSON.stringify(command), accepted]);
        return 'ok';
      } catch (e) {
        return /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? String(e);
      }
    };
    /** The ACTION result with its exception changed by `edit`. */
    const forged = (edit: (x: ExceptionRecord, s: BatchState) => void): BatchState => {
      const s = structuredClone(action.state);
      const x = s.exceptions[action.exception.id];
      if (!x) throw new Error('SETUP');
      edit(x, s);
      return s;
    };
    const actionCmd = encodeCommand(cmd('ACTION'));
    const outcomes = {
      honestAction: await check(action.state, 'COMMAND', actionCmd),
      honestAlertAtStep: await check(alertAtStep.state, 'COMMAND', encodeCommand(cmd('ALERT', { step: 'p1', context: [] }))),
      storedAsAlert: await check(forged((x) => Object.assign(x, { severity: 'ALERT', deviationRequired: false })), 'COMMAND', actionCmd),
      severity: await check(forged((x) => void (x.severity = 'ALERT')), 'COMMAND', actionCmd),
      noDeviationNeeded: await check(forged((x) => void (x.deviationRequired = false)), 'COMMAND', actionCmd),
      qaOnly: await check(forged((x) => void (x.qaOnly = true)), 'COMMAND', actionCmd),
      releaseBlocking: await check(forged((x) => void (x.releaseBlocking = true)), 'COMMAND', actionCmd),
      registrationRelevant: await check(forged((x) => void (x.registrationRelevant = true)), 'COMMAND', actionCmd),
      stageSignOffBlocked: await check(forged((x) => void (x.stageSignOffBlocked = true)), 'COMMAND', actionCmd),
      category: await check(forged((x) => void (x.category = 'OUT_OF_LIMIT')), 'COMMAND', actionCmd),
      controls: await check(forged((x) => void (x.controls = ['PR-13'])), 'COMMAND', actionCmd),
      untrimmedTitle: await check(forged((x) => void (x.title = 'OP1:  Booth door open ')), 'COMMAND', actionCmd),
      raisedByAnother: await check(forged((x) => void (x.raisedBy = 'OP2')), 'COMMAND', actionCmd),
      atAStep: await check(forged((x) => void (x.source = { stepKey: 'p1@', step: 'p1', frames: [] })), 'COMMAND', actionCmd),
      blocked: await check(forged((x) => void (x.block = { steps: [], until: 'DEVIATION' })), 'COMMAND', actionCmd),
      tiered: await check(forged((x) => void (x.tier = 'ALERT')), 'COMMAND', actionCmd),
      otherId: await check(forged((x) => void (x.id = 'EX-9')), 'COMMAND', actionCmd),
      relabelled: await check(forged((x) => void (x.type = 'POST_ENTRY_CORRECTION')), 'COMMAND', actionCmd),
      dropped: await check(forged((x, s) => void delete s.exceptions[x.id]), 'COMMAND', actionCmd),
      twice: await check(forged((x, s) => void (s.exceptions['EX-9'] = { ...x, id: 'EX-9' })), 'COMMAND', actionCmd),
      byRefusedRow: await check(action.state, 'COMMAND', actionCmd, false),
      byStart: await check(action.state, 'COMMAND', encodeCommand({ type: 'START_STEP', commandId: 'C-2', actor: OP1, step: 'p1', context: [] })),
      byPrepare: await check(action.state, 'PREPARE', { type: 'PREPARE', actor, target: actionCmd }),
      bySweep: await check(action.state, 'SWEEP', { type: 'SWEEP' }),
    };
    expect(outcomes).toEqual({
      honestAction: 'ok',
      honestAlertAtStep: 'ok',
      storedAsAlert: 'EBMR-EXE-044',
      severity: 'EBMR-EXE-044',
      noDeviationNeeded: 'EBMR-EXE-044',
      qaOnly: 'EBMR-EXE-044',
      releaseBlocking: 'EBMR-EXE-044',
      registrationRelevant: 'EBMR-EXE-044',
      stageSignOffBlocked: 'EBMR-EXE-044',
      category: 'EBMR-EXE-044',
      controls: 'EBMR-EXE-044',
      untrimmedTitle: 'EBMR-EXE-044',
      raisedByAnother: 'EBMR-EXE-044',
      atAStep: 'EBMR-EXE-044',
      blocked: 'EBMR-EXE-044',
      tiered: 'EBMR-EXE-044',
      otherId: 'EBMR-EXE-044',
      relabelled: 'EBMR-EXE-044',
      dropped: 'EBMR-EXE-044',
      twice: 'EBMR-EXE-044',
      byRefusedRow: 'EBMR-EXE-044',
      byStart: 'EBMR-EXE-044',
      byPrepare: 'EBMR-EXE-044',
      bySweep: 'EBMR-EXE-044',
    });
  });
});

describe('the initial state of an issued test batch (P25 follow-up; recipe-core 0298)', () => {
  const ISSUER = '33333333-3333-4333-8333-333333333333';
  const request = (def: BatchDefinition, extra: Partial<IssueRequest> = {}): IssueRequest => ({
    batchId: 'BATCH-1', batchNumber: 'B0001', batchSize: def.mbr.header.batchSizes[0]?.id ?? '', marketSet: [...def.mbr.header.marketSet], inputs: {}, issuedBy: SUP1, ...extra,
  });
  /** The code of recipe.check_issued_state for the engine's initial state of `req`, changed by `edit`. */
  async function issuedState(def: BatchDefinition, req: IssueRequest, edit?: (s: BatchState) => void, requestJson: JsonValue = encode(req)): Promise<string> {
    const s = issue(def, req, { nowUs: T0 }).state;
    edit?.(s);
    try {
      await db.admin.query('select recipe.check_issued_state($1::jsonb, $2::jsonb, $3::uuid)', [JSON.stringify(encodeState(s)), JSON.stringify(requestJson), ISSUER]);
      return 'ok';
    } catch (e) {
      return /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? String(e);
    }
  }
  const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
  const holdFirst = (): MbrContent => mbrWith(seq('ops', { kind: 'holdPoint', id: 'H1', name: 'QA release', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('after')));
  /** A replicate first, whose count comes from the header: the engine raises REPLICATE_COUNT_INVALID at issue. */
  const replicateFirst = (): MbrContent =>
    mbrWith(seq('ops', { kind: 'replicate', id: 'R', name: 'Sub-lots', count: { mode: 'EXPRESSION', expression: 'n', min: 1, max: 3 }, instances: 'CONCURRENT', subLotPrefix: 'SL', body: phase('work', { records: ['m'] }) }, phase('after')), {
      parameters: [param('m')],
      inputs: [{ id: 'n', name: 'Loads', source: 'BATCH_HEADER', valueType: 'COUNT' }],
    });

  it('[DI-34][INV-41] the engine\'s initial states pass: both fixtures, a hold point enabled at issue, and an open exception the engine raises while issuing', async () => {
    const granulation = fixtureDefinition('tablet-granulation-compression');
    const packaging = fixtureDefinition('tablet-blister-packaging');
    const replicate = define(replicateFirst());
    const rep = issue(replicate, request(replicate, { inputs: { n: { value: { kind: 'COUNT', value: '5' }, source: 'header' } } }), { nowUs: T0 }).state;
    expect(Object.values(rep.exceptions).map((x) => `${x.type}/${x.status}`)).toEqual(['REPLICATE_COUNT_INVALID/OPEN']);
    const hold = define(holdFirst());
    expect(Object.values(issue(hold, request(hold), { nowUs: T0 }).state.steps).map((i) => `${i.kind}/${i.status}`)).toEqual(['HOLD/ENABLED']);
    expect({
      granulation: await issuedState(granulation, request(granulation, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] })),
      packagingUs: await issuedState(packaging, request(packaging, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'], variants: { packDestination: 'US-EXPORT' } })),
      packagingIn: await issuedState(packaging, request(packaging, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'], variants: { packDestination: 'IN-DOMESTIC' } })),
      holdFirst: await issuedState(hold, request(hold)),
      replicateCountInvalid: await issuedState(replicate, request(replicate, { inputs: { n: { value: { kind: 'COUNT', value: '5' }, source: 'header' } } })),
    }).toEqual({ granulation: 'ok', packagingUs: 'ok', packagingIn: 'ok', holdFirst: 'ok', replicateCountInvalid: 'ok' });
  });

  it('[DI-34][INV-41][PR-45][PR-49][DI-35] an initial state that records a hold-point decision, a closed, linked or operator\'s exception, a data point, a performer, a signature, a person\'s decision or a stage sign-off is refused', async () => {
    const hold = define(holdFirst());
    const req = request(hold);
    const x0 = (s: BatchState, extra: Partial<ExceptionRecord> = {}): ExceptionRecord => ({
      id: 'EX-1', type: 'DECISION_NOT_EVALUABLE', category: 'FLOW', title: 'Forged', controls: ['DI-34'], severity: 'ACTION', source: { frames: [] }, raisedAt: T0, raisedSeq: s.seq,
      raisedBy: SUP1.id, deviationRequired: true, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN', ...extra,
    });
    const at = (s: BatchState, key: string) => {
      const i = s.steps[key];
      if (!i) throw new Error(`SETUP: no step ${key}`);
      return i;
    };
    const outcomes: Record<string, string> = {
      honest: await issuedState(hold, req),
      holdDecision: await issuedState(hold, req, (s) => void (at(s, 'H1@').disposition = { value: 'APPROVED', positive: true, by: 'QA1', signature: 'SIG-1', at: T0 })),
      closedException: await issuedState(hold, req, (s) => void (s.exceptions['EX-1'] = x0(s, { status: 'DISPOSITIONED', disposition: { by: 'QA1', outcome: 'NO_IMPACT', justification: 'x', signature: 'SIG-1', at: T0 } }))),
      linkedException: await issuedState(hold, req, (s) => void (s.exceptions['EX-1'] = x0(s, { deviation: { ref: 'DEV-1', linkedBy: 'SUP1', at: T0 } }))),
      operatorException: await issuedState(hold, req, (s) => void (s.exceptions['EX-1'] = x0(s, { type: 'OPERATOR_RAISED', category: 'DEVIATION_OR_OVERRIDE', title: 'SUP1: x', controls: ['PR-13', 'PR-49'], severity: 'ALERT', deviationRequired: false }))),
      status: await issuedState(hold, req, (s) => void (s.status = 'IN_PROGRESS')),
      dataPoint: await issuedState(hold, req, (s) => void (s.points['PT-1'] = { id: 'PT-1' } as BatchState['points'][string])),
      entry: await issuedState(hold, req, (s) => void (s.entries['E-1'] = { id: 'E-1' } as unknown as BatchState['entries'][string])),
      container: await issuedState(hold, req, (s) => void (s.containers['C-1'] = { id: 'C-1' } as unknown as BatchState['containers'][string])),
      derived: await issuedState(hold, req, (s) => void (s.derived['D-1'] = { id: 'D-1' } as unknown as BatchState['derived'][string])),
      held: await issuedState(hold, req, (s) => void (s.holds['H-1'] = { id: 'H-1', type: 'QA', reason: 'x', placedBy: 'QA1', at: T0, automatic: false })),
      appliedCommand: await issuedState(hold, req, (s) => void s.appliedCommands.push('C-1')),
      usedSignature: await issuedState(hold, req, (s) => void (s.usedSignatures['SIG-1'] = 'batch issued')),
      headerSignature: await issuedState(hold, req, (s) => void (s.header.issueSignature = 'SIG-1')),
      requestSignature: await issuedState(hold, req, undefined, encode({ ...req, issueSignature: { id: 'SIG-1', meaning: 'BATCH_ISSUED', signer: SUP1.id } })),
      personDecision: await issuedState(hold, req, (s) => void (s.decisions['ALT@'] = { key: 'ALT@', kind: 'BRANCH', construct: 'ALT', frames: [], outcome: 'b1', decidedBy: 'SUP1', at: T0, seq: 1, inputs: { points: [], derived: [] } })),
      stageSignOff: await issuedState(hold, req, (s) => {
        const g = Object.values(s.stages)[0];
        if (!g) throw new Error('SETUP: no stage');
        g.signOff = { by: 'HEAD1', signature: 'SIG-1', at: T0, valid: true, summary: {} as never };
      }),
      performer: await issuedState(hold, req, (s) => void at(s, 'H1@').performers.push('OP1')),
      dataEnterer: await issuedState(hold, req, (s) => void at(s, 'H1@').dataEnterers.push('OP1')),
      corrector: await issuedState(hold, req, (s) => void at(s, 'H1@').correctors.push('OP1')),
      performedSigner: await issuedState(hold, req, (s) => void at(s, 'H1@').performedSigners.push('OP1')),
      stepSignature: await issuedState(hold, req, (s) => void at(s, 'H1@').signatures.push({ id: 'SIG-1' } as never)),
      started: await issuedState(hold, req, (s) => void (at(s, 'H1@').startedAt = T0)),
      startedSeq: await issuedState(hold, req, (s) => void (at(s, 'H1@').startedSeq = 1)),
      ended: await issuedState(hold, req, (s) => void (at(s, 'H1@').endedAt = T0)),
      completedAt: await issuedState(hold, req, (s) => void (at(s, 'H1@').completedAt = T0)),
      completed: await issuedState(hold, req, (s) => void (at(s, 'H1@').status = 'COMPLETED')),
      skipped: await issuedState(hold, req, (s) => void (at(s, 'H1@').skip = { reason: 'x', requestedBy: 'OP1', approvedBy: 'SUP1', signature: 'SIG-1', at: T0 })),
      reverification: await issuedState(hold, req, (s) => void (at(s, 'H1@').reverification = true)),
      targets: await issuedState(hold, req, (s) => void (at(s, 'H1@').targets['m'] = { value: { kind: 'DECIMAL', value: '1', unit: 'kg' }, points: [], derived: [] })),
      blockComputed: await issuedState(hold, req, (s) => void (at(s, 'H1@').blockComputed['m'] = 'fp')),
    };
    const want: Record<string, string> = Object.fromEntries(Object.keys(outcomes).map((k) => [k, 'EBMR-EXE-030']));
    Object.assign(want, { honest: 'ok', holdDecision: 'EBMR-EXE-044', closedException: 'EBMR-EXE-044', linkedException: 'EBMR-EXE-044', operatorException: 'EBMR-EXE-044' });
    expect(outcomes).toEqual(want);
  });
});

describe('the role map (P22)', () => {
  it('[D4][INV-26] every engine role is reachable only through the map of decision D4, and each map row names a permission its kernel role holds', async () => {
    const { rows } = await db.admin.query<{ kernel_role: string; engine_role: string; via_permission: string; held: boolean }>(
      `select m.kernel_role, m.engine_role, m.via_permission,
              exists (select 1 from iam.role_permission rp where rp.role_code = m.kernel_role and rp.permission_code = m.via_permission and rp.removed_at is null) as held
         from recipe.engine_role_map m order by 1, 2`,
    );
    expect(rows.filter((r) => !r.held)).toEqual([]);
    expect(rows.map((r) => `${r.kernel_role}>${r.engine_role}`)).toEqual([
      'DISPENSER>DISPENSER',
      'HEAD_OF_PRODUCTION>HEAD_OF_PRODUCTION',
      'OPERATOR>PRODUCTION_OPERATOR',
      'QA_REVIEWER>QA_REVIEWER',
      'QA_SHOP_FLOOR>QA',
      'SHIFT_SUPERVISOR>PRODUCTION_SUPERVISOR',
      'STAGE_RESPONSIBLE>STAGE_RESPONSIBLE',
      'VERIFIER>PRODUCTION_VERIFIER',
    ]);
    // A shared permission never lets one kernel role carry another's engine role.
    const shared = await db.admin.query<{ n: string }>(
      `select count(*)::text as n from recipe.engine_role_map a join recipe.engine_role_map b on a.via_permission = b.via_permission and a.kernel_role <> b.kernel_role
        where a.engine_role = b.engine_role`,
    );
    expect(shared.rows[0]?.n).toBe('0');
  });
});

describe('a limit exception as the value and the MBR\'s limits give it (P25 round-2 verification; recipe-core 0305)', () => {
  type Json = Record<string, unknown>;
  const LIMIT_TYPES = new Set(['LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS']);
  const SIGNED = new Set(['SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION', 'CORRECT_ENTRY']);

  /** One row as the store writes it: the state before and after it, and the person whose command it records. */
  interface Row {
    label: string;
    by: string;
    before: BatchState;
    after: BatchState;
  }

  /** The rows the store writes for the commands `run` executed from state `start` (the PREPARE row of a signing when it changes something). */
  function rowsOf(run: Run, start: BatchState): Row[] {
    const rows: Row[] = [];
    let before = start;
    for (const [i, e] of run.log.entries()) {
      const label = `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
      if (SIGNED.has(e.command.type)) {
        const p = prepareForSignature(run.def, before, signatureTargetOf(e.command), e.command.actor, { nowUs: e.nowUs });
        if (p.changed) rows.push({ label: `${label} PREPARE`, by: e.command.actor.id, before, after: p.state });
      }
      rows.push({ label, by: e.command.actor.id, before, after: e.result.state });
      before = e.result.state;
    }
    return rows;
  }

  /** JSON with the keys of every object sorted, to compare records as sets. */
  const canon = (v: unknown): string =>
    JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

  /** The limit exceptions the engine raised in a row, as the state stores them, without their id and time of raising. */
  function engineRecords(r: Row): string[] {
    return Object.values(r.after.exceptions)
      .filter((x) => r.before.exceptions[x.id] === undefined && LIMIT_TYPES.has(x.type))
      .map((x) => {
        const j = { ...(encode(x) as Json) };
        delete j['id'];
        delete j['raisedAt'];
        delete j['raisedSeq'];
        return canon(j);
      })
      .sort();
  }

  /** recipe.limit_verdicts for a row: the records its verdicts raise and the problems it finds. */
  async function sqlVerdicts(content: unknown, before: unknown, after: unknown, by: string): Promise<{ records: string[]; problems: string[] }> {
    const { rows } = await db.admin.query<{ v: { want: Json | null; problem: string | null; what: string } }>('select v from recipe.limit_verdicts($1::jsonb, $2::jsonb, $3::jsonb, $4) v', [
      JSON.stringify(content),
      JSON.stringify(before),
      JSON.stringify(after),
      by,
    ]);
    return {
      records: rows.flatMap((r) => (r.v.want ? [canon(r.v.want)] : [])).sort(),
      problems: rows.flatMap((r) => (r.v.problem !== null ? [`${r.v.what}: ${r.v.problem}`] : [])),
    };
  }

  /** recipe.limit_exceptions_problem for a row (null: the row records exactly the limit exceptions of its verdicts). */
  async function limitProblem(content: unknown, before: unknown, after: unknown, by: string): Promise<string | null> {
    const { rows } = await db.admin.query<{ p: string | null }>('select recipe.limit_exceptions_problem($1::jsonb, $2::jsonb, $3::jsonb, $4) as p', [
      JSON.stringify(content),
      JSON.stringify(before),
      JSON.stringify(after),
      by,
    ]);
    return rows[0]?.p ?? null;
  }

  /** Every row of a run where the database's verdicts differ from the engine's, or where it finds a problem (empty: none). */
  async function differences(content: unknown, rows: readonly Row[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      const before = encodeState(r.before);
      const after = encodeState(r.after);
      const engine = engineRecords(r);
      const sql = await sqlVerdicts(content, before, after, r.by);
      const problem = await limitProblem(content, before, after, r.by);
      if (sql.problems.length > 0 || problem !== null || !isDeepStrictEqual(sql.records, engine)) out[r.label] = { engine, sql: sql.records, problems: sql.problems, problem };
    }
    return out;
  }

  const bound = (value: string, inclusive = true) => ({ value, inclusive });
  const range = (tier: LimitRange['tier'], low: string | undefined, high: string | undefined, rounding: LimitRange['rounding'] = 'USP_HALF_UP_AT_LIMIT_DECIMALS', strict = false): LimitRange => ({
    tier,
    ...(low !== undefined ? { low: bound(low, !strict) } : {}),
    ...(high !== undefined ? { high: bound(high, !strict) } : {}),
    rounding,
    source: { kind: 'VALIDATION_REPORT', ref: 'V' },
  });
  const limits = (unit: string, ranges: LimitRange[], extra: Partial<LimitSpec> = {}): LimitSpec => ({ unit, ranges, ...extra });
  const decimal = (value: string, unit: string): DataValue => ({ kind: 'DECIMAL', value, unit });
  const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
  const precise = (id: string, unit: string, spec: LimitSpec, extra: Partial<Parameter> = {}): Parameter => param(id, { unit, precision: { kind: 'DECIMALS', digits: 4 }, limits: spec, ...extra });

  /** Parameters with every kind of limit the engine judges, and the values recorded for each. */
  const TIERED: { parameter: Parameter; values: DataValue[] }[] = [
    {
      // Four tiers written out of order; USP rounding to the limit's decimals (the finer bound of a range).
      parameter: precise('bt', 'min', limits('min', [range('ALERT', '14.0', '16.0'), range('INTERNAL_ACTION', '12', '18'), range('VALIDATED', '9.5', '20.5'), range('REGISTERED', '10', '20')])),
      values: ['15', '14.0', '13.95', '13.94', '16.05', '12', '11.5', '11.49', '9.9', '9.4', '20.5', '20.51', '21', '-3', '18', '18.4', '18.5', '19'].map((v) => decimal(v, 'min')),
    },
    {
      // Ph. Eur.: rounded to the significant figures of each bound.
      parameter: precise('pe', 'N', limits('N', [range('INTERNAL_ACTION', '0.10', '140', 'PH_EUR_SIG_FIGS'), range('ALERT', '0.20', '100', 'PH_EUR_SIG_FIGS')])),
      values: ['0.095', '0.0995', '0.195', '0.1949', '100.4', '100.5', '140.4', '140.5', '999.5', '0', '12.35'].map((v) => decimal(v, 'N')),
    },
    {
      // Strict bounds, and a Ph. Eur. bound of zero (rounded to its decimals).
      parameter: precise('zs', 'Cel', limits('Cel', [range('INTERNAL_ACTION', '5.0', '6.0', 'USP_HALF_UP_AT_LIMIT_DECIMALS', true), range('ALERT', '0', '5.9', 'PH_EUR_SIG_FIGS')])),
      values: ['5.0', '5.04', '5.05', '5.95', '6.0', '5.5', '-0.4', '-0.5'].map((v) => decimal(v, 'Cel')),
    },
    {
      // The MBR lets the measuring step continue after an internal-action breach.
      parameter: precise('cc', 'kg', limits('kg', [range('INTERNAL_ACTION', '1.0', '2.0')], { actionBreach: 'CONTINUE_CURRENT_STEP_WITH_DEVIATION' })),
      values: ['1.5', '2.04', '2.05', '0.94'].map((v) => decimal(v, 'kg')),
    },
    {
      // Readings: the worst reading governs, the first of the most severe.
      parameter: precise('w', 'mg', limits('mg', [range('INTERNAL_ACTION', '240', '260'), range('ALERT', '245', '255')]), { readings: 3 }),
      values: [['250', '250', '250'], ['250', '262', '244'], ['239', '261', '250'], ['246', '254', '250'], ['244', '250', '256']].map((values) => ({ kind: 'SERIES', values, unit: 'mg' })),
    },
    {
      // A count against limits whose unit is an annotation (converted with the factor 1).
      parameter: param('n', { valueType: 'COUNT', unit: '{tablets}', limits: limits('{tablets}', [range('INTERNAL_ACTION', undefined, '10'), range('ALERT', undefined, '5')]) }),
      values: ['4', '5', '6', '10', '11'].map((value) => ({ kind: 'COUNT', value })),
    },
    {
      // Negative values, rounded half away from zero.
      parameter: precise('neg', 'Cel', limits('Cel', [range('INTERNAL_ACTION', '-5.0', '5.0')])),
      values: ['-5.04', '-5.05', '5.049', '5.05', '0'].map((v) => decimal(v, 'Cel')),
    },
    {
      // USP with bounds written to different decimals: both are compared at the finer one (94.94 is 94.9, not 95).
      parameter: precise('mix', '%', limits('%', [range('INTERNAL_ACTION', '95', '105.0')])),
      values: ['94.94', '94.95', '105.04', '105.05', '100'].map((v) => decimal(v, '%')),
    },
    {
      // A registered maximum only.
      parameter: precise('hi', 'kg', limits('kg', [range('REGISTERED', undefined, '100')])),
      values: ['100.4', '100.5'].map((v) => decimal(v, 'kg')),
    },
  ];

  /** A step recording every tiered parameter, each value an attempt of its own. */
  function tieredRun(): { run: Run; start: BatchState; content: MbrContent } {
    const content = mbrWith(seq('ops', phase('rec', { records: TIERED.map((t) => t.parameter.id) }), phase('after')), { parameters: TIERED.map((t) => t.parameter) });
    const run = Run.issue(define(content));
    const start = run.state;
    run.start('rec');
    for (const t of TIERED) for (const v of t.values) run.record('rec', t.parameter.id, v);
    return { run, start, content };
  }

  /** in (manual) -> out -> a yield calculation with limits of its own and a yield checkpoint on it. */
  function yieldRun(good: string): { run: Run; start: BatchState; content: MbrContent } {
    const content = mbrWith(seq('ops', phase('in', { records: ['charged'] }), phase('out', { records: ['good'] }), phase('y', { block: { type: 'G-20', version: '1' }, computes: ['yld'] }), phase('end')), {
      parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
      calculations: [{ id: 'yld', name: 'Yield', expression: 'yield(good, charged)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH', limits: limits('%', [range('INTERNAL_ACTION', '97.0', '101.0')]) }],
      yieldCheckpoints: [{ id: 'Y1', name: 'Blend yield', kind: 'YIELD', theoretical: 'charged', result: 'yld', basis: 'AS_IS', limits: limits('%', [range('VALIDATED', '95.0', '102.0'), range('ALERT', '98.0', '100.0')]) }],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    run.start('in');
    run.record('in', 'charged', decimal('10.00', 'kg'), { source: { mode: 'MANUAL' } });
    run.perform('in');
    run.verify('in');
    done(run, 'out', { good });
    run.exec({ type: 'START_STEP', actor: OP1, step: 'y', context: [] });
    run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'y', context: [], signature: sig(performMeaning(run.def, 'y'), OP1) });
    return { run, start, content };
  }

  /** A drying loop whose endpoint (limits VALIDATED 0.0-5.0 %) is judged at the loop's exit. */
  function loopRun(max: number, values: readonly string[]): { run: Run; start: BatchState; content: MbrContent } {
    const content = mbrWith(seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: max, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('dry'), phase('test', { records: ['ep'] })) }, phase('after')), {
      parameters: [endpoint('ep')],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    values.forEach((value, i) => {
      const f = [{ construct: 'L', index: i + 1 }];
      done(run, 'dry', {}, f);
      run.start('test', f);
      run.record('test', 'ep', decimal(value, '%'), { frames: f });
      run.perform('test', f);
      run.verify('test', f);
      run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
    });
    return { run, start, content };
  }

  /** A failing hand entry corrected to another failing value, then to a passing one with evidence and QA approval. */
  function correctionRun(): { run: Run; start: BatchState; content: MbrContent } {
    const content = mbrWith(seq('ops', phase('m', { records: ['t'] }), phase('n')), {
      parameters: [param('t', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL', limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) })],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    run.start('m');
    run.record('m', 't', decimal('2.50', 'kg'), { source: { mode: 'MANUAL' } });
    const first = Object.values(run.state.points)[0]?.id ?? '';
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: first, value: decimal('2.60', 'kg'), reason: 'keying error: 2.60 on the printout', signature: sig('CORRECTED', OP1) });
    const second = Object.values(run.state.points).find((p) => p.status === 'VALID')?.id ?? '';
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: second, value: decimal('1.50', 'kg'), reason: 'typo; printout shows 1.50', signature: sig('CORRECTED', OP1), evidence: { kind: 'PRINTOUT', sha256: 'b'.repeat(64) }, approval: { approver: QA1, signature: sig('CORRECTION_APPROVED', QA1) } });
    return { run, start, content };
  }

  it('[PR-08][PR-49][DI-26][DI-33] the database judges every value as the engine does and derives exactly the limit exceptions the engine raises: both golden runs, every tier, rounding rule and bound, readings, counts, a step allowed to continue, computed values and yields, loop exits and corrections', async () => {
    const raised: ExceptionRecord[] = [];
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants });
      const start = run.state;
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      expect(await differences(loadFixture(name), rowsOf(run, start)), name).toEqual({});
      raised.push(...Object.values(run.state.exceptions));
    }
    const crafted = [tieredRun(), ...['9.80', '9.75', '9.60', '9.40', '10.30'].map((good) => yieldRun(good)), loopRun(3, ['3.0', '-0.1']), loopRun(2, ['4.0', '6.0']), loopRun(3, ['0.5']), correctionRun()];
    for (const [i, c] of crafted.entries()) {
      expect(await differences(c.content, rowsOf(c.run, c.start)), `crafted run ${i}`).toEqual({});
      raised.push(...Object.values(c.run.state.exceptions));
    }
    // What the runs exercise: every severity and requirement, both types, a rounded value compared, a step allowed to
    // continue, a verdict at a loop exit, a computed value, and a corrected value judged again.
    const limit = raised.filter((x) => LIMIT_TYPES.has(x.type));
    expect(new Set(limit.map((x) => `${x.type}/${x.severity}/${x.tier ?? ''}`))).toEqual(
      new Set([
        'LIMIT_BREACH/ALERT/ALERT',
        'LIMIT_BREACH/ACTION/INTERNAL_ACTION',
        'LIMIT_BREACH/CRITICAL/REGISTERED',
        'LIMIT_BREACH/CRITICAL/VALIDATED',
        'YIELD_OUT_OF_LIMITS/ALERT/ALERT',
        'YIELD_OUT_OF_LIMITS/CRITICAL/VALIDATED',
      ]),
    );
    expect(limit.some((x) => x.title.includes('(compared as '))).toBe(true);
    expect(limit.some((x) => x.severity === 'ACTION' && x.block?.steps.length === 0 && x.block.downstream !== undefined)).toBe(true);
    expect(limit.filter((x) => x.title.includes(' at the exit of Dry until LOD ')).map((x) => x.tier), 'the drying loop of the golden run').toEqual(['ALERT']);
    expect(limit.filter((x) => x.title.includes('(ep) at the exit of Dry ')).map((x) => x.tier), 'the crafted loops').toEqual(['VALIDATED', 'VALIDATED']);
    expect(limit.some((x) => x.source.derived !== undefined && x.type === 'LIMIT_BREACH')).toBe(true);
    expect(limit.filter((x) => x.source.item === 't')).toHaveLength(2);
  }, 240_000);

  /** The honest row that records a blend time of 19 min (internal action limit 12-18 min), and what it raises. */
  function blendTime(value = '19'): { content: MbrContent; before: JsonValue; after: Json; exception: string; point: string } {
    const content = mbrWith(seq('ops', phase('p', { records: ['bt'] }), phase('q')), {
      parameters: [param('bt', { name: 'Blend time', unit: 'min', precision: { kind: 'DECIMALS', digits: 0 }, capture: 'MANUAL', evidence: 'NONE', limits: limits('min', [range('REGISTERED', '10', '20'), range('INTERNAL_ACTION', '12', '18'), range('ALERT', '14', '16')]) })],
    });
    const run = Run.issue(define(content));
    run.start('p');
    const before = encodeState(run.state);
    run.record('p', 'bt', decimal(value, 'min'), { source: { mode: 'MANUAL' } });
    const after = encodeState(run.state) as Json;
    const x = Object.values(run.state.exceptions).find((e) => e.type === 'LIMIT_BREACH');
    const point = Object.values(run.state.points)[0]?.id ?? '';
    return { content, before, after, exception: x?.id ?? '', point };
  }

  it('[PR-08][PR-49][DI-26][INV-41] a limit exception stored with other facts than its verdict gives it, left out, not marked on its value, or added where nothing is judged, is refused (EBMR-EXE-044); the honest ones are recorded', async () => {
    const honest = blendTime();
    const alert = blendTime('17');
    const pass = blendTime('15');
    expect((alert.after['exceptions'] as Record<string, Json>)[alert.exception]).toMatchObject({ severity: 'ALERT', tier: 'ALERT', deviationRequired: false });
    expect(pass.exception).toBe('');
    const x0 = (honest.after['exceptions'] as Record<string, Json>)[honest.exception];
    expect(x0).toMatchObject({
      type: 'LIMIT_BREACH', severity: 'ACTION', tier: 'INTERNAL_ACTION', deviationRequired: true, releaseBlocking: false,
      title: 'Blend time (bt) 19 min is outside its internal action limit (internal action high limit; alert high limit): this step and the steps after it wait until a deviation is linked',
      block: { steps: ['p@'], until: 'DEVIATION', downstream: { node: 'task:p', frames: [] } },
    });
    /** The problem the database finds with the honest row's state after `edit`. */
    const forged = async (edit: (s: Json, x: Json, point: Json) => void, before: unknown = honest.before): Promise<string | null> => {
      const s = structuredClone(honest.after);
      const exceptions = s['exceptions'] as Record<string, Json>;
      edit(s, exceptions[honest.exception] as Json, (s['points'] as Record<string, Json>)[honest.point] as Json);
      return limitProblem(honest.content, before, s, 'OP1');
    };
    const outcomes = {
      honest: await limitProblem(honest.content, honest.before, honest.after, 'OP1'),
      honestAlert: await limitProblem(alert.content, alert.before, alert.after, 'OP1'),
      honestPass: await limitProblem(pass.content, pass.before, pass.after, 'OP1'),
      // The verification's forgery: an ALERT of tier ALERT that needs no deviation and blocks nothing.
      storedAsAlert: await forged((_s, x) => {
        Object.assign(x, { severity: 'ALERT', tier: 'ALERT', deviationRequired: false, releaseBlocking: false });
        delete x['block'];
      }),
      severityLowered: await forged((_s, x) => void (x['severity'] = 'ALERT')),
      deviationDropped: await forged((_s, x) => void (x['deviationRequired'] = false)),
      blockDropped: await forged((_s, x) => void delete x['block']),
      stepLeftRunning: await forged((_s, x) => void ((x['block'] as Json)['steps'] = [])),
      tierRelabelled: await forged((_s, x) => void (x['tier'] = 'ALERT')),
      retitled: await forged((_s, x) => void (x['title'] = 'Blend time (bt) 19 min: registered for review')),
      qaOnly: await forged((_s, x) => void (x['qaOnly'] = true)),
      raisedByAnother: await forged((_s, x) => void (x['raisedBy'] = 'OP2')),
      otherSource: await forged((_s, x) => void ((x['source'] as Json)['item'] = 'other')),
      typeRelabelled: await forged((_s, x) => void (x['type'] = 'REPEAT_ATTEMPT')),
      leftOut: await forged((s, _x, p) => {
        delete (s['exceptions'] as Json)[honest.exception];
        p['exceptions'] = [];
      }),
      // The step instance, the exception's source and its block all name frames the instance's key does not have.
      framesForged: await forged((s, x) => {
        const frames = [{ construct: 'X', index: 1 }];
        ((s['steps'] as Record<string, Json>)['p@'] as Json)['frames'] = frames;
        (x['source'] as Json)['frames'] = frames;
        (((x['block'] as Json)['downstream']) as Json)['frames'] = frames;
      }),
      notFailed: await forged((_s, _x, p) => void (p['failed'] = false)),
      notNamed: await forged((_s, _x, p) => void (p['exceptions'] = [])),
      evaluationPassed: await forged((_s, _x, p) => void (p['evaluation'] = { requirement: 'NONE', detail: [], languageVersion: '1' })),
      keptWaiting: await forged((_s, _x, p) => void (p['evaluation'] = { requirement: 'ENDPOINT_IN_PROGRESS', detail: [], languageVersion: '1' })),
      twice: await forged((s, x, p) => {
        (s['exceptions'] as Json)['EX-99'] = { ...x, id: 'EX-99' };
        p['exceptions'] = [...(p['exceptions'] as string[]), 'EX-99'];
      }),
      // A row that judges nothing (the state already held the value) adds a limit exception.
      addedWhereNothingIsJudged: await forged((s, x) => void ((s['exceptions'] as Json)['EX-99'] = { ...x, id: 'EX-99' }), honest.after),
    };
    const refused = Object.fromEntries(Object.entries(outcomes).filter(([, p]) => p !== null).map(([k]) => [k, 'refused']));
    expect({ ...outcomes, ...refused }).toEqual({
      honest: null,
      honestAlert: null,
      honestPass: null,
      storedAsAlert: 'refused',
      severityLowered: 'refused',
      deviationDropped: 'refused',
      blockDropped: 'refused',
      stepLeftRunning: 'refused',
      tierRelabelled: 'refused',
      retitled: 'refused',
      qaOnly: 'refused',
      raisedByAnother: 'refused',
      otherSource: 'refused',
      framesForged: 'refused',
      typeRelabelled: 'refused',
      leftOut: 'refused',
      notFailed: 'refused',
      notNamed: 'refused',
      evaluationPassed: 'refused',
      keptWaiting: 'refused',
      twice: 'refused',
      addedWhereNothingIsJudged: 'refused',
    });
    expect(outcomes.storedAsAlert).toMatch(/^exception EX-1 \(LIMIT_BREACH, tier ALERT, severity ALERT\) is not an exception a verdict of this row raises$/);
    expect(outcomes.leftOut).toMatch(/is outside its internal action limit, and the state does not record the LIMIT_BREACH exception that verdict raises/);
  });

  it('[PR-08][INV-19][INV-41] a loop endpoint is kept waiting until the loop\'s exit, and the exit gives it its verdict: judged early, or an exit that leaves it waiting, is refused', async () => {
    const { run, start, content } = loopRun(2, ['4.0', '6.0']);
    const rows = rowsOf(run, start);
    const record = rows.find((r) => r.label.includes('RECORD_DATA test'));
    const exit = rows.filter((r) => r.label.includes('COMPLETE_LOOP_ITERATION')).at(-1);
    if (!record || !exit) throw new Error('SETUP: no recording or exit row');
    const pointOf = (s: Json): [string, Json] => Object.entries(s['points'] as Record<string, Json>).find(([, p]) => p['item'] === 'ep') ?? ['', {}];
    // Judged when recorded, although its loop has not exited.
    const early = encodeState(record.after) as Json;
    pointOf(early)[1]['evaluation'] = { requirement: 'NONE', detail: [], languageVersion: '1' };
    // The exit leaves the endpoint waiting and raises nothing.
    const silent = encodeState(exit.after) as Json;
    const exitBefore = encodeState(exit.before) as Json;
    const [key] = Object.entries(silent['points'] as Record<string, Json>).find(([k, p]) => p['item'] === 'ep' && ((exitBefore['points'] as Record<string, Json>)[k]?.['evaluation'] as Json | undefined)?.['requirement'] === 'ENDPOINT_IN_PROGRESS' && (p['evaluation'] as Json)['requirement'] !== 'ENDPOINT_IN_PROGRESS') ?? [''];
    const judged = (silent['points'] as Record<string, Json>)[key] as Json;
    const exceptionIds = judged['exceptions'] as string[];
    (silent['points'] as Record<string, Json>)[key] = (exitBefore['points'] as Record<string, Json>)[key] as Json;
    for (const id of exceptionIds) delete (silent['exceptions'] as Json)[id];
    const outcomes = {
      honestRecord: await limitProblem(content, encodeState(record.before), encodeState(record.after), 'OP1'),
      honestExit: await limitProblem(content, exitBefore, encodeState(exit.after), 'OP1'),
      judgedEarly: await limitProblem(content, encodeState(record.before), early, 'OP1'),
      exitLeavesItWaiting: await limitProblem(content, exitBefore, silent, 'OP1'),
    };
    expect([outcomes.honestRecord, outcomes.honestExit]).toEqual([null, null]);
    expect(outcomes.judgedEarly).toMatch(/is the endpoint of a loop whose iteration is not decided yet/);
    expect(outcomes.exitLeavesItWaiting).toMatch(/the exit of loop L .* judges the endpoint ep of that iteration against its limits, and the state gives none of its values that verdict/);
  });

  it('[PR-08][DI-30] stricter than the engine: a value in another unit than its limits (converted by the engine) or not of its parameter\'s type is refused rather than judged without proof', async () => {
    const content = mbrWith(seq('ops', phase('p', { records: ['h', 'k', 'r'] }), phase('q')), {
      parameters: [
        param('h', { unit: 'min', precision: { kind: 'DECIMALS', digits: 0 }, limits: limits('h', [range('INTERNAL_ACTION', '0.20', '0.30')]) }),
        param('k', { unit: 'kg', limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) }),
        param('r', { unit: 'kg', readings: 3, limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) }),
      ],
    });
    const run = Run.issue(define(content));
    run.start('p');
    const before = encodeState(run.state);
    run.record('p', 'h', decimal('15', 'min'));
    const inMinutes = encodeState(run.state) as Json;
    expect(Object.values(run.state.points)[0]?.evaluation?.requirement, 'SETUP: the engine judges 15 min against 0.20-0.30 h').toBe('NONE');
    const run2 = Run.issue(define(content));
    run2.start('p');
    const before2 = encodeState(run2.state);
    run2.record('p', 'k', decimal('1500', 'g'));
    const inGrams = encodeState(run2.state) as Json;
    const asText = structuredClone(inGrams);
    ((Object.values(asText['points'] as Record<string, Json>)[0] as Json)['value'] = { kind: 'TEXT', value: '1.5' });
    const asNumber = structuredClone(inGrams);
    ((Object.values(asNumber['points'] as Record<string, Json>)[0] as Json)['value'] = { kind: 'DECIMAL', value: 1.5, unit: 'kg' });
    const run3 = Run.issue(define(content));
    run3.start('p');
    const before3 = encodeState(run3.state);
    run3.record('p', 'r', { kind: 'SERIES', values: ['1.00', '1.00', '1.00'], unit: 'kg' });
    const readingsNotAList = encodeState(run3.state) as Json;
    ((Object.values(readingsNotAList['points'] as Record<string, Json>)[0] as Json)['value'] = { kind: 'SERIES', values: '1.00', unit: 'kg' });
    const outcomes = {
      minutesAgainstHours: await limitProblem(content, before, inMinutes, 'OP1'),
      gramsAgainstKilograms: await limitProblem(content, before2, inGrams, 'OP1'),
      textForANumber: await limitProblem(content, before2, asText, 'OP1'),
      numberNotText: await limitProblem(content, before2, asNumber, 'OP1'),
      readingsNotAList: await limitProblem(content, before3, readingsNotAList, 'OP1'),
    };
    expect(outcomes.minutesAgainstHours).toMatch(/it is recorded in min and its limits are written in h; the database compares a value with its limits in their own unit only/);
    expect(outcomes.gramsAgainstKilograms).toMatch(/it is recorded in g and its limits are written in kg/);
    expect(outcomes.textForANumber).toMatch(/the parameter takes a decimal, and the value is text/);
    // Malformed values are refused with a reason, never by an error of the check itself.
    expect(outcomes.numberNotText).toMatch(/a reading is not a decimal number written as text/);
    expect(outcomes.readingsNotAList).toMatch(/the parameter is captured as 3 readings, and the value is not/);
  });

  it('[DI-13][DI-23] the derivation is private to the owner and pins its search_path; the guard keeps its owner, SECURITY DEFINER, volatility, search_path and privileges', async () => {
    const helpers = [
      'recipe.written_decimals(text)',
      'recipe.written_significant_figures(text)',
      'recipe.decimal_exponent(numeric)',
      'recipe.limit_bound_check(numeric,jsonb,jsonb,text,text)',
      'recipe.limit_reading(jsonb,text)',
      'recipe.unit_core(text)',
      'recipe.limit_value(jsonb,jsonb)',
      'recipe.limit_value_type_problem(jsonb,jsonb)',
      'recipe.limit_exception_record(text,text,text,jsonb,jsonb,jsonb,text,jsonb,text)',
      'recipe.mbr_member(jsonb,text)',
      'recipe.frames_head(jsonb,integer)',
      'recipe.limit_instance(jsonb,text,text)',
      'recipe.step_graph_node(jsonb,text)',
      'recipe.loop_endpoint_waiting(jsonb,jsonb,text,jsonb)',
      'recipe.loop_exit_candidates(jsonb,jsonb,text,jsonb)',
      'recipe.limit_mark_problem(jsonb,jsonb,boolean,boolean)',
      'recipe.limit_verdicts(jsonb,jsonb,jsonb,text)',
      'recipe.limit_exceptions_problem(jsonb,jsonb,jsonb,text)',
    ];
    const fns = [...helpers, 'recipe.check_exception_changes(jsonb,jsonb,text,jsonb,boolean)'];
    const { rows } = await db.admin.query<{ fn: string; owner: string; definer: boolean; volatility: string; config: string[]; grantees: string[] }>(
      `select f as fn, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config,
              array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end
                      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> p.proowner order by 1)::text[] as grantees
         from unnest($1::text[]) with ordinality u (f, n) join pg_catalog.pg_proc p on p.oid = f::regprocedure order by u.n`,
      [fns],
    );
    // Helpers that call no other recipe function pin pg_catalog and pg_temp only.
    const plain = new Set(['recipe.written_decimals(text)', 'recipe.written_significant_figures(text)', 'recipe.decimal_exponent(numeric)', 'recipe.unit_core(text)',
      'recipe.limit_value_type_problem(jsonb,jsonb)', 'recipe.mbr_member(jsonb,text)', 'recipe.frames_head(jsonb,integer)', 'recipe.limit_mark_problem(jsonb,jsonb,boolean,boolean)']);
    expect(rows).toEqual(
      fns.map((fn) => ({
        fn,
        owner: 'ebmr_owner',
        definer: !helpers.includes(fn),
        volatility: helpers.includes(fn) ? 'i' : 's',
        config: [plain.has(fn) ? 'search_path=pg_catalog, pg_temp' : 'search_path=pg_catalog, recipe, pg_temp'],
        grantees: [],
      })),
    );
    await expect(db.app.query(`select recipe.limit_exceptions_problem('{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'x')`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`select recipe.limit_exception_record('PARAMETER', 's', 'i', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'task:p', '{}'::jsonb, 'x')`)).rejects.toThrow(/permission denied/);
  });
});
