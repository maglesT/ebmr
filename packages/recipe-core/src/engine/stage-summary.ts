/**
 * The summary of a stage frame (G-02; IN-15, PR-16): derived from the record, never typed. The supervisor's
 * STAGE_SIGNED_OFF signature confirms the stage record AND its summary, so one derivation serves:
 *  - the sign-off, which records it (steps.ts signOffStage);
 *  - the stage's signed content: `summary` is a member of the batch_stage content the signature binds, the summary the
 *    sign-off would record now and, once signed, the one it recorded (stageSummaryMember; Phase 2 exit review F01);
 *  - the database's content provider, which derives the same member from the stored state (recipe-core sql 0319,
 *    recipe.stage_summary_of and recipe.canonical_stage_summary): a summary that changed after the signer's preview
 *    changes the content hash, so the challenge or the signature is refused as changed content.
 *
 * The member leaves out what the sign-off sets (the end time) and what the content already holds (the stage and its
 * start). Its lists are in a canonical order that the database reproduces: exception ids by length, then code point
 * (EX-2 before EX-10); deviations and yields by code point.
 */
import type { Frame } from '../flow/tokens.ts';
import type { BatchDefinition } from './definition.ts';
import type { BatchState, ExceptionRecord, StageFrameState, StageSummary, StepInstance } from './types.ts';

/** What a stage frame's summary is derived from, and the summary (without the end time the sign-off sets). */
export interface StageSummaryDerivation {
  /** The step instances of the stage frame (the stage's steps in frames compatible with the frame's). */
  steps: StepInstance[];
  /** The exceptions of the stage frame: raised at one of its step instances, or naming one of its steps in its frames. */
  exceptions: ExceptionRecord[];
  summary: Omit<StageSummary, 'endedAt'>;
}

const within = (outer: readonly Frame[], inner: readonly Frame[]): boolean => outer.every((x) => inner.some((y) => y.construct === x.construct && y.index === x.index));

/** The summary stage frame `frame` would record if it were signed off in state `s` (G-02: derived, never typed). */
export function deriveStageSummary(def: BatchDefinition, s: BatchState, frame: StageFrameState): StageSummaryDerivation {
  const stageId = frame.stage;
  const steps = Object.values(s.steps).filter((i) => def.steps.get(i.step)?.stage === stageId && within(frame.frames, i.frames));
  const keys = new Set(steps.map((i) => i.key));
  // A time-limit breach names the step its constraint ends at by step and frames, not by instance (engine timing.ts).
  const exceptions = Object.values(s.exceptions).filter(
    (e) => (e.source.stepKey !== undefined && keys.has(e.source.stepKey)) || (e.source.step !== undefined && def.steps.get(e.source.step)?.stage === stageId && within(frame.frames, e.source.frames)),
  );
  const yields = Object.values(s.derived)
    .filter((d) => d.status === 'CURRENT' && keys.has(d.stepKey) && def.mbr.yieldCheckpoints.some((y) => y.result === d.calculation) && d.value.kind === 'DECIMAL')
    .map((d) => ({ calculation: d.calculation, value: d.value.kind === 'DECIMAL' ? d.value.value : '', unit: d.value.kind === 'DECIMAL' ? d.value.unit : '' }));
  const withDeviation = exceptions.some((e) => e.status === 'OPEN' || e.deviation !== undefined || e.disposition?.outcome === 'DEVIATION_RAISED') || steps.some((i) => i.status === 'SKIPPED');
  return {
    steps,
    exceptions,
    summary: {
      stage: stageId,
      startedAt: frame.startedAt,
      steps: { completed: steps.filter((i) => i.status === 'COMPLETED').length, notApplicable: steps.filter((i) => i.status === 'NOT_APPLICABLE').length, skipped: steps.filter((i) => i.status === 'SKIPPED').length },
      exceptions: exceptions.map((e) => e.id),
      deviations: [...new Set(exceptions.flatMap((e) => (e.deviation ? [e.deviation.ref] : [])))],
      statement: withDeviation ? 'COMPLETED_WITH_DEVIATIONS' : 'COMPLETED_PER_MBR',
      yields,
    },
  };
}

/** Code-point order (the database's C collation of UTF-8 text). */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Ids by length in code points, then code point (EX-2 before EX-10), as the database sorts them. */
const compareIds = (a: string, b: string): number => [...a].length - [...b].length || compareCodePoints(a, b);

/** The `summary` member of a batch_stage signed content (plain JSON: an object type, so it is a ContentJson). */
export type StageSummaryContent = {
  statement: StageSummary['statement'];
  steps: { completed: number; notApplicable: number; skipped: number };
  exceptions: string[];
  deviations: string[];
  yields: { calculation: string; value: string; unit: string }[];
};

/** The `summary` member of a stage's signed content: the statement, step counts, exceptions, deviations and yields, in canonical order. */
export function stageSummaryContent(sum: Pick<StageSummary, 'statement' | 'steps' | 'exceptions' | 'deviations' | 'yields'>): StageSummaryContent {
  return {
    statement: sum.statement,
    steps: { completed: sum.steps.completed, notApplicable: sum.steps.notApplicable, skipped: sum.steps.skipped },
    exceptions: [...sum.exceptions].sort(compareIds),
    deviations: [...new Set(sum.deviations)].sort(compareCodePoints),
    yields: sum.yields
      .map((y) => ({ calculation: y.calculation, value: y.value, unit: y.unit }))
      .sort((a, b) => compareCodePoints(a.calculation, b.calculation) || compareCodePoints(a.value, b.value) || compareCodePoints(a.unit, b.unit)),
  };
}

/**
 * The `summary` member of stage frame `key`'s signed content: once validly signed off, the summary the sign-off
 * recorded (it never changes afterwards, so signing does not change the content); otherwise the summary a sign-off
 * would record now. Undefined when the state has no such frame.
 */
export function stageSummaryMember(def: BatchDefinition, s: BatchState, key: string): StageSummaryContent | undefined {
  const frame = s.stages[key];
  if (!frame) return undefined;
  return stageSummaryContent(frame.signOff?.valid === true ? frame.signOff.summary : deriveStageSummary(def, s, frame).summary);
}
