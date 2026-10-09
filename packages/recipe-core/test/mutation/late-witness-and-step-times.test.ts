/**
 * Kill tests of the SQL mutation group late-witness-and-step-times, the pure functions (recipe-core sql/0333, 0334;
 * Phase 2 exit follow-up T12.LATE; DI-30, DI-35, PR-14, DI-27, INV-16, INV-20). Each answer is compared with the engine
 * (engine 1.5.0: guards.ts witnessPossible, actions.ts checkMeaning, steps.ts verify) where the engine has one.
 *
 * - recipe.witness_possible: an unknown time or an unknown window answers that a witness is still possible, also once
 *   the run moved on (0333 header: the check stays the witness, fail closed; recipe.step_check_meanings passes no time
 *   when the transaction has no trusted time).
 * - recipe.late_check_record: the reason it names at the window's last microsecond after a run that moved on is the
 *   run's moving on, as the engine's; a step whose MBR names no check and whose hand entry needs no declared evidence
 *   raises nothing, however late its review; a VERIFY naming a step the content does not hold as a phase raises nothing.
 * - recipe.step_time_problem: a step instance a row brings into the state (the issue's own, or one the token advance
 *   enables) carries no start or end time but its own act's (EBMR-EXE-143, EBMR-EXE-144).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { checkMeaning } from '../../src/engine/actions.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { step } from '../../src/engine/engine.ts';
import { MEANINGS, witnessPossible } from '../../src/engine/guards.ts';
import type { Actor, BatchState, Command } from '../../src/engine/types.ts';
import { pinnedPolicy } from '../../src/execution/run.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { define, done, OP2, param, QA1, Run, sig, T0, VER1 } from '../engine/support.ts';
import { mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const json = (x: unknown): string => JSON.stringify(x);
const enc = (s: BatchState): Json => JSON.parse(json(encodeState(s))) as Json;
const u = (us: bigint): Json => ({ $u: us.toString() });

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const beside = (checked: FlowNode): FlowNode =>
  seq('ops', { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'Checked', body: checked }, { id: 'b2', name: 'Beside', body: phase('z', { records: ['n'] }) }] }, phase('after'));

/** `p` records `t`, typed by hand from a printout its MBR names (a witness is due), beside `z`. */
function printoutStep(): MbrContent {
  const printout = { unit: 'min', capture: 'MANUAL' as const, evidence: 'PRINTOUT' as const, accuracyCheck: 'SECOND_PERSON' as const };
  return mbrWith(beside(phase('p', { records: ['t'] })), { parameters: [param('t', printout), param('n')] });
}

/** `q` names no check, and records `v`, critical, typed by hand, with no evidence declared: its review is due, not a witness. */
function noCheckStep(): MbrContent {
  return mbrWith(beside(phase('q', { records: ['v'], signatures: { perform: { role: 'OPERATOR' } } })), { parameters: [param('v', { capture: 'MANUAL' }), param('n')] });
}

/** The step `stepId` of `content` started, its values typed by hand, signed performed by OP1. */
function performed(content: MbrContent, stepId: string): Run {
  const run = Run.issue(define(content), {}, T0);
  run.start(stepId);
  const node = run.def.steps.get(stepId)?.node;
  for (const item of node?.kind === 'phase' ? node.records : []) {
    const unit = run.def.analysis.parameters.get(item)?.unit ?? 'kg';
    run.record(stepId, item, { kind: 'DECIMAL', value: unit === 'min' ? '15' : '1.00', unit }, { source: { mode: 'MANUAL' } });
  }
  run.perform(stepId);
  return run;
}

async function possibleInDb(policy: unknown, run: Run, stepId: string, now: bigint | null): Promise<boolean | null> {
  const { rows } = await db.admin.query<{ v: boolean | null }>('select recipe.witness_possible($1::jsonb, $2::jsonb, $3::jsonb, $4) as v', [
    json(policy),
    json(encodeState(run.state)),
    json((enc(run.state)['steps'] as Json)[`${stepId}@`]),
    now === null ? null : now.toString(),
  ]);
  return rows[0]?.v ?? null;
}

async function lateRecord(content: unknown, run: Run, command: Command, now: bigint): Promise<Json | null> {
  const { rows } = await db.admin.query<{ v: Json | null }>('select recipe.late_check_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5) as v', [
    json(content),
    json(pinnedPolicy(run.def.policy)),
    json(encodeState(run.state)),
    json(encodeCommand(command)),
    now.toString(),
  ]);
  return rows[0]?.v ?? null;
}

/**
 * What the engine raises (WITNESS_LATE, without id and time) for `who`'s VERIFY of `stepId` signed with the meaning the
 * step asks for now, and what recipe.late_check_record answers for the same command, state and trusted time.
 */
async function both(run: Run, stepId: string, who: Actor = VER1): Promise<{ engine: Json | null; database: Json | null; meaning: string }> {
  const meaning = checkMeaning(run.def, run.inst(stepId), stepId, run.state, run.nowUs);
  const command = { type: 'VERIFY', commandId: 'LATE-1', actor: who, step: stepId, context: [], signature: sig(meaning, who) } as Command;
  const r = step(run.def, run.state, command, { nowUs: run.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the check: ${json(r.refusal)}`);
  const added = Object.values(r.state.exceptions).filter((e) => !(e.id in run.state.exceptions) && e.type === 'WITNESS_LATE');
  const engine = added[0] ? (JSON.parse(json(encodeState({ ...r.state, exceptions: { x: added[0] } }))) as { exceptions: { x: Json } }).exceptions.x : null;
  if (engine) {
    delete engine['raisedAt'];
    delete engine['raisedSeq'];
    delete engine['id'];
  }
  const database = await lateRecord(run.def.mbr, run, command, run.nowUs > run.state.lastRecordedUs ? run.nowUs : run.state.lastRecordedUs);
  return { engine, database, meaning };
}

describe('T12.LATE: a witness stays due while the time or the window is unknown (recipe.witness_possible, sql 0333)', () => {
  it('[DI-35][PR-14] once the run moved on, a witness is no longer possible at a known time and window, and still possible when the time or the window is unknown (fail closed: the check stays the witness)', async () => {
    const run = performed(printoutStep(), 'p').minutes(1);
    run.start('z', [], OP2);
    const policy = pinnedPolicy(run.def.policy) as Json;
    const ended = run.inst('p')?.endedAt ?? 0n;
    // Within the window, the run moved on: the engine and the database agree that no witness is possible.
    expect(run.nowUs - ended).toBeLessThan(run.def.policy.witnessWindowUs);
    expect(witnessPossible(run.def, run.state, run.inst('p'), run.nowUs)).toBe(false);
    expect(await possibleInDb(policy, run, 'p', run.nowUs)).toBe(false);
    const withoutWindow = Object.fromEntries(Object.entries(policy).filter(([k]) => k !== 'witnessWindowUs'));
    expect(Object.keys(policy)).toContain('witnessWindowUs');
    expect({
      timeUnknown: await possibleInDb(policy, run, 'p', null),
      windowUnknown: await possibleInDb(withoutWindow, run, 'p', run.nowUs),
      windowNotMicroseconds: await possibleInDb({ ...policy, witnessWindowUs: 300_000_000 }, run, 'p', run.nowUs),
      bothUnknown: await possibleInDb(withoutWindow, run, 'p', null),
    }).toEqual({ timeUnknown: true, windowUnknown: true, windowNotMicroseconds: true, bothUnknown: true });
  });
});

describe('T12.LATE: the exception a late review raises, and where it raises none (recipe.late_check_record, sql 0333)', () => {
  it('[DI-30][DI-35][PR-14] at the window\'s last microsecond after a run that moved on, the review is late because the run moved on, a microsecond later because the window passed, as the engine says', async () => {
    const run = performed(printoutStep(), 'p');
    const ended = run.inst('p')?.endedAt ?? 0n;
    const window = run.def.policy.witnessWindowUs;
    run.minutes(1);
    run.start('z', [], OP2);
    run.advance(ended + window - run.nowUs);
    expect(run.nowUs - ended).toBe(window);
    const atLast = await both(run, 'p');
    run.advance(1n);
    const after = await both(run, 'p');
    for (const [name, c] of Object.entries({ atLast, after })) {
      expect(c.engine, name).not.toBeNull();
      expect(c.database, name).toEqual(c.engine);
    }
    expect({ atLast: atLast.database?.['title'], after: after.database?.['title'] }).toEqual({
      atLast: 't at p@ was typed by hand with neither the photo or printout the MBR names nor a witness: the run moved on after the act (another step started or recorded data), so VER1 checked the step later (VERIFIED); QA must disposition this exception',
      after: 't at p@ was typed by hand with neither the photo or printout the MBR names nor a witness: the witness window after the act had passed, so VER1 checked the step later (VERIFIED); QA must disposition this exception',
    });
  });

  it('[DI-30][DI-35][PR-14] a step whose MBR names no check, holding a critical value typed by hand with no evidence declared, awaits its review; reviewed after the window or after the run moved on it raises nothing, as in the engine (no witness was due)', async () => {
    const late = performed(noCheckStep(), 'q');
    expect({ status: late.status('q'), verificationRequired: late.inst('q')?.verificationRequired }).toEqual({ status: 'AWAITING_VERIFICATION', verificationRequired: true });
    late.minutes(30);
    const movedOn = performed(noCheckStep(), 'q').minutes(1);
    movedOn.start('z', [], OP2);
    expect({ late: await both(late, 'q'), movedOn: await both(movedOn, 'q') }).toEqual({
      late: { engine: null, database: null, meaning: MEANINGS.VERIFIED },
      movedOn: { engine: null, database: null, meaning: MEANINGS.VERIFIED },
    });
  });

  it('[DI-30][DI-35][PR-14] the late check is read from the step\'s phase in the content it is given: the review that raises WITNESS_LATE there raises nothing where the content holds that step as a hold point or not at all', async () => {
    const run = performed(printoutStep(), 'p').minutes(6);
    const command = { type: 'VERIFY', commandId: 'LATE-1', actor: VER1, step: 'p', context: [], signature: sig(MEANINGS.VERIFIED, VER1) } as Command;
    const own = await lateRecord(run.def.mbr, run, command, run.nowUs);
    expect(own?.['type']).toBe('WITNESS_LATE');
    /** The content with phase p replaced by `node` (the parameters, t's printout included, kept). */
    const replaced = (node: unknown): unknown => {
      const swap = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(swap);
        if (typeof x !== 'object' || x === null) return x;
        const o = x as Json;
        if (o['kind'] === 'phase' && o['id'] === 'p') return node;
        return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, swap(v)]));
      };
      return swap(JSON.parse(json(run.def.mbr)));
    };
    const holdPoint = replaced({ kind: 'holdPoint', id: 'p', name: 'Step p', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] });
    const missing = replaced(phase('p2', { records: ['t'] }));
    expect(json(holdPoint)).toContain('"kind":"holdPoint","id":"p"');
    expect(json(missing)).not.toContain('"id":"p"');
    expect({ holdPoint: await lateRecord(holdPoint, run, command, run.nowUs), missing: await lateRecord(missing, run, command, run.nowUs) }).toEqual({ holdPoint: null, missing: null });
  });
});

describe('T12.LATE round 2: a step instance a row brings in carries no time but its own act\'s (recipe.step_time_problem, sql 0334)', () => {
  async function problem(before: Json, after: Json, kind: string, accepted: boolean, command: JsonValue, nowUs: bigint): Promise<{ code: string; why: string } | null> {
    const { rows } = await db.admin.query<{ p: { code: string; why: string } | null }>('select recipe.step_time_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb, $6::bigint) as p', [
      json(before),
      json(after),
      kind,
      accepted,
      json(command),
      nowUs.toString(),
    ]);
    return rows[0]?.p ?? null;
  }
  const started = (k: string) => ({ code: 'EBMR-EXE-143', why: `records a start time for step ${k}, which only that step's own accepted START_STEP records` });
  const ended = (k: string) => ({ code: 'EBMR-EXE-144', why: `records an end time for step ${k}, which only that step's own accepted PERFORMED signature or hold-point release records` });

  it('[DI-27][INV-16][INV-20][DI-35] the issue\'s state with a step already started or already ended is refused (EBMR-EXE-143, EBMR-EXE-144); as the engine issues it, it passes', async () => {
    const run = Run.issue(define(printoutStep()), {}, T0);
    const issued = enc(run.state);
    const steps = (s: Json): Record<string, Json> => s['steps'] as Record<string, Json>;
    expect(Object.keys(steps(issued)).sort()).toEqual(['p@', 'z@']);
    const forged = (member: string): Json => {
      const s = structuredClone(issued);
      (steps(s)['p@'] as Json)[member] = u(T0);
      return s;
    };
    const issue = { type: 'ISSUE' };
    expect({
      honest: await problem({}, issued, 'ISSUE', true, issue, T0),
      started: await problem({}, forged('startedAt'), 'ISSUE', true, issue, T0),
      ended: await problem({}, forged('endedAt'), 'ISSUE', true, issue, T0),
    }).toEqual({ honest: null, started: started('p@'), ended: ended('p@') });
  });

  it('[DI-27][INV-16][INV-20][DI-35] the hold-point release that enables the next step records it neither started nor ended (EBMR-EXE-143, EBMR-EXE-144); as the engine records it, it passes', async () => {
    const held = Run.issue(define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Cores approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')))));
    done(held, 'a');
    held.minutes(3);
    const before = enc(held.state);
    const r = held.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
    const after = enc(r.state);
    const steps = (s: Json): Record<string, Json> => s['steps'] as Record<string, Json>;
    // The release ends its own hold point and brings in the next step, enabled.
    expect({ before: Object.keys(steps(before)).sort(), after: Object.keys(steps(after)).sort(), b: steps(after)['b@']?.['status'], endedH: steps(after)['H@']?.['endedAt'] }).toEqual({
      before: ['H@', 'a@'],
      after: ['H@', 'a@', 'b@'],
      b: 'ENABLED',
      endedH: u(held.nowUs),
    });
    const command = encodeCommand(held.log.at(-1)?.command as Command);
    const forged = (member: string): Json => {
      const s = structuredClone(after);
      (steps(s)['b@'] as Json)[member] = u(held.nowUs);
      return s;
    };
    expect({
      honest: await problem(before, after, 'COMMAND', true, command, held.nowUs),
      started: await problem(before, forged('startedAt'), 'COMMAND', true, command, held.nowUs),
      ended: await problem(before, forged('endedAt'), 'COMMAND', true, command, held.nowUs),
    }).toEqual({ honest: null, started: started('b@'), ended: ended('b@') });
  });
});
