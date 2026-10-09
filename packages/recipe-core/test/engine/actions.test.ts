/**
 * availableActions (module C3; Phase 2 apps plan section 7): every offered action is a dry run of the
 * real command through `engine.step`, so on any reachable state its verdict, including the refusal code,
 * equals what `step` decides when the person actually sends that command with a real signature of the
 * offered meaning.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { availableActions, type AvailableAction } from '../../src/engine/actions.ts';
import { step } from '../../src/engine/engine.ts';
import type { Actor, BatchState, Command } from '../../src/engine/types.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import type { FlowNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { buildFlow, candidateCommands, GENERATED_DATA, shapes } from './model-support.ts';
import { define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, MIN, PEOPLE, QA1, Run, sig } from './support.ts';

const MOVE = fc.record({ pick: fc.nat({ max: 10_000 }), minutes: fc.constantFrom(0, 1, 3, 20), k: fc.nat({ max: 1_000 }) });

/** The command the server sends for an offered action (the same construction as the step screen's). */
function commandFor(def: BatchDefinition, s: BatchState, stepKey: string | undefined, a: AvailableAction, actor: Actor): Command | undefined {
  const inst = stepKey !== undefined ? s.steps[stepKey] : undefined;
  const base = { commandId: 'CHECK', actor };
  const signature = a.meaning !== null ? sig(a.meaning, actor) : undefined;
  switch (a.action) {
    case 'START_STEP':
      return inst ? { ...base, type: 'START_STEP', step: inst.step, context: inst.frames } : undefined;
    case 'SIGN_PERFORMED':
      return inst && signature ? { ...base, type: 'SIGN_PERFORMED', step: inst.step, context: inst.frames, signature } : undefined;
    case 'VERIFY':
    case 'WITNESS':
      return inst && signature ? { ...base, type: 'VERIFY', step: inst.step, context: inst.frames, signature } : undefined;
    case 'DISPOSITION_HOLD_POINT': {
      const hold = inst ? def.steps.get(inst.step)?.node : undefined;
      if (!inst || !signature || hold?.kind !== 'holdPoint' || a.target === null) return undefined;
      return { ...base, type: 'DISPOSITION_HOLD_POINT', step: inst.step, context: inst.frames, disposition: a.target, signature };
    }
    case 'RAISE_EXCEPTION':
      return { ...base, type: 'RAISE_EXCEPTION', ...(inst ? { step: inst.step, context: inst.frames } : {}), description: 'observed', severity: 'ALERT' };
    case 'ATTACH_DEVIATION':
      return a.target ? { ...base, type: 'ATTACH_DEVIATION', exception: a.target, deviationRef: 'DEV-1' } : undefined;
    case 'DISPOSITION_EXCEPTION': {
      const e = a.target ? s.exceptions[a.target] : undefined;
      return e && signature ? { ...base, type: 'DISPOSITION_EXCEPTION', exception: e.id, outcome: e.deviationRequired || e.deviation ? 'DEVIATION_RAISED' : 'NO_IMPACT', justification: 'reviewed', signature } : undefined;
    }
    case 'HOLD_BATCH':
      return { ...base, type: 'HOLD_BATCH', holdType: actor.roles.includes('QA') ? 'QA' : 'SUPERVISOR', reason: 'hold' };
    case 'RELEASE_HOLD':
      return a.target ? { ...base, type: 'RELEASE_HOLD', hold: a.target, reason: 'release' } : undefined;
    case 'SIGN_OFF_STAGE': {
      const f = a.target ? s.stages[a.target] : undefined;
      return f && signature ? { ...base, type: 'SIGN_OFF_STAGE', stage: f.stage, context: f.frames, signature } : undefined;
    }
    default:
      return undefined;
  }
}

function agree(def: BatchDefinition, s: BatchState, nowUs: bigint): number {
  let checked = 0;
  for (const actor of PEOPLE) {
    for (const scope of [undefined, ...Object.keys(s.steps)]) {
      for (const a of availableActions(def, s, actor, { nowUs }, scope === undefined ? {} : { stepKey: scope })) {
        if (a.action === 'RECORD_DATA' || a.action === 'RECORD_ENTRY') {
          const inst = scope !== undefined ? s.steps[scope] : undefined;
          expect(a.available, `${a.action} ${scope ?? ''}`).toBe(inst?.status === 'IN_PROGRESS' && (s.status === 'IN_PROGRESS' || s.status === 'ON_HOLD'));
          continue;
        }
        const cmd = commandFor(def, s, scope, a, actor);
        if (!cmd) continue;
        const r = step(def, s, cmd, { nowUs });
        expect(r.accepted, `${actor.id} ${a.action} ${scope ?? 'run'} ${a.target ?? ''}: ${a.refusal?.code ?? 'offered'} vs ${r.refusal?.code ?? 'accepted'}`).toBe(a.available);
        if (!a.available) expect(r.refusal?.code).toBe(a.refusal?.code);
        checked += 1;
      }
    }
  }
  return checked;
}

describe('availableActions agrees with step()', { timeout: 240_000 }, () => {
  it('[DI-34] on random states of generated flows, every offered action is accepted by step and every withheld one refused with the same reason', () => {
    fc.assert(
      fc.property(shapes.node, fc.array(MOVE, { minLength: 5, maxLength: 60 }), (shape, moves) => {
        const def = define(buildFlow(shape));
        const run = Run.issue(def, {}, undefined, { checkInvariants: false });
        for (const m of moves) {
          run.minutes(m.minutes);
          const c = candidateCommands(def, run, m.k, m.k % 2 === 0, GENERATED_DATA);
          const input = c.progress[m.pick % Math.max(1, c.progress.length)] ?? c.all[m.pick % Math.max(1, c.all.length)];
          if (input) run.exec(input);
        }
        agree(def, run.state, run.nowUs);
      }),
      { numRuns: 25 },
    );
  });

  it('[DI-34][INV-03] on the granulation fixture, including the involvement rule (a performer is never offered VERIFY)', () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    let total = 0;
    fc.assert(
      fc.property(fc.array(MOVE, { minLength: 10, maxLength: 120 }), (moves) => {
        const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] }, undefined, { checkInvariants: false });
        for (const m of moves) {
          run.minutes(m.minutes);
          const c = candidateCommands(def, run, m.k, true, { endpoint: (_i, exit) => ({ kind: 'DECIMAL', value: exit ? '3.00' : '5.00', unit: '%' }), derived: 'granYield', scenario: GRANULATION_SCENARIO });
          const input = c.progress[m.pick % Math.max(1, c.progress.length)];
          if (input) run.exec(input);
        }
        total += agree(def, run.state, run.nowUs + MIN);
        for (const inst of Object.values(run.state.steps).filter((i) => i.status === 'AWAITING_VERIFICATION')) {
          for (const p of inst.performers) {
            const person = PEOPLE.find((x) => x.id === p);
            if (!person) continue;
            const v = availableActions(def, run.state, person, { nowUs: run.nowUs }, { stepKey: inst.key }).find((a) => a.action === 'VERIFY' || a.action === 'WITNESS');
            expect(v?.available).toBe(false);
          }
        }
      }),
      { numRuns: 6 },
    );
    expect(total).toBeGreaterThan(0);
  });
});

describe('hold-point decisions', () => {
  const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
  const def = define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Blend released for discharge', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b'))));

  it('[PR-45][DI-35] each decision is its own action with its own meaning: release HOLD_POINT_RELEASED, reject HOLD_POINT_NOT_RELEASED', () => {
    const run = Run.issue(def);
    done(run, 'a');
    const offered = availableActions(def, run.state, QA1, { nowUs: run.nowUs }, { stepKey: 'H@' }).filter((a) => a.action === 'DISPOSITION_HOLD_POINT');
    expect(offered.map((a) => [a.target, a.meaning, a.available, a.signed])).toEqual([
      ['APPROVED', 'HOLD_POINT_RELEASED', true, true],
      ['NOT_APPROVED', 'HOLD_POINT_NOT_RELEASED', true, true],
    ]);
  });

  it('[PR-45][DI-35] the reject path: NOT_APPROVED is signed HOLD_POINT_NOT_RELEASED; the release meaning on a rejection is refused', () => {
    const run = Run.issue(def);
    done(run, 'a');
    run.refused({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'NOT_APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) }, 'ENG-SIGNATURE-MEANING');
    run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'NOT_APPROVED', signature: sig('HOLD_POINT_NOT_RELEASED', QA1) });
    expect(run.status('b')).toBeUndefined();
    expect(run.exceptions().map((e) => e.type)).toContain('HOLD_POINT_NOT_APPROVED');
  });
});
