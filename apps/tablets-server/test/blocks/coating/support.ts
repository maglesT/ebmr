/**
 * Harness for the coating and finishing blocks (Phase 3 slice 3d, builder A) through the engine: the tablets registry
 * and catalogue, minimal MBRs around each block (TB-18 cores then a coating loop on the weight gain; TB-19 with its QC
 * hold point after it; TB-20 with its witnessed G-23 destruction step), and the recipe-core engine driver.
 */
import { engine } from '@ebmr/recipe-core/pure';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { TB18 } from '../../../src/blocks/coating/index.ts';
import { define, OP1, Run, sig, T0, VER1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

export { OP1, OP2, VER1, QA1, SUP1, Run, T0, sig } from '../../../../../packages/recipe-core/test/engine/support.ts';
export { phase } from '../../../../../packages/recipe-core/test/flow/support.ts';

export const LOOP = 'L-COAT';
export const iteration = (n: number): flow.Frame[] => [{ construct: LOOP, index: n }];

/** The coater values every coating iteration collects (inlet, exhaust, bed temperatures, spray rate, pan speed). */
export const COATER_ACTUALS = [
  { tag: 'inlet.temp_C', unit: 'degC', min: '50.0', max: '55.0' },
  { tag: 'exhaust.temp_C', unit: 'degC', min: '30.0', max: '35.0' },
  { tag: 'bed.temp_C', unit: 'degC', min: '38.0', max: '44.0' },
  { tag: 'spray.rate_g_min', unit: 'g/min', min: '80.0', max: '160.0' },
  { tag: 'pan.speed_rpm', unit: 'rpm', min: '1.0', max: '5.0' },
];

/** The coater's PLC and the equipment recipe the MBR binds (G-06 checks it before the step closes). */
export const COATER_SYSTEM: flow.PhaseNode['system'] = { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-COAT', recipeVersion: '1' };
export const RECIPE_CHECK = { kind: 'RECIPE_CHECK', recipe: 'RCP-COAT', recipeVersion: '1' };

export const GAIN_PARAM: flow.MbrContent['parameters'][number] = {
  id: 'gain',
  name: 'Weight gain',
  valueType: 'DECIMAL',
  unit: '%',
  precision: { kind: 'DECIMALS', digits: 4 },
  role: 'PROCESS_ENDPOINT',
  criticality: 'CRITICAL',
  riskClass: 'HIGH',
  capture: 'MANUAL',
  limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '2.5', inclusive: true }, high: { value: '3.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-COAT-01' } }] },
};

export function coatingConfig(extra: Record<string, flow.JsonValue> = {}): Record<string, flow.JsonValue> {
  return {
    part: 'COATING',
    coatingType: 'FC',
    coreItem: 'coreMean',
    gainItem: 'gain',
    sampleSize: '20',
    targetGain: '3.0',
    maxGain: '3.5',
    logInterval: { value: '15', unit: 'min' },
    actuals: COATER_ACTUALS,
    maxAgeSeconds: 600,
    ...extra,
  };
}

/** Cores step `cores` (TB-18 CORES, the fixture), then loop L-COAT (maxIterations) with coating step `p`, then `after`. */
export function coatingMbr(opts: { config?: Record<string, flow.JsonValue>; without?: string[]; maxIterations?: number; exit?: string } = {}): flow.MbrContent {
  const f = TB18.goldenFixture as blocks.BlockGoldenFixture;
  const cores = phase('cores', { ...f.phase, config: f.phase.config });
  const coat = phase('p', { block: { type: 'TB-18', version: '1' }, records: ['gain'], reads: ['coreMean'], config: Object.fromEntries(Object.entries(coatingConfig(opts.config)).filter(([k]) => !(opts.without ?? []).includes(k))), ...(COATER_SYSTEM ? { system: COATER_SYSTEM } : {}) });
  const loop: flow.FlowNode = { kind: 'loop', id: LOOP, name: 'Coat until the weight gain is reached', body: coat, maxIterations: opts.maxIterations ?? 3, exit: { condition: opts.exit ?? 'gain >= 3.0 [%]', endpoint: 'gain' } };
  return mbrWith({ kind: 'sequence', id: 'ops', children: [cores, loop, phase('after')] }, { parameters: [...(f.parameters ?? []), GAIN_PARAM] });
}

/** The fixture phase of block `b`, with `extra` laid over it. */
export function fixturePhase(b: blocks.BlockVersion, extra: Partial<flow.PhaseNode> = {}): flow.PhaseNode {
  const f = b.goldenFixture;
  if (!f) throw new Error(`${b.type} has no golden fixture`);
  return phase('p', { ...f.phase, ...extra, config: { ...f.phase.config, ...(extra.config ?? {}) } });
}

export const QC_GATE: flow.FlowNode = { kind: 'holdPoint', id: 'H-PRINT', name: 'Printed tablets approved by QC', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] };
export const DESTROY: flow.PhaseNode = phase('destroy', {
  block: { type: 'G-23', version: '1' },
  config: {},
  signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'WITNESSED', role: 'VERIFIER' } },
});

/** A minimal MBR around phase `p` of block `b`: a QC gate after TB-19, the destruction step after TB-20. */
export function blockMbr(b: blocks.BlockVersion, p: flow.PhaseNode = fixturePhase(b), after: flow.FlowNode[] = b.type === 'TB-19' ? [QC_GATE] : b.type === 'TB-20' ? [DESTROY] : []): flow.MbrContent {
  return mbrWith({ kind: 'sequence', id: 'ops', children: [p, ...after, phase('after')] }, { parameters: b.goldenFixture?.parameters ?? [] });
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

/** A run of `mbr` issued and its step `step` started. */
export function startRun(mbr: flow.MbrContent, step = 'p', frames: flow.Frame[] = []): Run {
  const run = Run.issue(defineFor(mbr), {}, T0);
  run.ok({ type: 'START_STEP', actor: OP1, step, context: frames });
  return run;
}

/** Plays the block's golden fixture script in its minimal MBR; performs and verifies. */
export function runGolden(b: blocks.BlockVersion): { run: Run; performRefusal?: string } {
  const f = b.goldenFixture;
  if (!f) throw new Error('no fixture');
  const run = startRun(blockMbr(b));
  for (const s of f.script) {
    if ('entry' in s) run.entry('p', s.entry);
    else if ('advanceUs' in s) run.advance(s.advanceUs);
  }
  const r = run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p', [], VER1);
  return { run, ...(r.accepted ? {} : { performRefusal: r.refusal?.code ?? '?' }) };
}
