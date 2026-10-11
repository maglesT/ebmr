/**
 * Harness for the blister blocks (Phase 3 slice 4b, builder A) through the engine: the tablets registry and catalogue,
 * a minimal MBR around the block's fixture phase (the blister machine bound in its stage as LINE), and the recipe-core
 * engine driver.
 */
import { engine } from '@ebmr/recipe-core/pure';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { define, OP1, Run, sig, T0, VER1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

export { OP1, OP2, VER1, Run, T0, MIN, sig } from '../../../../../packages/recipe-core/test/engine/support.ts';
export { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

/** The fixture phase of block `b`, with `extra` laid over it (its config member by member). */
export function fixturePhase(b: blocks.BlockVersion, extra: Partial<flow.PhaseNode> = {}): flow.PhaseNode {
  const f = b.goldenFixture;
  if (!f) throw new Error(`${b.type} has no golden fixture`);
  return phase('p', { ...f.phase, ...extra, config: { ...f.phase.config, ...(extra.config ?? {}) } });
}

/** A minimal MBR around phase `p` (and `others` after it): the blister machine bound in the stage as LINE. */
export function blockMbr(p: flow.PhaseNode, others: flow.FlowNode[] = []): flow.MbrContent {
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [p, ...others, phase('after')] });
  const stage = (mbr.procedure.body as flow.SequenceNode).children[0] as flow.StageNode;
  stage.binding.equipment.push({ ref: 'LINE', equipmentClass: 'EQC-LINE', kind: 'PROCESS' });
  mbr.references.push({ id: 'EQC-LINE', kind: 'EQUIPMENT_CLASS', code: 'EQC-LINE', version: '1', hash: 'b'.repeat(64) });
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
    return problems.map((p) => p.code);
  }
}

/** A run of `mbr` issued and its step p started. */
export function startRun(mbr: flow.MbrContent): Run {
  const run = Run.issue(defineFor(mbr), {}, T0);
  run.start('p');
  return run;
}

/** Plays the block's golden fixture script; performs and verifies. */
export function runGolden(b: blocks.BlockVersion): { run: Run; performRefusal?: string } {
  const f = b.goldenFixture;
  if (!f) throw new Error('no fixture');
  const run = startRun(blockMbr(fixturePhase(b)));
  for (const s of f.script) {
    if ('entry' in s) run.entry('p', s.entry);
    else if ('advanceUs' in s) run.advance(s.advanceUs);
  }
  const r = run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p', [], VER1);
  return { run, ...(r.accepted ? {} : { performRefusal: r.refusal?.code ?? '?' }) };
}
