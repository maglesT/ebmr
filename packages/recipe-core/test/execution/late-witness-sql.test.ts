/**
 * The database's reading of a late check (recipe-core sql/0333: recipe.witness_possible, recipe.late_check_record; Phase 2
 * exit follow-up T12.LATE; DI-30, DI-35, PR-14; engine 1.5.0).
 *
 * Once a witness is no longer possible (the witness window after the act has passed, or the run moved on), a step whose
 * check is a witness is checked by its later review, which raises WITNESS_LATE for QA. The database holds the same rule
 * (the step's check meanings, and the exception an accepted review must add): were it stricter than the engine, an honest
 * late review would be refused and the run stuck again; were it weaker, a review without its exception would pass. So the
 * database's answer is compared with the engine's on the engine's own runs, at and around the window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { checkMeaning } from '../../src/engine/actions.ts';
import { encodeCommand, encodeState } from '../../src/engine/codec.ts';
import { step } from '../../src/engine/engine.ts';
import { MEANINGS, witnessPossible } from '../../src/engine/guards.ts';
import type { Actor, Command } from '../../src/engine/types.ts';
import { pinnedPolicy } from '../../src/execution/run.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { define, OP2, param, Run, sig, T0, VER1 } from '../engine/support.ts';
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

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const beside = (checked: FlowNode): FlowNode =>
  seq('ops', { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'Checked', body: checked }, { id: 'b2', name: 'Beside', body: phase('z', { records: ['n'] }) }] }, phase('after'));

/** `p` records `t` and `s` (both typed by hand from a printout its MBR names when `both`), beside `z`. */
function printoutStep(both = false): MbrContent {
  const printout = { unit: 'min', capture: 'MANUAL' as const, evidence: 'PRINTOUT' as const, accuracyCheck: 'SECOND_PERSON' as const };
  return mbrWith(beside(phase('p', { records: ['t', 's'] })), {
    parameters: [param('t', printout), param('s', both ? printout : {}), param('n')],
  });
}

function witnessedStep(): MbrContent {
  return mbrWith(beside(phase('w', { records: ['v'], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } })), {
    parameters: [param('v'), param('n')],
  });
}

function plainStep(): MbrContent {
  return mbrWith(beside(phase('q', { records: ['v'] })), { parameters: [param('v'), param('n')] });
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

/**
 * What the engine raises (WITNESS_LATE, without id and time) for `who`'s VERIFY of `stepId` signed with the meaning the
 * step asks for now, and what the database's recipe.late_check_record answers for the same command, state and time.
 */
async function both(run: Run, stepId: string, who: Actor = VER1): Promise<{ engine: Json | null; database: Json | null; meaning: string }> {
  const meaning = checkMeaning(run.def, run.inst(stepId), stepId, run.state, run.nowUs);
  const command = { type: 'VERIFY', commandId: 'LATE-1', actor: who, step: stepId, context: [], signature: sig(meaning, who) } as Command;
  const r = step(run.def, run.state, command, { nowUs: run.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the check: ${JSON.stringify(r.refusal)}`);
  const added = Object.values(r.state.exceptions).filter((e) => !(e.id in run.state.exceptions) && e.type === 'WITNESS_LATE');
  const engine = added[0] ? (JSON.parse(json(encodeState({ ...r.state, exceptions: { x: added[0] } }))) as { exceptions: { x: Json } }).exceptions.x : null;
  if (engine) {
    delete engine['raisedAt'];
    delete engine['raisedSeq'];
    delete engine['id'];
  }
  const { rows } = await db.admin.query<{ v: Json | null }>('select recipe.late_check_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5) as v', [
    json(run.def.mbr),
    json(pinnedPolicy(run.def.policy)),
    json(encodeState(run.state)),
    json(encodeCommand(command)),
    (run.nowUs > run.state.lastRecordedUs ? run.nowUs : run.state.lastRecordedUs).toString(),
  ]);
  return { engine, database: rows[0]?.v ?? null, meaning };
}

async function possibleInDb(run: Run, stepId: string, now: bigint | null): Promise<boolean | null> {
  const { rows } = await db.admin.query<{ v: boolean | null }>('select recipe.witness_possible($1::jsonb, $2::jsonb, $3::jsonb, $4) as v', [
    json(pinnedPolicy(run.def.policy)),
    json(encodeState(run.state)),
    json((encodeState(run.state) as { steps: Record<string, unknown> }).steps[`${stepId}@`]),
    now === null ? null : now.toString(),
  ]);
  return rows[0]?.v ?? null;
}

describe('T12.LATE: the database reads a late check as the engine does (DI-30, DI-35, PR-14; sql 0333)', () => {
  it('[DI-35][PR-14] whether a witness is still possible: the database agrees with the engine at the window\'s last microsecond and after it, once the run moved on, before the act ended, and without a time (fail closed: still due)', async () => {
    const run = performed(printoutStep(), 'p');
    const ended = run.inst('p')?.endedAt ?? 0n;
    const window = run.def.policy.witnessWindowUs;
    for (const now of [ended, ended + window - 1n, ended + window, ended + window + 1n, ended + 10n * window]) {
      expect(await possibleInDb(run, 'p', now), `at +${now - ended} us`).toBe(witnessPossible(run.def, run.state, run.inst('p'), now));
    }
    expect(await possibleInDb(run, 'p', ended + window)).toBe(true);
    expect(await possibleInDb(run, 'p', ended + window + 1n)).toBe(false);
    expect(await possibleInDb(run, 'p', null)).toBe(true);
    run.minutes(1);
    run.start('z', [], OP2);
    expect(witnessPossible(run.def, run.state, run.inst('p'), run.nowUs)).toBe(false);
    expect(await possibleInDb(run, 'p', run.nowUs)).toBe(false);
    // A step not ended yet can be witnessed.
    const started = Run.issue(define(printoutStep()), {}, T0);
    started.start('p');
    expect(await possibleInDb(started, 'p', T0 + 100n * window)).toBe(true);
  });

  it('[DI-30][DI-35][PR-14] the exception a late review raises is the engine\'s, member for member: a value typed by hand without its printout after the window and after the run moved on, two such values, the MBR\'s witness; none within the window, on a plain step or on a re-verification', async () => {
    const window = performed(printoutStep(), 'p').minutes(6);
    const movedOn = performed(printoutStep(), 'p').minutes(1);
    movedOn.start('z', [], OP2);
    const two = performed(printoutStep(true), 'p').minutes(6);
    const mbrWindow = performed(witnessedStep(), 'w').minutes(6);
    const mbrMoved = performed(witnessedStep(), 'w');
    mbrMoved.start('z', [], OP2);
    const cases = { window: await both(window, 'p'), movedOn: await both(movedOn, 'p'), two: await both(two, 'p'), mbrWindow: await both(mbrWindow, 'w'), mbrMoved: await both(mbrMoved, 'w') };
    for (const [name, c] of Object.entries(cases)) {
      expect(c.engine, name).not.toBeNull();
      expect(c.database, name).toEqual(c.engine);
    }
    expect(Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, (c.database as Json)['title']]))).toEqual({
      window: 't at p@ was typed by hand with neither the photo or printout the MBR names nor a witness: the witness window after the act had passed, so VER1 checked the step later (VERIFIED); QA must disposition this exception',
      movedOn: 't at p@ was typed by hand with neither the photo or printout the MBR names nor a witness: the run moved on after the act (another step started or recorded data), so VER1 checked the step later (VERIFIED); QA must disposition this exception',
      two: 's, t at p@ were typed by hand with neither the photo or printout the MBR names nor a witness: the witness window after the act had passed, so VER1 checked the step later (VERIFIED); QA must disposition this exception',
      mbrWindow: 'The witness the MBR requires at w@ was not given: the witness window after the act had passed, so VER1 checked the step later (VERIFIED); QA must disposition this exception',
      mbrMoved: 'The witness the MBR requires at w@ was not given: the run moved on after the act (another step started or recorded data), so VER1 checked the step later (VERIFIED); QA must disposition this exception',
    });
    // None where the engine raises none.
    const within = performed(printoutStep(), 'p').minutes(4);
    const plain = performed(plainStep(), 'q').minutes(30);
    expect({ within: await both(within, 'p'), plain: await both(plain, 'q') }).toEqual({
      within: { engine: null, database: null, meaning: MEANINGS.WITNESSED },
      plain: { engine: null, database: null, meaning: MEANINGS.VERIFIED },
    });
    const reverifying = performed(printoutStep(), 'p').minutes(6);
    const encoded = encodeState(reverifying.state) as { steps: Record<string, Json> };
    const prior = { ...encoded, steps: { ...encoded.steps, 'p@': { ...encoded.steps['p@'], reverification: true } } };
    const command = encodeCommand({ type: 'VERIFY', commandId: 'R', actor: VER1, step: 'p', context: [], signature: sig(MEANINGS.RE_VERIFIED, VER1) });
    const { rows } = await db.admin.query<{ v: Json | null }>('select recipe.late_check_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5) as v', [
      json(reverifying.def.mbr),
      json(pinnedPolicy(reverifying.def.policy)),
      json(prior),
      json(command),
      reverifying.nowUs.toString(),
    ]);
    expect(rows[0]?.v ?? null).toBeNull();
  });
});
