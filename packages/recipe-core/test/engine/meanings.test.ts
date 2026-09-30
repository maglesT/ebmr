/**
 * The check meaning a step asks for (module C3; DI-35, PR-14, PR-20, DI-37; review finding P37): the meaning of a
 * VERIFY comes from the step (re-verification, the MBR's WITNESSED, the block's own check meaning, else VERIFIED),
 * never from what the client asks for. A verifier who asks to sign WITNESSED on a step whose block requires
 * CONTAINER_CHECKED (G-07 dispensing, a second-person check of the released material, quantity and identity) is
 * told the step's own meaning, so a WITNESSED challenge is a meaning mismatch (EBMR-EXE-080 in the server), and
 * the screen, the challenge and the command always name the same meaning.
 *
 * Engine 1.1.0 accepts exactly that meaning too (guards.ts performMeanings, checkMeanings): a verify() signed with a
 * witness, the generic VERIFIED or another block's check where the step requires its own check is refused, as is a
 * PERFORMED signature with the generic PERFORMED on a block with its own perform meaning (recipe-core sql 0296 says
 * the same in the database).
 */
import { describe, expect, it } from 'vitest';
import { GENERIC_BLOCK_VERSIONS } from '../../src/blocks/generic/index.ts';
import { availableActions, checkMeaning, performMeaning } from '../../src/engine/actions.ts';
import { step } from '../../src/engine/engine.ts';
import { MEANINGS, VERIFICATION_MEANINGS } from '../../src/engine/guards.ts';
import type { Actor, Command } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { startFixture } from '../blocks/support.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, param, Run, sig, SUP1, T0, VER1, VER2 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

/**
 * checkMeaning as a caller that passes the meaning a client's VERIFY intent names (the server did so before P37):
 * whatever is passed after the step, the meaning is the step's own.
 */
const asked = checkMeaning as (...args: unknown[]) => string;

/** A G-07 dispensing step (MBR check meaning VERIFIED, block check meaning CONTAINER_CHECKED) for IN + US. */
function dispensingUs(): MbrContent {
  const mbr = mbrWith(
    seq('ops', phase('d', { block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '0.5' } }, records: ['disp'], reads: ['target'], consumes: ['B-API'] }), phase('z')),
    {
      inputs: [{ id: 'target', name: 'Target', source: 'MASTER_DATA', valueType: 'DECIMAL', unit: 'kg' }],
      bom: [{ id: 'B-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '8', unit: 'kg' } }],
      references: [
        { id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) },
        { id: 'MAT-API', kind: 'MATERIAL', code: 'API-0042', version: '3', hash: 'c'.repeat(64) },
      ],
      parameters: [param('disp', { precision: { kind: 'DECIMALS', digits: 3 } })],
    },
  );
  mbr.header.marketSet = ['IN', 'US'];
  return mbr;
}

/** The same step with a check the MBR declares WITNESSED. */
function witnessedStep(): MbrContent {
  return mbrWith(seq('ops', phase('w', { records: ['v'], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }), phase('z')), { parameters: [param('v')] });
}

function performedDispensing(): { def: ReturnType<typeof define>; run: Run } {
  const def = define(dispensingUs());
  const run = Run.issue(def, { inputs: { target: { value: { kind: 'DECIMAL', value: '8.000', unit: 'kg' }, source: 'calc' } }, marketSet: ['IN', 'US'] }, T0);
  run.start('d');
  run.entry('d', {
    kind: 'CONTAINER_WEIGHING',
    item: 'disp',
    bomLine: 'B-API',
    container: 'C1',
    lot: { id: 'AR-1', material: 'API-0042', status: 'RELEASED', identityTested: true },
    gross: '9.000',
    tare: '1.000',
    unit: 'kg',
    balance: 'BAL-1',
    source: 'DEVICE',
  });
  run.perform('d');
  return { def, run };
}

describe('the check meaning of a step (P37)', () => {
  it('[DI-35][PR-20][PR-14][DI-37] on a US dispensing step the required meaning is CONTAINER_CHECKED, whatever meaning the client asks for', () => {
    const { def, run } = performedDispensing();
    expect(run.status('d')).toBe('AWAITING_VERIFICATION');
    const inst = run.state.steps['d@'];
    expect(def.steps.get('d')?.checkMeaning).toBe('VERIFIED');
    // The screen offers VERIFY signed CONTAINER_CHECKED, and no WITNESS action.
    const offered = availableActions(def, run.state, VER1, { nowUs: run.nowUs }, { stepKey: 'd@' }).filter((a) => a.action === 'VERIFY' || a.action === 'WITNESS');
    expect(offered.map((a) => `${a.action}:${a.meaning}:${a.available}`)).toEqual(['VERIFY:CONTAINER_CHECKED:true']);
    // The meaning the server requires for a VERIFY intent is the same, also when the intent asks for WITNESSED.
    expect(checkMeaning(def, inst, 'd')).toBe('CONTAINER_CHECKED');
    expect(asked(def, inst, 'd', 'VERIFIED')).toBe('CONTAINER_CHECKED');
    expect(asked(def, inst, 'd', 'WITNESSED')).toBe('CONTAINER_CHECKED');
  });

  it('[DI-35][PR-14] a step the MBR declares WITNESSED is witnessed, whatever meaning the client asks for; a re-verification is RE_VERIFIED', () => {
    const def = define(witnessedStep());
    const run = Run.issue(def, {}, T0);
    run.start('w');
    const inst = run.state.steps['w@'];
    expect(checkMeaning(def, inst, 'w')).toBe(MEANINGS.WITNESSED);
    expect(asked(def, inst, 'w', 'VERIFIED')).toBe(MEANINGS.WITNESSED);
    const reverifying = inst ? { ...inst, reverification: true } : undefined;
    expect(checkMeaning(def, reverifying, 'w')).toBe(MEANINGS.RE_VERIFIED);
    expect(asked(def, reverifying, 'w', 'WITNESSED')).toBe(MEANINGS.RE_VERIFIED);
  });

  it('[DI-35] a plain step without a block check meaning is VERIFIED, also when the client asks for WITNESSED', () => {
    const def = define(mbrWith(seq('ops', phase('p', { records: ['v'] }), phase('z')), { parameters: [param('v')] }));
    const run = Run.issue(def, {}, T0);
    const inst = run.state.steps['p@'];
    expect(checkMeaning(def, inst, 'p')).toBe(MEANINGS.VERIFIED);
    expect(asked(def, inst, 'p', 'WITNESSED')).toBe(MEANINGS.VERIFIED);
  });
});

/**
 * What the engine answers to a SIGN_PERFORMED or VERIFY of `stepId` by `who` signed `meaning`, at the run's time,
 * without changing the run (the engine is pure): ACCEPTED or the refusal's rule code.
 */
function answer(run: Run, type: 'SIGN_PERFORMED' | 'VERIFY', stepId: string, who: Actor, meaning: string): string {
  const command = { type, commandId: `TRY-${type}-${meaning}`, actor: who, step: stepId, context: [], signature: sig(meaning, who) } as Command;
  const r = step(run.def, run.state, command, { nowUs: run.nowUs });
  return r.accepted ? 'ACCEPTED' : (r.refusal?.code ?? 'DUPLICATE');
}

/** Every meaning a performer or a checker could put on a step signature: the generic ones and every block's own. */
const PERFORM_MEANINGS = [...new Set([MEANINGS.PERFORMED, ...GENERIC_BLOCK_VERSIONS.flatMap((b) => b.handler?.meanings?.perform ?? [])])];
const CHECK_MEANINGS = [...new Set([MEANINGS.VERIFIED, MEANINGS.WITNESSED, MEANINGS.RE_VERIFIED, ...VERIFICATION_MEANINGS, ...GENERIC_BLOCK_VERSIONS.flatMap((b) => b.handler?.meanings?.check ?? [])])];

/** The meanings the engine refuses for their meaning alone, and whether the one the screen offers passes that guard. */
function meaningAnswers(run: Run, type: 'SIGN_PERFORMED' | 'VERIFY', who: Actor, offered: string): { offeredPasses: boolean; refusedOthers: string[]; acceptedOthers: string[] } {
  const all = type === 'SIGN_PERFORMED' ? PERFORM_MEANINGS : CHECK_MEANINGS;
  const others = all.filter((m) => m !== offered);
  return {
    offeredPasses: answer(run, type, 'p', who, offered) !== 'ENG-SIGNATURE-MEANING',
    refusedOthers: others.filter((m) => answer(run, type, 'p', who, m) === 'ENG-SIGNATURE-MEANING'),
    acceptedOthers: others.filter((m) => answer(run, type, 'p', who, m) !== 'ENG-SIGNATURE-MEANING'),
  };
}

describe('the engine accepts exactly the meaning the step asks for (engine 1.1.0)', () => {
  it('[DI-35][PR-14][PR-20][DI-37] the verification of a US dispensing step is signed CONTAINER_CHECKED only: WITNESSED, the generic VERIFIED and another block\'s check are refused', () => {
    const { run } = performedDispensing();
    const inst = run.state.steps['d@'];
    expect(checkMeaning(run.def, inst, 'd')).toBe('CONTAINER_CHECKED');
    const tries = Object.fromEntries(['WITNESSED', 'VERIFIED', 'CHARGE_IN_VERIFIED', MEANINGS.RE_VERIFIED, 'CONTAINER_CHECKED'].map((m) => [m, answer(run, 'VERIFY', 'd', VER1, m)]));
    expect(tries).toEqual({
      WITNESSED: 'ENG-SIGNATURE-MEANING',
      VERIFIED: 'ENG-SIGNATURE-MEANING',
      CHARGE_IN_VERIFIED: 'ENG-SIGNATURE-MEANING',
      [MEANINGS.RE_VERIFIED]: 'ENG-SIGNATURE-MEANING',
      CONTAINER_CHECKED: 'ACCEPTED',
    });
    run.verify('d', [], VER1, 'CONTAINER_CHECKED');
    expect(run.status('d')).toBe('COMPLETED');
    expect(run.state.steps['d@']?.signatures.filter((x) => x.role === 'CHECKED').map((x) => x.meaning)).toEqual(['CONTAINER_CHECKED']);
  });

  it('[DI-35][PR-14] a step the MBR declares WITNESSED is signed WITNESSED only', () => {
    const def = define(witnessedStep());
    const run = Run.issue(def, {}, T0);
    run.start('w');
    run.record('w', 'v', { kind: 'DECIMAL', value: '1.00', unit: 'kg' });
    run.perform('w');
    const tries = Object.fromEntries(['VERIFIED', 'LINE_CLEARANCE_VERIFIED', MEANINGS.RE_VERIFIED, 'WITNESSED'].map((m) => [m, answer(run, 'VERIFY', 'w', VER1, m)]));
    expect(tries).toEqual({ VERIFIED: 'ENG-SIGNATURE-MEANING', LINE_CLEARANCE_VERIFIED: 'ENG-SIGNATURE-MEANING', [MEANINGS.RE_VERIFIED]: 'ENG-SIGNATURE-MEANING', WITNESSED: 'ACCEPTED' });
  });

  it('[DI-24][DI-35][INV-03] a step awaiting re-verification after a correction is signed RE_VERIFIED_AFTER_CORRECTION only, also where its block has its own check', () => {
    const mbr = mbrWith(
      seq('ops', phase('in', { records: ['charged'] }), phase('out', { records: ['good'] }), phase('y', { block: { type: 'G-20', version: '1' }, computes: ['yld'] }), phase('end')),
      {
        parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
        calculations: [{ id: 'yld', name: 'Yield', expression: 'yield(good, charged)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
      },
    );
    const run = Run.issue(define(mbr));
    run.start('in');
    run.record('in', 'charged', { kind: 'DECIMAL', value: '10.00', unit: 'kg' }, { source: { mode: 'MANUAL' } });
    run.perform('in');
    run.verify('in', [], VER1, 'VERIFIED');
    run.start('out');
    run.record('out', 'good', { kind: 'DECIMAL', value: '9.80', unit: 'kg' });
    run.perform('out');
    run.verify('out', [], VER1, 'VERIFIED');
    run.start('y');
    run.perform('y');
    // Before the correction the yield step asks for its block's own check, YIELD_VERIFIED.
    expect(['VERIFIED', 'WITNESSED', 'YIELD_VERIFIED'].map((m) => answer(run, 'VERIFY', 'y', VER1, m))).toEqual(['ENG-SIGNATURE-MEANING', 'ENG-SIGNATURE-MEANING', 'ACCEPTED']);
    run.verify('y', [], VER1, 'YIELD_VERIFIED');
    const corrector: Actor = { id: 'OV1', kind: 'PERSON', roles: ['OPERATOR', 'VERIFIER'] };
    const charged = Object.values(run.state.points).find((x) => x.item === 'charged');
    run.ok({ type: 'CORRECT_ENTRY', actor: corrector, point: charged?.id ?? '', value: { kind: 'DECIMAL', value: '10.20', unit: 'kg' }, reason: 'keying error: 10.20 on the printout', signature: sig('CORRECTED', corrector), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    expect([run.inst('in')?.reverification, run.inst('y')?.reverification]).toEqual([true, true]);
    for (const s of ['in', 'y']) {
      const tries = Object.fromEntries(['VERIFIED', 'WITNESSED', 'YIELD_VERIFIED', MEANINGS.RE_VERIFIED].map((m) => [m, answer(run, 'VERIFY', s, VER2, m)]));
      expect(tries, s).toEqual({ VERIFIED: 'ENG-SIGNATURE-MEANING', WITNESSED: 'ENG-SIGNATURE-MEANING', YIELD_VERIFIED: 'ENG-SIGNATURE-MEANING', [MEANINGS.RE_VERIFIED]: 'ACCEPTED' });
      expect(checkMeaning(run.def, run.inst(s), s)).toBe(MEANINGS.RE_VERIFIED);
    }
    run.verify('y', [], VER2, MEANINGS.RE_VERIFIED);
    expect(run.status('y')).toBe('COMPLETED');
  });

  it('[DI-35][PR-14][PR-20] on every generic block the performer and the checker sign the block\'s own meaning only: the generic PERFORMED, VERIFIED or WITNESSED and every other block\'s meaning are refused', () => {
    const covered: string[] = [];
    for (const b of GENERIC_BLOCK_VERSIONS.filter((x) => x.goldenFixture !== undefined)) {
      const key = `${b.type}@${b.version}`;
      const run = startFixture(b);
      const pm = performMeaning(run.def, 'p');
      expect(pm, key).toBe(b.handler?.meanings?.perform?.[0] ?? MEANINGS.PERFORMED);
      const performed = meaningAnswers(run, 'SIGN_PERFORMED', OP1, pm);
      expect({ offeredPasses: performed.offeredPasses, acceptedOthers: performed.acceptedOthers }, `${key} SIGN_PERFORMED`).toEqual({ offeredPasses: true, acceptedOthers: [] });
      covered.push(`${key} perform ${pm}`);
      if (answer(run, 'SIGN_PERFORMED', 'p', OP1, pm) !== 'ACCEPTED') continue;
      run.perform('p', [], OP1, pm);
      if (run.status('p') !== 'AWAITING_VERIFICATION') continue;
      const cm = checkMeaning(run.def, run.inst('p'), 'p');
      expect(cm, key).toBe(run.def.steps.get('p')?.checkMeaning === 'WITNESSED' ? MEANINGS.WITNESSED : (b.handler?.meanings?.check?.[0] ?? MEANINGS.VERIFIED));
      const checked = meaningAnswers(run, 'VERIFY', VER1, cm);
      expect({ offeredPasses: checked.offeredPasses, acceptedOthers: checked.acceptedOthers }, `${key} VERIFY`).toEqual({ offeredPasses: true, acceptedOthers: [] });
      covered.push(`${key} check ${cm}`);
    }
    // The blocks with their own meanings were all exercised, perform and check.
    expect(covered).toEqual(
      expect.arrayContaining([
        'G-07@1 check CONTAINER_CHECKED',
        'G-08@1 check CHARGE_IN_VERIFIED',
        'G-10@1 perform LINE_CLEARANCE_PERFORMED',
        'G-10@1 check LINE_CLEARANCE_VERIFIED',
        'G-12@1 perform SAMPLE_TAKEN',
        'G-13@1 perform IPC_PERFORMED',
        'G-13@1 check IPC_VERIFIED',
      ]),
    );
    // G-20's fixture completes without a check; its YIELD_VERIFIED is exercised in the re-verification case above.
  });
});
