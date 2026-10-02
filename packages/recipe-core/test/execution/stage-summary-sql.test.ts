/**
 * The database derives a stage's summary as the engine does (recipe-core sql/0319: recipe.stage_summary_of,
 * recipe.canonical_stage_summary, recipe.stage_summary_content; Phase 2 exit review F01; DI-37, IN-15, PR-16, G-02).
 *
 * The summary is part of the text a STAGE_SIGNED_OFF signature binds: the server adds the engine's member
 * (stage-summary.ts stageSummaryMember) to the stored content, the database's provider adds its own. Were the two to
 * differ, every stage sign-off would be refused as changed content; were the database's to follow less of the record
 * than the engine's, a summary changed after the preview would pass. So for every state of the golden runs of both
 * fixtures (sub-lots, loops, yields, exceptions dispositioned and open, sign-offs), and for each stage frame, the
 * database's member equals the engine's, before and after the sign-off; and so it does for states changed in every
 * fact the summary reads (an exception reopened, a deviation linked, a disposition as a deviation, a skipped step, a
 * time-limit breach naming a step by step and frames, inside the frame or not, a yield withdrawn), each of which
 * changes the summary.
 *
 * Round 2 (recipe-core sql/0320, recipe.stage_sign_off_shape_problem): the canonical form keeps only the members the
 * signed text holds, so the database also checks that a recorded sign-off is exactly what the engine records. Every
 * sign-off of the golden runs passes that check at the engine's transaction time, and each member, time or signer of
 * its own fails it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '@ebmr/expr';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { compareCodePoints, deriveStageSummary, stageSummaryContent, stageSummaryMember } from '../../src/engine/stage-summary.ts';
import { ctxKey } from '../../src/engine/tx.ts';
import type { BatchState, ExceptionRecord } from '../../src/engine/types.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

/** The database's member (recipe.stage_summary_content) and its derivation (recipe.stage_summary_of) for every stage frame of `s`. */
async function sqlMembers(def: BatchDefinition, s: BatchState): Promise<Map<string, { content: unknown; derived: unknown }>> {
  const keys = Object.keys(s.stages).sort();
  const { rows } = await db.admin.query<{ key: string; content: unknown; derived: unknown }>(
    'select k.key, recipe.stage_summary_content($1::jsonb, $2::jsonb, k.key) as content, recipe.stage_summary_of($1::jsonb, $2::jsonb, k.key) as derived from unnest($3::text[]) k (key)',
    [JSON.stringify(def.mbr), JSON.stringify(encodeState(s)), keys],
  );
  return new Map(rows.map((r) => [r.key, { content: r.content, derived: r.derived }]));
}

/** Every stage frame of `s` whose database member or derivation differs from the engine's, with both. */
async function disagreements(def: BatchDefinition, s: BatchState, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sql = await sqlMembers(def, s);
  for (const [key, frame] of Object.entries(s.stages)) {
    const engine = { content: stageSummaryMember(def, s, key) ?? null, derived: stageSummaryContent(deriveStageSummary(def, s, frame).summary) };
    const got = sql.get(key);
    if (canonicalJson(got?.content ?? 'missing') !== canonicalJson(engine.content) || canonicalJson(got?.derived ?? 'missing') !== canonicalJson(engine.derived)) out[`${label} ${key}`] = { engine, sql: got };
  }
  return out;
}

const RUNS = [
  ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
  ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
] as const;

function goldenRun(name: (typeof RUNS)[number][0], scenario: (typeof RUNS)[number][1], variants: Record<string, string>): Run {
  const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants });
  expect(autopilot(run, scenario)).toBe('COMPLETE');
  return run;
}

describe('the database derives a stage summary as the engine does (F01; DI-37, IN-15, PR-16)', () => {
  it('[DI-37][IN-15][PR-16] every state of the golden runs of both fixtures: the database\'s summary member of every stage frame is the engine\'s, before and after its sign-off', async () => {
    const seen = { states: 0, frames: 0, signedOff: 0, withDeviations: 0, withYields: 0, withExceptions: 0 };
    for (const [name, scenario, variants] of RUNS) {
      const run = goldenRun(name, scenario, variants);
      const states = [run.log[0]?.result.state, ...run.log.map((e) => e.result.state)].filter((s): s is BatchState => s !== undefined);
      for (const [i, s] of states.entries()) {
        expect(await disagreements(run.def, s, `${name} #${i}`)).toEqual({});
        seen.states += 1;
        for (const key of Object.keys(s.stages)) {
          const m = stageSummaryMember(run.def, s, key);
          seen.frames += 1;
          if (s.stages[key]?.signOff?.valid) seen.signedOff += 1;
          if (m?.statement === 'COMPLETED_WITH_DEVIATIONS') seen.withDeviations += 1;
          if ((m?.yields.length ?? 0) > 0) seen.withYields += 1;
          if ((m?.exceptions.length ?? 0) > 0) seen.withExceptions += 1;
        }
      }
    }
    // SETUP: the runs exercise every member.
    expect(seen.signedOff, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.withYields, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.withExceptions, JSON.stringify(seen)).toBeGreaterThan(0);
  }, 600_000);

  it('[DI-37][IN-15][PR-16] states changed in every fact the summary reads: the database follows each change as the engine does', async () => {
    const run = goldenRun('tablet-granulation-compression', GRANULATION_SCENARIO, {});
    const def = run.def;
    const final = run.state;
    const changes: Record<string, (s: BatchState, key: string) => void> = {};
    const ofFrame = (s: BatchState, key: string) => {
      const frame = s.stages[key];
      if (!frame) throw new Error(`SETUP: no frame ${key}`);
      return deriveStageSummary(def, s, frame);
    };
    const firstException = (s: BatchState, key: string): ExceptionRecord => {
      const e = ofFrame(s, key).exceptions[0];
      if (!e) throw new Error(`SETUP: frame ${key} has no exception`);
      return e;
    };
    // The sign-off is set aside (as before it was made): the member is then derived from the record.
    const unsigned = (s: BatchState): void => {
      for (const f of Object.values(s.stages)) delete f.signOff;
    };
    changes['exception reopened'] = (s, key) => {
      const e = firstException(s, key);
      e.status = 'OPEN';
      delete e.disposition;
    };
    changes['deviation linked'] = (s, key) => void (firstException(s, key).deviation = { ref: 'DEV-2026-0042', linkedBy: 'SUP1', at: 1n });
    changes['dispositioned as a deviation'] = (s, key) => {
      const e = firstException(s, key);
      e.status = 'DISPOSITIONED';
      e.disposition = { by: 'QA1', outcome: 'DEVIATION_RAISED', justification: 'j', signature: 'sig', at: 1n };
    };
    changes['a step skipped'] = (s, key) => {
      const i = ofFrame(s, key).steps[0];
      if (i) i.status = 'SKIPPED';
    };
    const breach = (s: BatchState, key: string, inside: boolean): void => {
      const frame = s.stages[key];
      const i = ofFrame(s, key).steps.at(-1);
      if (!frame || !i) throw new Error('SETUP');
      const other = Object.values(s.stages).find((f) => f.stage !== frame.stage);
      const step = inside ? i.step : (Object.values(s.steps).find((x) => other && def.steps.get(x.step)?.stage === other.stage)?.step ?? i.step);
      const id = `EX-${Object.keys(s.exceptions).length + 100}`;
      s.exceptions[id] = {
        id, type: 'TIME_MAX_BREACH', category: 'TIME_LIMIT', title: 'Window exceeded', controls: ['INV-20'], severity: 'ACTION', source: { step, frames: [...i.frames], constraint: 'TC-X' },
        raisedAt: 1n, raisedSeq: 9_999, raisedBy: 'SYSTEM', deviationRequired: true, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: true, status: 'OPEN',
      };
    };
    changes['a time-limit breach naming a step of the stage by step and frames'] = (s, key) => breach(s, key, true);
    changes['a time-limit breach naming a step of another stage'] = (s, key) => breach(s, key, false);
    changes['a yield withdrawn'] = (s, key) => {
      const keys = new Set(ofFrame(s, key).steps.map((i) => i.key));
      for (const d of Object.values(s.derived)) if (keys.has(d.stepKey) && d.status === 'CURRENT' && def.mbr.yieldCheckpoints.some((y) => y.result === d.calculation)) d.status = 'SUPERSEDED';
    };
    changes['exception ids out of order'] = (s, key) => {
      const e = firstException(s, key);
      const id = 'EX-1000';
      s.exceptions[id] = { ...e, id, raisedSeq: 10_000 };
    };
    let changed = 0;
    for (const key of Object.keys(final.stages).sort()) {
      for (const [what, change] of Object.entries(changes)) {
        const s = structuredClone(final);
        unsigned(s);
        const before = JSON.stringify(stageSummaryMember(def, s, key));
        try {
          change(s, key);
        } catch {
          continue; // a frame without the fact this change needs
        }
        if (JSON.stringify(stageSummaryMember(def, s, key)) !== before) changed += 1;
        expect(await disagreements(def, s, `${key}: ${what}`)).toEqual({});
      }
    }
    expect(changed, 'SETUP: the changes change summaries').toBeGreaterThan(10);
  }, 600_000);

  it('[DI-37][IN-15][PR-16] every sign-off of the golden runs of both fixtures has exactly the engine\'s shape; each member, time or signer of its own is a problem (F01 round 2)', async () => {
    type Obj = { [key: string]: JsonValue };
    const obj = (v: JsonValue | undefined): Obj => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('SETUP: not an object');
      return v;
    };
    const problemOf = async (signOff: JsonValue | null, nowUs: bigint, by: string, signature: string): Promise<string | null> =>
      (await db.admin.query<{ p: string | null }>('select recipe.stage_sign_off_shape_problem($1::jsonb, $2::bigint, $3, $4) as p', [JSON.stringify(signOff), nowUs.toString(), by, signature])).rows[0]?.p ?? null;
    const forgeries: Record<string, (o: Obj, s: Obj, nowUs: bigint) => JsonValue | null> = {
      'no sign-off': () => null,
      'a sign-off member of its own': (o) => ({ ...o, comment: 'reviewed' }),
      'a sign-off member missing': (o) => ({ ...o, valid: undefined as unknown as JsonValue, }),
      'another signer': (o) => ({ ...o, by: 'QA1' }),
      'another signature': (o) => ({ ...o, signature: 'sig-other' }),
      'not valid': (o) => ({ ...o, valid: false }),
      'another time': (o, _s, nowUs) => ({ ...o, at: { $u: (nowUs - 1n).toString() } }),
      'a time not in the codec form': (o, _s, nowUs) => ({ ...o, at: nowUs.toString() }),
      'no summary': (o) => ({ ...o, summary: 'COMPLETED_PER_MBR' }),
      'a summary member of its own': (o, s) => ({ ...o, summary: { ...s, approvedBy: 'QA1' } }),
      'a summary member missing': (o, s) => ({ ...o, summary: { ...s, endedAt: undefined as unknown as JsonValue } }),
      'another end time': (o, s, nowUs) => ({ ...o, summary: { ...s, endedAt: { $u: (nowUs + 1n).toString() } } }),
      'a step count of its own': (o, s) => ({ ...o, summary: { ...s, steps: { ...obj(s['steps']), rejected: 3 } } }),
      'a step count missing': (o, s) => ({ ...o, summary: { ...s, steps: { completed: 1, notApplicable: 0 } } }),
      'step counts not an object': (o, s) => ({ ...o, summary: { ...s, steps: [1, 0, 0] } }),
      'a yield member of its own': (o, s) => ({ ...o, summary: { ...s, yields: [{ calculation: 'y', value: '99.0', unit: '%', verdict: 'within limits' }] } }),
      'a yield member missing': (o, s) => ({ ...o, summary: { ...s, yields: [{ calculation: 'y', value: '99.0' }] } }),
      'a yield not an object': (o, s) => ({ ...o, summary: { ...s, yields: ['99.0 %'] } }),
      'a deviation listed twice': (o, s) => ({ ...o, summary: { ...s, deviations: ['DEV-1', 'DEV-1'] } }),
    };
    // A list of another type is left to the canonical form, which has none for it (so the row is refused as another summary).
    const toCanonical: Record<string, (o: Obj, s: Obj) => JsonValue> = {
      'yields not a list': (o, s) => ({ ...o, summary: { ...s, yields: 'none' } }),
      'deviations not a list': (o, s) => ({ ...o, summary: { ...s, deviations: {} } }),
    };
    const seen = { signOffs: 0, withYields: 0, forged: 0 };
    const problems: Record<string, unknown> = {};
    for (const [name, scenario, variants] of RUNS) {
      const run = goldenRun(name, scenario, variants);
      let before: BatchState | undefined = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants }).state;
      for (const [i, e] of run.log.entries()) {
        const prior = before;
        before = e.result.state;
        if (e.command.type !== 'SIGN_OFF_STAGE' || !e.result.accepted || !prior) continue;
        const key = `${e.command.stage}@${ctxKey(e.command.context ?? [])}`;
        const recorded = e.result.state.stages[key]?.signOff;
        if (!recorded) throw new Error(`SETUP: ${name} #${i} recorded no sign-off of ${key}`);
        // The engine's transaction time: the later of the clock and the last time seen before the command (engine.ts openTx).
        const nowUs = e.nowUs > prior.lastRecordedUs ? e.nowUs : prior.lastRecordedUs;
        const o = obj(encode(recorded));
        const by = e.command.actor.id;
        const signature = e.command.signature.id;
        seen.signOffs += 1;
        if (recorded.summary.yields.length > 0) seen.withYields += 1;
        const honest = await problemOf(o, nowUs, by, signature);
        if (honest !== null) problems[`${name} #${i} ${key}: the engine's own sign-off`] = honest;
        for (const [what, forge] of Object.entries(forgeries)) {
          const forged = JSON.parse(JSON.stringify(forge(o, obj(o['summary']), nowUs))) as JsonValue | null;
          seen.forged += 1;
          if ((await problemOf(forged, nowUs, by, signature)) === null) problems[`${name} #${i} ${key}: ${what}`] = 'no problem found';
        }
        for (const [what, forge] of Object.entries(toCanonical)) {
          const left = await problemOf(forge(o, obj(o['summary'])), nowUs, by, signature);
          if (left !== null) problems[`${name} #${i} ${key}: ${what}`] = left;
          const r = await db.admin.query<{ c: unknown }>('select recipe.canonical_stage_summary($1::jsonb) as c', [JSON.stringify(obj(forge(o, obj(o['summary'])))['summary'])]);
          if (r.rows[0]?.c !== null) problems[`${name} #${i} ${key}: ${what} (canonical)`] = r.rows[0]?.c;
        }
      }
    }
    expect(problems).toEqual({});
    expect(seen.signOffs, JSON.stringify(seen)).toBeGreaterThan(1);
    expect(seen.withYields, JSON.stringify(seen)).toBeGreaterThan(0);
  }, 600_000);

  it('[DI-37] the canonical order: exception ids by length then code point, deviations and yields by code point, in TypeScript as in SQL', async () => {
    const summary = {
      statement: 'COMPLETED_WITH_DEVIATIONS' as const,
      steps: { completed: 3, notApplicable: 1, skipped: 0 },
      exceptions: ['EX-10', 'EX-2', 'EX-1', 'EX-B', 'EX-a'],
      deviations: ['DEV-b', 'DEV-B', 'DEV-é', 'DEV-B', 'DEV-z'],
      yields: [
        { calculation: 'yB', value: '98.5', unit: '%' },
        { calculation: 'yA', value: '99.1', unit: '%' },
        { calculation: 'yA', value: '100.0', unit: '%' },
      ],
    };
    const { rows } = await db.admin.query<{ c: unknown; bad: unknown }>('select recipe.canonical_stage_summary($1::jsonb) as c, recipe.canonical_stage_summary($2::jsonb) as bad', [
      JSON.stringify(summary),
      JSON.stringify({ ...summary, exceptions: 'EX-1' }),
    ]);
    const ts = stageSummaryContent(summary);
    expect(ts.exceptions).toEqual(['EX-1', 'EX-2', 'EX-B', 'EX-a', 'EX-10']);
    expect(ts.deviations).toEqual(['DEV-B', 'DEV-b', 'DEV-z', 'DEV-é']);
    expect(ts.yields.map((y) => `${y.calculation}:${y.value}`)).toEqual(['yA:100.0', 'yA:99.1', 'yB:98.5']);
    expect(rows[0]?.c).toEqual(ts);
    expect(rows[0]?.bad).toBeNull();
    // A recorded summary with any member missing or of another type has no canonical form (so it matches nothing).
    const malformed: Record<string, unknown> = {
      'not an object': [summary],
      'statement not text': { ...summary, statement: 1 },
      'steps not an object': { ...summary, steps: [3, 1, 0] },
      'completed not a number': { ...summary, steps: { ...summary.steps, completed: '3' } },
      'notApplicable missing': { ...summary, steps: { completed: 3, skipped: 0 } },
      'skipped not a number': { ...summary, steps: { ...summary.steps, skipped: null } },
      'exceptions not a list': { ...summary, exceptions: 'EX-1' },
      'an exception not text': { ...summary, exceptions: ['EX-1', 2] },
      'deviations not a list': { ...summary, deviations: {} },
      'a deviation not text': { ...summary, deviations: [null] },
      'yields not a list': { ...summary, yields: 'none' },
      'a yield not an object': { ...summary, yields: ['98.5'] },
      'a yield without its calculation': { ...summary, yields: [{ value: '98.5', unit: '%' }] },
      'a yield value not text': { ...summary, yields: [{ calculation: 'yA', value: 98.5, unit: '%' }] },
      'a yield unit missing': { ...summary, yields: [{ calculation: 'yA', value: '98.5' }] },
    };
    const canonical: Record<string, unknown> = {};
    for (const [what, v] of Object.entries(malformed)) {
      const r = await db.admin.query<{ c: unknown }>('select recipe.canonical_stage_summary($1::jsonb) as c', [JSON.stringify(v)]);
      canonical[what] = r.rows[0]?.c ?? null;
    }
    expect(canonical).toEqual(Object.fromEntries(Object.keys(malformed).map((k) => [k, null])));
    expect(compareCodePoints('\u{1F600}', '�')).toBeGreaterThan(0);
  });
});
