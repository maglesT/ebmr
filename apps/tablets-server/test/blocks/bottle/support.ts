/**
 * Harness for the packaging-line blocks (Phase 3 slice 4b, builder B) through the engine: the tablets registry and
 * catalogue, a minimal MBR around the block's fixture phase `p` with the G-21 steps it names (`lbl` issues and reconciles
 * the roll labels of TB-23, `prt` the cartons of TB-24), and the recipe-core engine driver.
 */
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { engine } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { define, OP1, Run, sig, T0, VER1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

export { OP1, OP2, VER1, Run, T0, MIN, sig } from '../../../../../packages/recipe-core/test/engine/support.ts';
export { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

type Json = Record<string, unknown>;

const item = (id: string, material: string): Json => ({
  id, material, artwork: { IN: 'ART-1', US: 'ART-1', EU: 'ART-1' }, unit: '1', issue: { need: '10000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' },
});

/** The G-21 steps the fixtures name: lbl (roll labels, unit LBL-LINE-1) and prt (cartons, unit PRT-LINE-1). */
export function g21Phases(): flow.PhaseNode[] {
  return [
    phase('lbl', { block: { type: 'G-21', version: '1' }, config: { items: [item('ROLL-LABEL', 'MAT-LBL')] } as never }),
    phase('prt', { block: { type: 'G-21', version: '1' }, config: { items: [item('CARTON', 'MAT-CTN')] } as never }),
  ];
}

/** The fixture phase of block `b`, with `extra` laid over it (its config member by member). */
export function fixturePhase(b: blocks.BlockVersion, extra: Partial<flow.PhaseNode> = {}): flow.PhaseNode {
  const f = b.goldenFixture;
  if (!f) throw new Error(`${b.type} has no golden fixture`);
  return phase('p', { ...f.phase, ...extra, config: { ...f.phase.config, ...(extra.config ?? {}) } });
}

/** A minimal MBR: phase `p`, the G-21 steps, `others`, then `after`; header members laid over the default. */
export function blockMbr(b: blocks.BlockVersion, p: flow.PhaseNode = fixturePhase(b), others: flow.FlowNode[] = [], header: Partial<flow.MbrContent['header']> = {}): flow.MbrContent {
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [p, ...g21Phases(), ...others, phase('after')] });
  Object.assign(mbr.header, header);
  return mbr;
}

export function defineFor(mbr: flow.MbrContent): engine.BatchDefinition {
  return define(mbr, { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog });
}

/** Problems defining `mbr` with the tablets registry (codes), or [] when it defines. */
export function definitionCodes(mbr: flow.MbrContent): string[] {
  try {
    defineFor(mbr);
    return [];
  } catch (e) {
    const problems = (e as { problems?: { code: string }[] }).problems;
    if (!problems) throw e;
    return problems.map((x) => x.code);
  }
}

/** A run of block `b` issued and its step p started. */
export function startRun(b: blocks.BlockVersion, mbr: flow.MbrContent = blockMbr(b)): Run {
  const run = Run.issue(defineFor(mbr), {}, T0);
  run.start('p');
  return run;
}

/** Plays the block's golden fixture script; performs and verifies. */
export function runGolden(b: blocks.BlockVersion): { run: Run; performRefusal?: string } {
  const f = b.goldenFixture;
  if (!f) throw new Error('no fixture');
  const run = startRun(b);
  for (const s of f.script) {
    if ('entry' in s) run.entry('p', s.entry);
    else if ('advanceUs' in s) run.advance(s.advanceUs);
  }
  const r = run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p', [], VER1);
  return { run, ...(r.accepted ? {} : { performRefusal: r.refusal?.code ?? '?' }) };
}
