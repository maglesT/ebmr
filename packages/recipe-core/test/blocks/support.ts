/**
 * Harness for block golden fixtures: wraps a block version's fixture phase in a minimal MBR, runs its
 * script through the engine, and reports the outcome.
 */
import { Dec } from '@ebmr/expr';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { checkMeaning, performMeaning } from '../../src/engine/actions.ts';
import { decimalsOf } from '../../src/flow/decimal.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, Run, sig, T0, VER1 } from '../engine/support.ts';

export function fixtureMbr(b: BlockVersion): MbrContent {
  const f = b.goldenFixture;
  if (!f) throw new Error(`${b.type}@${b.version} has no golden fixture`);
  const p: PhaseNode = phase('p', f.phase);
  return mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, {
    parameters: f.parameters ?? [],
    calculations: f.calculations ?? [],
    intermediates: f.intermediates ?? [],
    bom: f.bom ?? [],
    yieldCheckpoints: f.yieldCheckpoints ?? [],
    timeConstraints: f.timeConstraints ?? [],
    inputs: (f.inputs ?? []).map((i) => ({ id: i.id, name: i.id, source: 'MASTER_DATA' as const, valueType: i.valueType, ...(i.unit ? { unit: i.unit } : {}) })),
  });
}

export interface FixtureOutcome {
  run: Run;
  exceptions: string[];
  status: string | undefined;
  performRefusal?: string;
}

/** A block's golden fixture run up to its PERFORMED signature: issued, started (with start data) and its script played. */
export function startFixture(b: BlockVersion): Run {
  const f = b.goldenFixture;
  if (!f) throw new Error('no fixture');
  const def = define(fixtureMbr(b));
  const inputs = Object.fromEntries(
    (f.inputs ?? []).map((i) => [i.id, { value: i.valueType === 'COUNT' ? { kind: 'COUNT' as const, value: i.value } : { kind: 'DECIMAL' as const, value: i.value, unit: i.unit ?? '1' }, source: 'golden fixture' }]),
  );
  const run = Run.issue(def, { inputs }, T0);
  for (const c of f.containers ?? []) run.state.containers[c.id] = { id: c.id, holds: c.holds, holdsKind: c.holdsKind, producedBy: 'setup@', producedIn: [], status: 'QUARANTINE' };
  const startData = f.script.find((s): s is { startData: Record<string, unknown> } => 'startData' in s)?.startData;
  run.start('p', [], OP1, startData);
  for (const s of f.script) {
    if ('record' in s) {
      const manual = def.analysis.parameters.get(s.record)?.capture === 'MANUAL';
      run.record('p', s.record, s.value, { source: manual ? { mode: 'MANUAL' } : { mode: 'DEVICE', device: 'DEV-G' } });
    } else if ('entry' in s) run.entry('p', s.entry);
    else if ('advanceUs' in s) run.advance(s.advanceUs);
  }
  return run;
}

/** Runs a block's golden fixture: start (with start data), script, PERFORMED, and the check when due. */
export function runFixture(b: BlockVersion): FixtureOutcome {
  const run = startFixture(b);
  const def = run.def;
  let performRefusal: string | undefined;
  // Signed with the meanings the step asks for (the block's own where it has one; engine 1.1.0 accepts no other).
  const r = run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', signature: sig(performMeaning(def, 'p'), OP1) });
  if (!r.accepted) performRefusal = r.refusal?.code;
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p', [], VER1, checkMeaning(def, run.inst('p'), 'p', run.state, run.nowUs));
  return { run, exceptions: run.exceptions().map((e) => e.type).sort(), status: run.status('p'), ...(performRefusal ? { performRefusal } : {}) };
}

/** A computed or recorded value equals the expected text to its written decimals. */
export function sameTo(expected: string, actual: string | undefined): boolean {
  return actual !== undefined && Dec.parse(actual).toFixed(decimalsOf(expected), 'HALF_UP') === expected;
}
