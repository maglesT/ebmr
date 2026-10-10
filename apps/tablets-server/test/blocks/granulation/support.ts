/**
 * Harness for the granulation blocks (Phase 3 slice 3b) through the engine: the tablets registry and catalogue, a
 * minimal MBR around the block's fixture phase (with the G-09 status step a sifting step needs, and the LOD loop a drying
 * step sits in), and the recipe-core engine driver.
 */
import { engine } from '@ebmr/recipe-core/pure';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { define, OP1, Run, sig, T0, VER1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

export { OP1, OP2, QA1, SUP1, VER1, VER2, Run, T0, MIN, sig } from '../../../../../packages/recipe-core/test/engine/support.ts';
export { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

export const LOOP = 'L-DRY';
/** The frames of iteration n of the drying loop. */
export const iteration = (n: number): flow.Frame[] => [{ construct: LOOP, index: n }];

/** The fixture phase of block `b`, with `extra` laid over it. */
export function fixturePhase(b: blocks.BlockVersion, extra: Partial<flow.PhaseNode> = {}): flow.PhaseNode {
  const f = b.goldenFixture;
  if (!f) throw new Error(`${b.type} has no golden fixture`);
  return phase('p', { ...f.phase, ...extra, config: { ...f.phase.config, ...(extra.config ?? {}) } });
}

/** A minimal MBR around phase `p` of block `b` (fixture parameters), as the block needs to be defined. */
export function blockMbr(b: blocks.BlockVersion, p: flow.PhaseNode = fixturePhase(b), extra: Partial<flow.MbrContent> = {}): flow.MbrContent {
  const f = b.goldenFixture;
  const body: flow.FlowNode =
    b.type === 'TB-05'
      ? { kind: 'loop', id: LOOP, name: 'Dry until the LOD is in range', body: p, maxIterations: 3, exit: { condition: 'lod >= 2.0 [%] && lod <= 3.5 [%]', endpoint: 'lod' } }
      : p;
  const children: flow.FlowNode[] = [body, phase('after')];
  if (b.type === 'TB-02') children.push(phase('chk', { block: { type: 'G-09', version: '1' }, equipment: [{ ref: 'SIFTER', use: 'STATUS_CHECK' }] }));
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children }, { parameters: f?.parameters ?? [], ...extra });
  if (b.type === 'TB-02') {
    const stage = (mbr.procedure.body as flow.SequenceNode).children[0] as flow.StageNode;
    stage.binding.equipment.push({ ref: 'SIFTER', equipmentClass: 'EQC-SIFTER', kind: 'PROCESS' });
    mbr.references.push({ id: 'EQC-SIFTER', kind: 'EQUIPMENT_CLASS', code: 'EQC-SIFTER', version: '1', hash: 'b'.repeat(64) });
  }
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
    const problems = (e as { problems?: { code: string; message: string }[] }).problems;
    if (!problems) throw e;
    return problems.map((p) => p.code);
  }
}

/** A run of block `b` issued and its step p started (in the first loop iteration for TB-05). */
export function startRun(b: blocks.BlockVersion, mbr: flow.MbrContent = blockMbr(b)): { run: Run; frames: flow.Frame[] } {
  const run = Run.issue(defineFor(mbr), {}, T0);
  const frames = b.type === 'TB-05' ? iteration(1) : [];
  if (b.type === 'TB-05') run.ok({ type: 'START_STEP', actor: OP1, step: 'p', context: frames });
  else run.start('p');
  return { run, frames };
}

/** Plays the block's golden fixture script; performs and verifies. */
export function runGolden(b: blocks.BlockVersion): { run: Run; frames: flow.Frame[]; performRefusal?: string } {
  const f = b.goldenFixture;
  if (!f) throw new Error('no fixture');
  const { run, frames } = startRun(b);
  for (const s of f.script) {
    if ('entry' in s) run.entry('p', s.entry, frames);
    else if ('record' in s) run.record('p', s.record, s.value, { frames, source: { mode: 'DEVICE', device: 'DEV-G' } });
    else if ('advanceUs' in s) run.advance(s.advanceUs);
  }
  const r = run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: frames, signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
  if (run.status('p', frames) === 'AWAITING_VERIFICATION') run.verify('p', frames, VER1);
  return { run, frames, ...(r.accepted ? {} : { performRefusal: r.refusal?.code ?? '?' }) };
}
