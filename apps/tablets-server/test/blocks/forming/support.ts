/**
 * Harness for the forming blocks (Phase 3 slice 3d, builder B) through the engine: the tablets registry and catalogue,
 * a minimal MBR around the block's fixture phase (the compactor or the press bound in its stage; for TB-16 the TB-10
 * set-up step before it), and the recipe-core engine driver.
 */
import { engine } from '@ebmr/recipe-core/pure';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { TB10 } from '../../../src/blocks/tb-10.ts';
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

/** A minimal MBR around phase `p` of block `b`: its unit bound in the stage, TB-10's set-up first for TB-16. */
export function blockMbr(b: blocks.BlockVersion, p: flow.PhaseNode = fixturePhase(b), others: flow.FlowNode[] = []): flow.MbrContent {
  const setup = b.type === 'TB-16' ? [phase('setup', { ...(TB10.goldenFixture?.phase ?? {}), block: { type: 'TB-10', version: '1' }, config: TB10.goldenFixture?.phase.config ?? {} })] : [];
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [p, ...setup, ...others, phase('after')] }, { parameters: b.goldenFixture?.parameters ?? [] });
  const stage = (mbr.procedure.body as flow.SequenceNode).children[0] as flow.StageNode;
  const ref = b.type === 'TB-06' ? 'COMPACTOR' : 'PRESS';
  stage.binding.equipment.push({ ref, equipmentClass: `EQC-${ref}`, kind: 'PROCESS' });
  mbr.references.push({ id: `EQC-${ref}`, kind: 'EQUIPMENT_CLASS', code: `EQC-${ref}`, version: '1', hash: 'b'.repeat(64) });
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
